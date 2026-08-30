/**
 * Wiki-local source discovery: find a citation for a {{citation needed}} claim
 * among sources Wikimedia already holds, before spending anything on a web
 * search.
 *
 * Two passes, both free:
 *
 *   1. **The article's own references.** A tagged sentence often sits beside
 *      sourced text, and the neighbouring citation frequently covers it too.
 *      Scored on proximity plus token overlap with the reference's own title,
 *      publisher and `quote=`.
 *   2. **Other language editions.** Other Wikipedias are often stricter about
 *      inline citation, and their references are exactly the sources a web
 *      search will not surface. The corresponding sentence is located without a
 *      translation model, using anchors that survive translation: numbers and
 *      dates, proper nouns, and wikilink targets mapped through interlanguage
 *      links.
 *
 * Nothing here judges substantiation. A hit means "a human editor cited this
 * source for a sentence that looks like your claim" - a lead, to be verified.
 */

import { articleUrl, fetchArticle } from "./fetchArticle.js";
import { extractClaims } from "./extractClaims.js";
import { fetchArticleLangLinks, fetchLangLinks, fetchWikitext } from "./mediawiki.js";
import { isUnreliableSource } from "../policy/unreliable_sources.js";
import {
  anchorCount,
  anchorScore,
  anchorsOf,
  coverage,
  isLatinScript,
  tokenSet,
  weightedTokens,
} from "./relevance.js";
import type { Anchors } from "./relevance.js";
import {
  extractWikilinks,
  paragraphRanges,
  sectionRanges,
  splitSentences,
  stripWikitext,
} from "./wikitext.js";
import type { SectionRange } from "./wikitext.js";
import { parseRefs, refText, refToSource, resolveRefs } from "./wikitextRefs.js";
import type { RefSource, ResolvedRef } from "./wikitextRefs.js";
import type { Article, Claim, WikiCandidate } from "./types.js";

/**
 * Language editions consulted for sister-wiki citations, in preference order:
 * the largest wikis, which is where inline citation is most consistently
 * enforced. The article's own language is skipped.
 */
export const DEFAULT_SISTER_LANGS: readonly string[] = [
  "en", "de", "fr", "es", "it", "ru", "ja", "nl", "pl", "pt",
  "sv", "cs", "uk", "ca", "fi", "no", "da", "he", "hu", "tr",
  "ko", "zh", "ar", "id", "fa", "vi",
];

export interface WikiSourceOptions {
  /** Sister language editions to consult (default 4; 0 disables the pass). */
  maxSisterWikis?: number;
  /** Override the language preference order. */
  sisterLangs?: readonly string[];
  /** Candidates returned per claim (default 5). */
  maxCandidates?: number;
  /** Minimum same-article score to return a candidate (default 0.3). */
  minScore?: number;
  /** Minimum sister-wiki anchor score to accept a sentence match (default 0.5). */
  minAnchorScore?: number;
  /** Concurrent sister-wiki fetches (default 3). */
  concurrency?: number;
}

/** A reference located in an article, with the text it is attached to. */
export interface IndexedRef {
  occurrence: ResolvedRef;
  source: RefSource;
  /** The sentence in the host article that this reference supports. */
  sentence: string;
  /** The paragraph the reference sits in, as plain text. */
  paragraph: string;
  section: string | null;
}

/** An article parsed once and reused across every claim on the page. */
export interface IndexedArticle {
  lang: string;
  title: string;
  url: string;
  wikitext: string;
  refs: IndexedRef[];
  sections: SectionRange[];
  /** Whether the wiki writes in Latin script - gates proper-noun anchors. */
  latin: boolean;
}

/** Everything the wiki-local passes need, fetched once per article run. */
export interface WikiCorpus {
  article: Article;
  local: IndexedArticle;
  sisters: IndexedArticle[];
  /** Wikilink target in the article's language to { lang: title on that wiki }. */
  linkTranslations: Map<string, Map<string, string>>;
  /** Non-fatal problems: a sister wiki that could not be fetched, etc. */
  warnings: string[];
}

/**
 * Marker standing in for a stripped `<ref>` while its sentence is located.
 * U+0001 never occurs in wikitext and survives `stripWikitext` untouched.
 */
const MARK = String.fromCharCode(1);

/** Runs `fn` over `items` with bounded concurrency, preserving order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The heading covering `pos`, or null when the position is in the lead. */
function sectionAt(sections: SectionRange[], pos: number): string | null {
  let found: string | null = null;
  for (const s of sections) {
    if (pos >= s.start && pos < s.end) found = s.heading;
  }
  return found;
}

/** The sentence a reference supports: the text back to the previous boundary. */
function hostSentence(before: string): string {
  const parts = splitSentences(before);
  if (parts.length === 0) return before.trim();
  const last = parts[parts.length - 1];
  // A trailing fragment ("In 1889") is not enough to score on; take the
  // preceding sentence with it.
  if (last.length < 25 && parts.length > 1) {
    return `${parts[parts.length - 2]} ${last}`.trim();
  }
  return last;
}

/** The blank-line-delimited paragraph range containing `offset`. */
function paragraphRangeAt(
  wikitext: string,
  offset: number,
): { start: number; end: number } {
  const before = wikitext.lastIndexOf("\n\n", offset);
  const after = wikitext.indexOf("\n\n", offset);
  return {
    start: before === -1 ? 0 : before + 2,
    end: after === -1 ? wikitext.length : after,
  };
}

/**
 * Parses one article's references and the prose each supports. Marker
 * substitution is what survives `stripWikitext`: every ref in a paragraph is
 * replaced by a control character, the paragraph is stripped once, and the
 * markers are then read back in order to place each reference in the text.
 */
export function indexWikiArticle(
  lang: string,
  title: string,
  wikitext: string,
): IndexedArticle {
  const sections = sectionRanges(wikitext);
  const resolved = resolveRefs(parseRefs(wikitext)).filter(
    (r) => !r.definitionOnly,
  );
  const paragraphs = paragraphRanges(wikitext);
  const byParagraph = new Map<number, ResolvedRef[]>();
  let cursor = 0;
  for (const ref of resolved) {
    // Refs come out in document order, so the paragraph scan never rewinds.
    while (cursor < paragraphs.length && paragraphs[cursor].end <= ref.offset) {
      cursor++;
    }
    if (cursor >= paragraphs.length) break;
    if (ref.offset < paragraphs[cursor].start) continue;
    const list = byParagraph.get(cursor);
    if (list) list.push(ref);
    else byParagraph.set(cursor, [ref]);
  }

  const refs: IndexedRef[] = [];
  for (const [index, group] of byParagraph) {
    const { start, end } = paragraphs[index];
    let marked = "";
    let at = start;
    for (const ref of group) {
      marked += wikitext.slice(at, ref.offset) + MARK;
      at = ref.end;
    }
    marked += wikitext.slice(at, end);

    const plain = stripWikitext(marked);
    const paragraph = plain.split(MARK).join("").replace(/\s+/g, " ").trim();
    let searchFrom = 0;
    for (const ref of group) {
      const markPos = plain.indexOf(MARK, searchFrom);
      if (markPos !== -1) searchFrom = markPos + 1;
      const before =
        markPos === -1
          ? paragraph
          : plain.slice(0, markPos).split(MARK).join("").trim();
      const source = refToSource(ref.resolvedContent);
      if (!source) continue;
      refs.push({
        occurrence: ref,
        source,
        sentence: hostSentence(before) || paragraph,
        paragraph,
        section: sectionAt(sections, ref.offset),
      });
    }
  }

  return {
    lang,
    title,
    url: articleUrl(lang, title),
    wikitext,
    refs,
    sections,
    latin: isLatinScript(stripWikitext(wikitext.slice(0, 8000))),
  };
}

/**
 * Assembles a corpus from wikitext already in hand. Pure: use it for offline
 * runs (tests, a batch job over a dump) where the fetching is done elsewhere.
 */
export function buildWikiCorpus(
  article: Article,
  sisters: { lang: string; title: string; wikitext: string }[] = [],
  linkTranslations: Map<string, Map<string, string>> = new Map(),
): WikiCorpus {
  return {
    article,
    local: indexWikiArticle(article.lang, article.title, article.wikitext),
    sisters: sisters.map((s) => indexWikiArticle(s.lang, s.title, s.wikitext)),
    linkTranslations,
    warnings: [],
  };
}

/**
 * Fetches everything the wiki-local passes need: the article's own references,
 * its counterparts on other language editions, and the translations of the
 * wikilink targets appearing near the tagged claims.
 *
 * Done once per article: the per-claim search that follows is pure and free.
 */
export async function loadWikiCorpus(
  article: Article,
  claims: Claim[],
  options: WikiSourceOptions = {},
): Promise<WikiCorpus> {
  const warnings: string[] = [];
  const local = indexWikiArticle(article.lang, article.title, article.wikitext);
  const maxSisters = options.maxSisterWikis ?? 4;

  const corpus: WikiCorpus = {
    article,
    local,
    sisters: [],
    linkTranslations: new Map(),
    warnings,
  };
  if (maxSisters <= 0 || claims.length === 0) return corpus;

  let links;
  try {
    links = await fetchArticleLangLinks(article.lang, article.title);
  } catch (err) {
    warnings.push(`interlanguage links unavailable: ${(err as Error).message}`);
    return corpus;
  }

  const preferred = (options.sisterLangs ?? DEFAULT_SISTER_LANGS).filter(
    (l) => l !== article.lang,
  );
  const available = new Map(links.map((l) => [l.lang, l.title]));
  const chosen: { lang: string; title: string }[] = [];
  for (const lang of preferred) {
    if (chosen.length >= maxSisters) break;
    const title = available.get(lang);
    if (title) chosen.push({ lang, title });
  }
  if (chosen.length === 0) {
    warnings.push("no counterpart article on any of the preferred language editions");
    return corpus;
  }

  // Wikilinks near the tagged claims are pre-resolved entities: translating
  // their titles gives anchors that work even when the target wiki uses a
  // different script.
  const linkTargets = new Set<string>();
  for (const claim of claims) {
    const { start, end } = paragraphRangeAt(article.wikitext, claim.offset);
    for (const target of extractWikilinks(article.wikitext.slice(start, end))) {
      linkTargets.add(target);
    }
  }
  if (linkTargets.size > 0) {
    try {
      corpus.linkTranslations = await fetchLangLinks(
        article.lang,
        [...linkTargets],
        { langs: chosen.map((c) => c.lang) },
      );
    } catch (err) {
      warnings.push(`wikilink translation unavailable: ${(err as Error).message}`);
    }
  }

  const fetched = await pool(chosen, options.concurrency ?? 3, async (target) => {
    try {
      const page = await fetchWikitext(target.lang, target.title);
      return indexWikiArticle(target.lang, page.title, page.wikitext);
    } catch (err) {
      warnings.push(`${target.lang}.wikipedia.org: ${(err as Error).message}`);
      return null;
    }
  });
  corpus.sisters = fetched.filter((a): a is IndexedArticle => a !== null);
  return corpus;
}

/** Normalised URL key, used to collapse duplicate candidates across passes. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Human-readable label for a reference. */
function candidateTitle(source: RefSource): string {
  return source.title || source.work || source.url || "untitled reference";
}

/** Builds the `<ref>` an editor would paste for a wiki-local candidate. */
function reuseRef(ref: IndexedRef, sameArticle: boolean): string {
  // Re-using a name already defined on the page is the smallest possible edit,
  // but only within the same article, where that name exists.
  if (sameArticle && ref.occurrence.name) {
    return `<ref name="${ref.occurrence.name}" />`;
  }
  return `<ref>${ref.source.raw}</ref>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

/** Candidates from the citations already present in the tagged article. */
function sameArticleCandidates(
  corpus: WikiCorpus,
  claim: Claim,
  minScore: number,
): WikiCandidate[] {
  const background = tokenSet(`${corpus.article.title} ${claim.section ?? ""}`);
  const query = weightedTokens(`${claim.claim} ${claim.context}`, background);
  const paragraph = paragraphRangeAt(corpus.local.wikitext, claim.offset);

  const out: WikiCandidate[] = [];
  for (const ref of corpus.local.refs) {
    // A footnote in an explanatory group is commentary, not a source.
    if (ref.occurrence.group) continue;

    const sameParagraph =
      ref.occurrence.offset >= paragraph.start &&
      ref.occurrence.offset < paragraph.end;
    const sameSection = claim.section !== null && ref.section === claim.section;
    const proximity = sameParagraph ? 1 : sameSection ? 0.55 : 0.15;

    const lexical = coverage(query, `${refText(ref.source)} ${ref.sentence}`);
    // Outside the claim's own section, proximity says nothing: the reference
    // has to earn its place on what it is actually about.
    if (!sameParagraph && !sameSection && lexical < 0.3) continue;

    const score = 0.6 * lexical + 0.4 * proximity;
    if (score < minScore) continue;
    if (ref.source.url && isUnreliableSource(ref.source.url)) continue;
    // Without a URL there is nothing to verify, so demand a stronger match.
    if (!ref.source.url && score < minScore + 0.2) continue;

    out.push({
      url: ref.source.url,
      title: candidateTitle(ref.source),
      relevance: `already cited in this article for: "${truncate(ref.sentence, 160)}"`,
      snippet: ref.source.quote ?? ref.sentence,
      evidence: {
        origin: "same-article",
        lang: corpus.local.lang,
        article: corpus.local.title,
        articleUrl: corpus.local.url,
        sentence: ref.sentence,
        section: ref.section,
        score: Number(score.toFixed(3)),
        refName: ref.occurrence.name,
        refWikitext: ref.source.raw,
      },
      ref: reuseRef(ref, true),
    });
  }
  return out;
}

/** Candidates lifted from the matching sentence on other language editions. */
function sisterWikiCandidates(
  corpus: WikiCorpus,
  claim: Claim,
  minAnchorScore: number,
): WikiCandidate[] {
  const query: Anchors = anchorsOf(claim.claim);
  // The claim alone can be too thin to match on, so borrow numbers (but not
  // names, which are everywhere in a paragraph) from its context.
  if (query.numbers.length === 0) {
    query.numbers = anchorsOf(claim.context).numbers;
  }
  if (anchorCount(query) < 2) return [];

  const { start, end } = paragraphRangeAt(corpus.article.wikitext, claim.offset);
  const claimLinks = extractWikilinks(corpus.article.wikitext.slice(start, end));

  const out: WikiCandidate[] = [];
  for (const sister of corpus.sisters) {
    const translated = claimLinks
      .map((target) => corpus.linkTranslations.get(target)?.get(sister.lang))
      .filter((t): t is string => Boolean(t));
    // Proper nouns only transfer between wikis that share a script.
    const scoped: Anchors =
      sister.latin && corpus.local.latin
        ? query
        : { numbers: query.numbers, names: [] };
    if (anchorCount(scoped) + translated.length < 2) continue;

    for (const ref of sister.refs) {
      if (ref.occurrence.group) continue;
      // Without a URL there is nothing an editor here could follow up.
      if (!ref.source.url) continue;
      if (isUnreliableSource(ref.source.url)) continue;

      const onSentence = anchorScore(scoped, ref.sentence, translated);
      const onParagraph = anchorScore(scoped, ref.paragraph, translated);
      // A match on the exact sentence is the real signal; the same match
      // anywhere in the paragraph is a weaker one, discounted accordingly.
      const useSentence = onSentence.score >= onParagraph.score * 0.9;
      const score = useSentence ? onSentence.score : onParagraph.score * 0.7;
      const matched = useSentence ? onSentence.matched : onParagraph.matched;

      const strong = score >= 0.8 && matched.length >= 1;
      if (!strong && (score < minAnchorScore || matched.length < 2)) continue;

      out.push({
        url: ref.source.url,
        title: candidateTitle(ref.source),
        relevance:
          `cited on ${sister.lang}.wikipedia (${sister.title}) for: ` +
          `"${truncate(ref.sentence, 160)}"`,
        snippet: ref.source.quote ?? ref.sentence,
        evidence: {
          origin: "sister-wiki",
          lang: sister.lang,
          article: sister.title,
          articleUrl: sister.url,
          sentence: ref.sentence,
          section: ref.section,
          score: Number(score.toFixed(3)),
          matchedAnchors: matched,
          refName: ref.occurrence.name,
          refWikitext: ref.source.raw,
        },
        ref: reuseRef(ref, false),
      });
    }
  }
  return out;
}

/**
 * Finds citations already on Wikimedia that could support `claim`. Pure and
 * synchronous: all the network work happened in `loadWikiCorpus`.
 *
 * Results are ranked by match strength, deduplicated by URL, and carry the
 * evidence they were selected on. They are *leads*, not verdicts.
 */
export function findWikiCandidates(
  corpus: WikiCorpus,
  claim: Claim,
  options: WikiSourceOptions = {},
): WikiCandidate[] {
  const all = [
    ...sameArticleCandidates(corpus, claim, options.minScore ?? 0.3),
    ...sisterWikiCandidates(corpus, claim, options.minAnchorScore ?? 0.5),
  ];

  const best = new Map<string, WikiCandidate>();
  for (const candidate of all) {
    const key = candidate.url
      ? urlKey(candidate.url)
      : `raw:${candidate.evidence.refWikitext}`;
    const existing = best.get(key);
    if (!existing || candidate.evidence.score > existing.evidence.score) {
      best.set(key, candidate);
    }
  }

  return [...best.values()]
    .sort((a, b) => {
      if (b.evidence.score !== a.evidence.score) {
        return b.evidence.score - a.evidence.score;
      }
      // A citation another wiki attached to this very fact beats one this
      // article merely happens to use nearby.
      const rank = (c: WikiCandidate): number =>
        c.evidence.origin === "sister-wiki" ? 0 : 1;
      return rank(a) - rank(b);
    })
    .slice(0, options.maxCandidates ?? 5);
}

/** Wiki-local leads for one claim. */
export interface WikiSourceResult {
  claim: Claim;
  candidates: WikiCandidate[];
}

/** Result of the free, model-free pass over a whole article. */
export interface ArticleWikiSources {
  article: Article;
  results: WikiSourceResult[];
  /** Sister wikis that could not be reached, and similar non-fatal problems. */
  warnings: string[];
}

/**
 * Runs the wiki-local stage over an article and returns the leads, with no
 * model in the loop at all.
 *
 * This is the zero-inference layer on its own: free to run, no API key, and the
 * way to measure how much of the {{citation needed}} backlog never needed a
 * model in the first place.
 */
export async function findArticleWikiSources(
  urlOrTitle: string,
  options: WikiSourceOptions & { maxClaims?: number } = {},
): Promise<ArticleWikiSources> {
  const article = await fetchArticle(urlOrTitle);
  const all = extractClaims(article.wikitext);
  const claims = options.maxClaims ? all.slice(0, options.maxClaims) : all;
  const corpus = await loadWikiCorpus(article, claims, options);
  return {
    article,
    results: claims.map((claim) => ({
      claim,
      candidates: findWikiCandidates(corpus, claim, options),
    })),
    warnings: corpus.warnings,
  };
}

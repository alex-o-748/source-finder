/**
 * Internet Archive source discovery: find a public-domain book whose text
 * carries a {{citation needed}} claim, without a model.
 *
 * A funnel, so that at most a handful of books are ever looked at closely:
 *
 *   1. **Search.** One to three full-text queries built from the claim's
 *      numbers and names plus the article's subject, strictest first.
 *   2. **Public-domain gate**, on the hit's own fields: anything published
 *      after the US public-domain cutoff, or lent rather than open, is
 *      dropped. Public domain is the proxy for what actually matters: the full
 *      text is openly readable, so the passage can be checked by the verifier
 *      and by the editor.
 *   3. **Score.** Each hit comes with its matching passages. Each passage is
 *      scored on its own — two passages from one book may be pages apart — with
 *      the sister-wiki scoring: anchors that must match, then anchors and
 *      weighted token coverage. A book counts as its best passage.
 *   4. **Dedupe and look up.** One book per work, however many scans of it the
 *      Archive holds; then, for the few kept, the item metadata: the publisher
 *      for the citation, and the access-restriction flag once more.
 *
 * What comes out is evidence — a book, a passage, the anchors it matched — not
 * a verdict.
 */

import { fetchArticle } from "./fetchArticle.js";
import { extractClaims } from "./extractClaims.js";
import { httpArchiveClient } from "./internetArchive.js";
import type {
  ArchiveClient,
  MetadataResponse,
  SearchResponse,
} from "./internetArchive.js";
import {
  anchorScore,
  anchorsOf,
  coverage,
  fold,
  normaliseDigits,
  tokenSet,
  weightedTokens,
} from "./relevance.js";
import type { Anchors, TokenBag } from "./relevance.js";
import type { ArchiveCandidate, Article, Citation, Claim } from "./types.js";

export interface ArchiveSourceOptions {
  /** Hits requested per full-text query (default 50). */
  maxHits?: number;
  /** Full-text queries per claim, strictest first (default 3). */
  maxQueries?: number;
  /** Stop issuing looser queries once this many distinct books are found (default 10). */
  enoughHits?: number;
  /** Candidates returned per claim (default 3). */
  maxCandidates?: number;
  /** Minimum passage score to return a candidate (default 0.3). */
  minScore?: number;
  /** Latest publication year treated as public domain (default: this year − 96). */
  cutoffYear?: number;
  /** Add the public-domain year range to the search query too (default true). */
  filterInSearch?: boolean;
  /** Swap in a fixture-backed or recording client. */
  client?: ArchiveClient;
}

/**
 * Latest publication year in the US public domain: a work published in year Y
 * enters it on 1 January of Y + 96.
 */
export function publicDomainCutoff(now: Date = new Date()): number {
  return now.getUTCFullYear() - 96;
}

/** Collections of books the Archive lends rather than publishes openly. */
const LENDING_COLLECTIONS = new Set(["inlibrary", "printdisabled", "lendinglibrary"]);

// ---------------------------------------------------------------------------
// 1. Query construction
// ---------------------------------------------------------------------------

/** What a claim contributes to a full-text query. */
export interface ClaimTerms {
  /** The article's subject, disambiguator removed: "Mercury (planet)" → "Mercury". */
  subject: string;
  /** Numbers as written in the claim ("1889", "616,093"), years first. */
  numbers: string[];
  /** Proper names in the claim that are not just the subject, longest first. */
  names: string[];
}

const MAX_QUERY_NUMBERS = 3;
const MAX_QUERY_NAMES = 2;

export function subjectOf(title: string): string {
  return title.replace(/_/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Numbers as written — grouping kept, since OCR text keeps it too. */
function rawNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of normaliseDigits(text).matchAll(/\d(?:[\d,.]*\d)?/g)) {
    if (m[0].replace(/[,.]/g, "").length >= 2 && !out.includes(m[0])) {
      out.push(m[0]);
    }
  }
  const isYear = (n: string): boolean => /^(1[0-9]|20)\d\d$/.test(n);
  return [...out.filter(isYear), ...out.filter((n) => !isYear(n))];
}

export function claimTerms(claim: string, articleTitle: string): ClaimTerms {
  const subject = subjectOf(articleTitle);
  const subjectTokens = tokenSet(subject);
  const names = anchorsOf(claim)
    .names
    // A name made only of the subject's own words says nothing new.
    .filter((name) => !name.split(" ").every((w) => subjectTokens.has(w)))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const kept: string[] = [];
  for (const name of names) {
    // "berg" adds nothing once "anna berg" is in.
    if (kept.some((k) => k.split(" ").includes(name))) continue;
    kept.push(name);
  }
  return {
    subject,
    numbers: rawNumbers(claim).slice(0, MAX_QUERY_NUMBERS),
    names: kept.slice(0, MAX_QUERY_NAMES),
  };
}

function phrase(term: string): string {
  return `"${term.replace(/["\\]/g, " ").trim()}"`;
}

/**
 * Full-text queries for a claim, strictest first: the subject with every
 * number and name, then with the numbers only, then with the single strongest
 * anchor. Empty when the claim has no number or name — the subject alone
 * would match every book about it.
 */
export function buildArchiveQueries(terms: ClaimTerms): string[] {
  const subject = phrase(terms.subject);
  const numbers = terms.numbers.map(phrase);
  const names = terms.names.map(phrase);
  const strongest = numbers[0] ?? names[0];
  if (!strongest || !terms.subject) return [];

  const tiers = [
    [subject, ...numbers, ...names],
    [subject, ...numbers],
    [subject, strongest],
  ]
    .filter((t) => t.length > 1)
    .map((t) => t.join(" AND "));
  return [...new Set(tiers)];
}

/** Earliest year searched: nothing is printed before, and the range needs a bound. */
const EARLIEST_YEAR = 1450;

/**
 * The query with the public-domain range added, as the search understands it:
 * `… AND year:[1800 TO 1930]` was checked live to return only books in range.
 * Lending status is left to the gate — only the year clause has been tested.
 */
export function withPublicDomainFilter(query: string, cutoffYear: number): string {
  return `${query} AND year:[${EARLIEST_YEAR} TO ${cutoffYear}]`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** A book returned by the full-text search. */
export interface ArchiveHit {
  identifier: string;
  title: string;
  creator: string | null;
  year: number | null;
  mediatype: string | null;
  collections: string[];
  /** Matching passages the search returned, markup stripped. */
  highlights: string[];
  /** Position across all searches for this claim, for tie-breaking. */
  rank: number;
  /** The query that found it. */
  query: string;
}

function first(value: unknown): string | null {
  if (Array.isArray(value)) return first(value[0]);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function all(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(all);
  const one = first(value);
  return one === null ? [] : [one];
}

export function yearOf(value: unknown): number | null {
  const m = /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(first(value) ?? "");
  return m ? Number(m[1]) : null;
}

/** Strips the search's highlight markers (`{{{…}}}`) and OCR line breaks. */
export function stripHighlight(text: string): string {
  return text
    .replace(/\{\{\{|\}\}\}/g, "")
    .replace(/<\/?em>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads `response.body.hits.hits[]`: `fields` for the book, `highlight.text` for passages. */
export function parseSearchHits(response: SearchResponse, query: string): ArchiveHit[] {
  const raw = response.response?.body?.hits?.hits ?? [];
  const out: ArchiveHit[] = [];
  raw.forEach((h, rank) => {
    if (!h || typeof h !== "object") return;
    const hit = h as { fields?: Record<string, unknown>; highlight?: Record<string, unknown> };
    const f = hit.fields ?? {};
    const identifier = first(f.identifier);
    if (!identifier) return;
    out.push({
      identifier,
      title: first(f.title) ?? identifier,
      creator: first(f.creator),
      year: yearOf(f.year) ?? yearOf(f.date),
      mediatype: first(f.mediatype),
      collections: all(f.collection),
      highlights: all(hit.highlight?.text).map(stripHighlight).filter((t) => t.length > 0),
      rank,
      query,
    });
  });
  return out;
}

/** What the item metadata adds to a hit. */
export interface ItemDetails {
  publisher: string | null;
  restricted: boolean;
  copyrightStatus: string | null;
}

export function parseItemDetails(response: MetadataResponse): ItemDetails {
  const md = response.metadata ?? {};
  return {
    publisher: first(md.publisher),
    restricted:
      response.is_dark === true ||
      String(first(md["access-restricted-item"]) ?? "").toLowerCase() === "true",
    copyrightStatus: first(md["possible-copyright-status"]),
  };
}

// ---------------------------------------------------------------------------
// 2. Public-domain gate
// ---------------------------------------------------------------------------

export function publicDomainGate(
  hit: Pick<ArchiveHit, "year" | "mediatype" | "collections">,
  cutoffYear: number,
): { ok: true } | { ok: false; reason: string } {
  if (hit.mediatype && hit.mediatype !== "texts") {
    return { ok: false, reason: "not a text" };
  }
  if (hit.collections.some((c) => LENDING_COLLECTIONS.has(c))) {
    return { ok: false, reason: "lending library" };
  }
  if (hit.year === null) return { ok: false, reason: "no publication year" };
  if (hit.year > cutoffYear) {
    return { ok: false, reason: `published after ${cutoffYear}` };
  }
  return { ok: true };
}

/** The metadata-only checks, for the few books kept. */
export function detailsGate(details: ItemDetails): { ok: true } | { ok: false; reason: string } {
  if (details.restricted) return { ok: false, reason: "access restricted" };
  const status = details.copyrightStatus ?? "";
  if (/copyright/i.test(status) && !/not[_ ]in[_ ]copyright/i.test(status)) {
    return { ok: false, reason: "marked in copyright" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. Scoring
// ---------------------------------------------------------------------------

/** Everything about the claim that scoring a passage needs, computed once. */
export interface ScoringContext {
  anchors: Anchors;
  bag: TokenBag;
  /** Content tokens of the subject; one must appear unless the book is about it. */
  subjectTokens: string[];
}

export function scoringContext(claim: string, subject: string): ScoringContext {
  const subjectTokens = tokenSet(subject);
  return {
    anchors: anchorsOf(claim),
    bag: weightedTokens(claim, subjectTokens),
    subjectTokens: [...subjectTokens],
  };
}

/** Shorter than this, a passage is an OCR fragment rather than a sentence. */
const MIN_PASSAGE_CHARS = 40;

/**
 * How well a passage carries the claim, 0-1, or null when it fails a gate: too
 * short, none of the claim's numbers when the claim has some, or no mention of
 * the subject in a book not about it.
 *
 * `datelineYear` is a periodical issue's own year. Every page of an 1889 issue
 * says "1889" in its masthead, so there it is not evidence of anything: it is
 * dropped from the claim's numbers, and a claim whose only number it was gets
 * nothing from that issue.
 */
export function scorePassage(
  text: string,
  ctx: ScoringContext,
  bookIsAboutSubject: boolean,
  datelineYear: string | null = null,
): { score: number; matched: string[] } | null {
  if (text.length < MIN_PASSAGE_CHARS) return null;
  const have = tokenSet(text);
  if (
    !bookIsAboutSubject &&
    ctx.subjectTokens.length > 0 &&
    !ctx.subjectTokens.some((t) => have.has(t))
  ) {
    return null;
  }
  const query: Anchors = datelineYear
    ? { names: ctx.anchors.names, numbers: ctx.anchors.numbers.filter((n) => n !== datelineYear) }
    : ctx.anchors;
  const anchors = anchorScore(query, text);
  const numbersMatched = query.numbers.some((n) => anchors.matched.includes(n));
  if (ctx.anchors.numbers.length > 0 && !numbersMatched) return null;

  const cov = coverage(ctx.bag, have);
  const hasAnchors = query.numbers.length + query.names.length > 0;
  const score = hasAnchors ? 0.6 * anchors.score + 0.4 * cov : cov;
  return { score: Math.round(score * 100) / 100, matched: anchors.matched };
}

/** The title carries every word of the subject: the whole book is about it. */
export function titleIsAbout(title: string, subjectTokens: string[]): boolean {
  if (subjectTokens.length === 0) return false;
  const have = tokenSet(title);
  return subjectTokens.every((t) => have.has(t));
}

/**
 * One key per work, so five scans of the same book count once. The main title
 * only: the creator is spelled differently from scan to scan, and the subtitle
 * after the colon is catalogued on some scans and not others.
 */
export function editionKey(title: string): string {
  return fold(title.split(/\s*[:;]\s*/)[0])
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "a", "an"].includes(w))
    .slice(0, 8)
    .join(" ");
}

/** A hit that passed the gate, with its passages scored. */
export interface ScoredHit {
  hit: ArchiveHit;
  /** Passages that passed the gates and threshold, best first. */
  passages: { text: string; score: number; matched: string[] }[];
  /** The best passage's score. */
  score: number;
}

export interface RankedHits {
  /** Best first, one per work. */
  ranked: ScoredHit[];
  publicDomain: number;
  rejected: Record<string, number>;
  /** Public-domain books with at least one passage above the threshold. */
  matched: number;
}

/**
 * Steps 2–3 and the dedupe, with no I/O: from search hits to the books worth
 * showing. Kept pure so the user script's copy can be checked against it.
 */
export function rankArchiveHits(
  hits: ArchiveHit[],
  claim: string,
  articleTitle: string,
  cutoffYear: number,
  minScore: number,
): RankedHits {
  const subject = subjectOf(articleTitle);
  const ctx = scoringContext(claim, subject);
  const rejected: Record<string, number> = {};
  let publicDomain = 0;
  const scored: ScoredHit[] = [];

  for (const hit of hits) {
    const gate = publicDomainGate(hit, cutoffYear);
    if (!gate.ok) {
      rejected[gate.reason] = (rejected[gate.reason] ?? 0) + 1;
      continue;
    }
    publicDomain++;
    const about = titleIsAbout(hit.title, ctx.subjectTokens);
    const dateline =
      hit.year !== null && hit.collections.includes("periodicals") ? String(hit.year) : null;
    const passages = hit.highlights
      .map((text) => ({ text, s: scorePassage(text, ctx, about, dateline) }))
      .filter((p) => p.s !== null && p.s.score >= minScore)
      .map((p) => ({ text: p.text, score: p.s!.score, matched: p.s!.matched }))
      .sort((a, b) => b.score - a.score);
    if (passages.length > 0) scored.push({ hit, passages, score: passages[0].score });
  }

  const byWork = new Map<string, ScoredHit>();
  for (const s of scored) {
    const key = editionKey(s.hit.title);
    const kept = byWork.get(key);
    if (!kept || s.score > kept.score || (s.score === kept.score && s.hit.rank < kept.hit.rank)) {
      byWork.set(key, s);
    }
  }
  const ranked = [...byWork.values()].sort(
    (a, b) => b.score - a.score || a.hit.rank - b.hit.rank,
  );
  return { ranked, publicDomain, rejected, matched: scored.length };
}

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

function escapePipes(s: string): string {
  return s.replace(/\|/g, "{{!}}");
}

/** "Smith, John, 1850-1920" → "Smith, John": the Archive appends life dates. */
export function cleanCreator(creator: string): string {
  return creator.replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?\s*$/, "").trim();
}

export function detailsUrl(identifier: string): string {
  return `https://archive.org/details/${encodeURIComponent(identifier)}`;
}

/** Opens the book with the claim's strongest anchor searched, so the editor lands on the passage. */
export function viewerUrl(identifier: string, terms: ClaimTerms): string {
  const q = terms.numbers[0] ?? terms.names[0] ?? terms.subject;
  return `${detailsUrl(identifier)}?q=${encodeURIComponent(q)}`;
}

export function formatArchiveCitation(
  hit: Pick<ArchiveHit, "identifier" | "title" | "creator" | "year">,
  publisher: string | null,
): Citation {
  const parts = [
    `title=${escapePipes(hit.title)}`,
    hit.creator ? `author=${escapePipes(cleanCreator(hit.creator))}` : null,
    publisher ? `publisher=${escapePipes(publisher)}` : null,
    hit.year !== null ? `year=${hit.year}` : null,
    `url=${detailsUrl(hit.identifier)}`,
    "via=Internet Archive",
  ].filter((p): p is string => p !== null);
  const template = `{{cite book |${parts.join(" |")}}}`;
  return { template, ref: `<ref>${template}</ref>`, kind: "cite book" };
}

/** "gustave eiffel, gustave, eiffel" → "gustave eiffel": the parts add nothing to read. */
export function compactAnchors(matched: string[]): string[] {
  const phrases = matched.filter((m) => m.includes(" "));
  return matched.filter(
    (m) => m.includes(" ") || !phrases.some((p) => p.split(" ").includes(m)),
  );
}

export function toArchiveCandidate(
  s: ScoredHit,
  publisher: string | null,
  terms: ClaimTerms,
): ArchiveCandidate {
  const { hit } = s;
  const best = s.passages[0];
  const matched = compactAnchors(best.matched);
  const byline = [hit.year, hit.creator && cleanCreator(hit.creator)].filter(Boolean).join(", ");
  return {
    url: detailsUrl(hit.identifier),
    title: hit.title,
    relevance: `Internet Archive, ${byline} — matched ${matched.join(", ") || "claim wording"}`,
    snippet: best.text,
    evidence: {
      origin: "internet-archive",
      identifier: hit.identifier,
      year: hit.year!,
      passages: s.passages.map((p) => p.text),
      score: s.score,
      matchedAnchors: matched,
      query: hit.query,
      viewerUrl: viewerUrl(hit.identifier, terms),
    },
    citation: formatArchiveCitation(hit, publisher),
  };
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

/** How many books survived each step — the numbers that say whether this works. */
export interface ArchiveFunnel {
  queries: string[];
  /** Whether the search itself filtered to public domain, or only the gate did. */
  filter: "search" | "gate only";
  /** Distinct books the search returned. */
  hits: number;
  /** Books that passed the public-domain gate. */
  publicDomain: number;
  /** Why the others did not, counted by reason. */
  rejected: Record<string, number>;
  /** Books with a passage above the score threshold. */
  matched: number;
  /** Books whose metadata was read. */
  lookedUp: number;
  /** After collapsing editions, the metadata checks and the cap. */
  candidates: number;
  /** Non-fatal request failures. */
  errors: string[];
}

export interface ArchiveSourceResult {
  claim: Claim;
  candidates: ArchiveCandidate[];
  funnel: ArchiveFunnel;
}

export async function findArchiveCandidates(
  claim: Claim,
  articleTitle: string,
  options: ArchiveSourceOptions = {},
): Promise<ArchiveSourceResult> {
  const client = options.client ?? httpArchiveClient;
  const cutoff = options.cutoffYear ?? publicDomainCutoff();
  const maxCandidates = options.maxCandidates ?? 3;
  const terms = claimTerms(claim.claim, articleTitle);
  const queries = buildArchiveQueries(terms).slice(0, options.maxQueries ?? 3);

  const funnel: ArchiveFunnel = {
    queries: [],
    filter: options.filterInSearch === false ? "gate only" : "search",
    hits: 0,
    publicDomain: 0,
    rejected: {},
    matched: 0,
    lookedUp: 0,
    candidates: 0,
    errors: [],
  };

  // 1. Search, strictest query first, until enough distinct books.
  const hits = new Map<string, ArchiveHit>();
  for (const query of queries) {
    funnel.queries.push(query);
    const size = options.maxHits ?? 50;
    let response: SearchResponse | null = null;
    try {
      response = await client.fullTextSearch({
        query: funnel.filter === "search" ? withPublicDomainFilter(query, cutoff) : query,
        size,
      });
    } catch (err) {
      funnel.errors.push(`search failed: ${(err as Error).message}`);
      // The search's query syntax is undocumented; if it rejects the year
      // clause, carry on without it — the gate still checks every hit.
      if (funnel.filter === "search") {
        funnel.filter = "gate only";
        try {
          response = await client.fullTextSearch({ query, size });
        } catch (retryErr) {
          funnel.errors.push(`search failed without filter too: ${(retryErr as Error).message}`);
        }
      }
    }
    for (const hit of response ? parseSearchHits(response, query) : []) {
      if (!hits.has(hit.identifier)) hits.set(hit.identifier, { ...hit, rank: hits.size });
    }
    if (hits.size >= (options.enoughHits ?? 10)) break;
  }
  funnel.hits = hits.size;

  // 2–3. Gate, score, one per work.
  const ranked = rankArchiveHits(
    [...hits.values()],
    claim.claim,
    articleTitle,
    cutoff,
    options.minScore ?? 0.3,
  );
  funnel.publicDomain = ranked.publicDomain;
  funnel.rejected = ranked.rejected;
  funnel.matched = ranked.matched;

  // 4. Metadata for the few kept: publisher, and the restriction flag. A
  // couple of spares, in case one turns out restricted.
  const shortlist = ranked.ranked.slice(0, maxCandidates + 2);
  funnel.lookedUp = shortlist.length;
  const candidates: ArchiveCandidate[] = [];
  for (const s of shortlist) {
    if (candidates.length >= maxCandidates) break;
    let publisher: string | null = null;
    try {
      const details = parseItemDetails(await client.metadata(s.hit.identifier));
      const gate = detailsGate(details);
      if (!gate.ok) {
        funnel.rejected[gate.reason] = (funnel.rejected[gate.reason] ?? 0) + 1;
        continue;
      }
      publisher = details.publisher;
    } catch (err) {
      // The hit already passed the gate; a lead without a publisher is still a lead.
      funnel.errors.push(`metadata ${s.hit.identifier}: ${(err as Error).message}`);
    }
    candidates.push(toArchiveCandidate(s, publisher, terms));
  }
  funnel.candidates = candidates.length;

  return { claim, candidates, funnel };
}

export interface ArticleArchiveSources {
  article: Article;
  results: ArchiveSourceResult[];
}

/**
 * The Internet Archive stage on its own, for every {{cn}} claim in an article.
 * Claims run one after another: the Archive is a shared, donated service.
 */
export async function findArticleArchiveSources(
  urlOrTitle: string,
  options: ArchiveSourceOptions & {
    maxClaims?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ArticleArchiveSources> {
  const article = await fetchArticle(urlOrTitle);
  const every = extractClaims(article.wikitext);
  const claims = options.maxClaims ? every.slice(0, options.maxClaims) : every;
  const results: ArchiveSourceResult[] = [];
  for (const claim of claims) {
    results.push(await findArchiveCandidates(claim, article.title, options));
    options.onProgress?.(results.length, claims.length);
  }
  return { article, results };
}

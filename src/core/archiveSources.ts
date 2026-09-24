/**
 * Internet Archive source discovery: find a public-domain book whose text
 * carries a {{citation needed}} claim, without a model.
 *
 * A funnel, so that at most a handful of passages ever reach the paid verifier:
 *
 *   1. **Search.** One to three full-text queries built from the claim's
 *      numbers and names plus the article's subject, strictest first.
 *   2. **Public-domain gate.** Each book's metadata is read; anything
 *      published after the US public-domain cutoff, restricted, or lent rather
 *      than open is dropped. Public domain is the proxy for what actually
 *      matters: the full text is openly readable, so the passage can be
 *      checked by the verifier and by the editor.
 *   3. **Passages.** The matching paragraph in each surviving book — from the
 *      search hit if it carries one, else by searching inside the book, else
 *      from the book's OCR text.
 *   4. **Score and dedupe.** The same deterministic scoring as the sister-wiki
 *      pass (anchors that must match, weighted token coverage), one passage
 *      per work, however many scans of it the Archive holds.
 *
 * What comes out is evidence — a book, a passage, the anchors it matched — not
 * a verdict.
 */

import { fetchArticle } from "./fetchArticle.js";
import { extractClaims } from "./extractClaims.js";
import { httpArchiveClient } from "./internetArchive.js";
import type {
  ArchiveClient,
  FtsResponse,
  InsideResponse,
  MetadataResponse,
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
import { pool } from "./wikiSources.js";
import type {
  ArchiveCandidate,
  ArchiveEvidence,
  Article,
  Citation,
  Claim,
} from "./types.js";

export interface ArchiveSourceOptions {
  /** Hits requested per full-text query (default 50). */
  maxHits?: number;
  /** Full-text queries per claim, strictest first (default 3). */
  maxQueries?: number;
  /** Stop issuing looser queries once this many distinct books are found (default 10). */
  enoughHits?: number;
  /** Books whose metadata is read for the public-domain gate (default 15). */
  metadataLookups?: number;
  /** Public-domain books searched for a passage (default 10). */
  passageLookups?: number;
  /** Candidates returned per claim (default 3). */
  maxCandidates?: number;
  /** Minimum passage score to return a candidate (default 0.35). */
  minScore?: number;
  /** Latest publication year treated as public domain (default: this year − 96). */
  cutoffYear?: number;
  /** Put the public-domain filter in the search query too (default true). */
  filterInQuery?: boolean;
  /** Concurrent Archive requests (default 3). */
  concurrency?: number;
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
  return title.replace(/\s*\([^)]*\)\s*$/, "").trim();
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
    .sort((a, b) => b.length - a.length);
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

/** The query clause that keeps results to openly readable public-domain books. */
export function publicDomainFilter(cutoffYear: number): string {
  return (
    `mediatype:texts AND year:[* TO ${cutoffYear}] ` +
    `AND NOT collection:(${[...LENDING_COLLECTIONS].join(" OR ")})`
  );
}

/**
 * Full-text queries for a claim, strictest first: the subject with every
 * number and name, then with the numbers only, then with the single strongest
 * anchor. Empty when the claim has no number or name — the subject alone
 * would match every book about it.
 */
export function buildArchiveQueries(
  terms: ClaimTerms,
  filter: string | null,
): string[] {
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
  return [...new Set(tiers)].map((q) => (filter ? `(${q}) AND ${filter}` : q));
}

// ---------------------------------------------------------------------------
// Response parsing. The full-text and search-inside shapes are undocumented;
// these accept every variant the reference clients read.
// ---------------------------------------------------------------------------

/** A book returned by the full-text search. */
export interface ArchiveHit {
  identifier: string;
  title: string | null;
  year: number | null;
  /** Matching text the search returned with the hit, markup stripped. */
  highlights: string[];
  /** Position in the search results, for tie-breaking. */
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

/** Strips search-engine highlight markup: `<em>…</em>`, `{{{…}}}`. */
export function stripHighlight(text: string): string {
  return text
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\{\{\{|\}\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFtsHits(response: FtsResponse, query: string): ArchiveHit[] {
  const raw = response.hits?.hits ?? [];
  const out: ArchiveHit[] = [];
  raw.forEach((h, rank) => {
    if (!h || typeof h !== "object") return;
    const hit = h as Record<string, unknown>;
    const fields = (hit.fields ?? {}) as Record<string, unknown>;
    const source = (hit._source ?? {}) as Record<string, unknown>;
    const field = (name: string): unknown =>
      fields[name] ?? source[name] ?? hit[name];
    const identifier = first(field("identifier")) ?? first(hit._id);
    if (!identifier) return;
    const highlight = (hit.highlight ?? {}) as Record<string, unknown>;
    out.push({
      identifier,
      title: first(field("title")),
      year: yearOf(field("year") ?? field("date")),
      highlights: Object.values(highlight)
        .flatMap(all)
        .map(stripHighlight)
        .filter((t) => t.length > 0),
      rank,
      query,
    });
  });
  return out;
}

/** The parts of an item's metadata the gate and the citation need. */
export interface ArchiveItem {
  identifier: string;
  title: string;
  creator: string | null;
  publisher: string | null;
  year: number | null;
  mediatype: string | null;
  collections: string[];
  restricted: boolean;
  copyrightStatus: string | null;
  server: string | null;
  dir: string | null;
  /** Name of the plain OCR text file, when the item has one. */
  textFile: string | null;
}

export function parseMetadata(identifier: string, response: MetadataResponse): ArchiveItem {
  const md = response.metadata ?? {};
  const files = (response.files ?? [])
    .map((f) => f.name ?? "")
    .filter((name) => name.endsWith("_djvu.txt"));
  return {
    identifier,
    title: first(md.title) ?? identifier,
    creator: first(md.creator),
    publisher: first(md.publisher),
    year: yearOf(md.year) ?? yearOf(md.date),
    mediatype: first(md.mediatype),
    collections: all(md.collection),
    restricted:
      response.is_dark === true ||
      String(first(md["access-restricted-item"]) ?? "").toLowerCase() === "true",
    copyrightStatus: first(md["possible-copyright-status"]),
    server: response.server ?? null,
    dir: response.dir ?? null,
    textFile: files.find((f) => f === `${identifier}_djvu.txt`) ?? files[0] ?? null,
  };
}

/** A candidate passage in a book. */
export interface Passage {
  text: string;
  leaf: number | null;
  from: ArchiveEvidence["passageFrom"];
}

export function parseInsideMatches(response: InsideResponse): Passage[] {
  return (response.matches ?? []).flatMap((m): Passage[] => {
    if (!m || typeof m !== "object") return [];
    const match = m as { text?: unknown; par?: { page?: unknown }[] };
    const text = typeof match.text === "string" ? stripHighlight(match.text) : "";
    if (!text) return [];
    const page = match.par?.[0]?.page;
    return [
      {
        text,
        leaf: typeof page === "number" ? page : null,
        from: "search-inside",
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// 2. Public-domain gate
// ---------------------------------------------------------------------------

export function publicDomainGate(
  item: ArchiveItem,
  cutoffYear: number,
): { ok: true } | { ok: false; reason: string } {
  if (item.mediatype && item.mediatype !== "texts") {
    return { ok: false, reason: "not a text" };
  }
  if (item.restricted) return { ok: false, reason: "access restricted" };
  if (item.collections.some((c) => LENDING_COLLECTIONS.has(c))) {
    return { ok: false, reason: "lending library" };
  }
  const status = item.copyrightStatus ?? "";
  if (/copyright/i.test(status) && !/not[_ ]in[_ ]copyright/i.test(status)) {
    return { ok: false, reason: "marked in copyright" };
  }
  if (item.year === null) return { ok: false, reason: "no publication year" };
  if (item.year > cutoffYear) {
    return { ok: false, reason: `published after ${cutoffYear}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3–4. Passages and scoring
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

const MIN_PASSAGE_CHARS = 80;

/**
 * How well a passage carries the claim, 0-1, or null when it fails a gate: too
 * short to be more than an OCR fragment, none of the claim's numbers when the
 * claim has some, or no mention of the subject in a book not about it.
 */
export function scorePassage(
  text: string,
  ctx: ScoringContext,
  bookIsAboutSubject: boolean,
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
  const anchors = anchorScore(ctx.anchors, text);
  const numbersMatched = ctx.anchors.numbers.some((n) => anchors.matched.includes(n));
  if (ctx.anchors.numbers.length > 0 && !numbersMatched) return null;

  const cov = coverage(ctx.bag, have);
  const hasAnchors = ctx.anchors.numbers.length + ctx.anchors.names.length > 0;
  const score = hasAnchors ? 0.6 * anchors.score + 0.4 * cov : cov;
  return { score: Math.round(score * 100) / 100, matched: anchors.matched };
}

const WINDOW_BEFORE = 700;
const WINDOW_AFTER = 800;
/** Anchor occurrences considered in one book's OCR text. */
const MAX_OCCURRENCES = 2000;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Windows of a book's OCR text centred on occurrences of the claim's anchors,
 * best first and non-overlapping. Only positions near an anchor are scored, so
 * a long book costs no more than its matches.
 */
export function bestWindows(
  text: string,
  terms: ClaimTerms,
  ctx: ScoringContext,
  bookIsAboutSubject: boolean,
  limit = 3,
): Passage[] {
  const needles = [
    ...terms.numbers,
    ...terms.numbers.map((n) => n.replace(/[,.]/g, "")),
    ...terms.names,
  ].filter((n, i, a) => n.length > 1 && a.indexOf(n) === i);
  if (needles.length === 0) return [];
  const re = new RegExp(needles.map(escapeRegExp).join("|"), "giu");

  const scored: { start: number; end: number; score: number }[] = [];
  let seen = 0;
  for (const m of text.matchAll(re)) {
    if (++seen > MAX_OCCURRENCES) break;
    const start = Math.max(0, (m.index ?? 0) - WINDOW_BEFORE);
    const end = Math.min(text.length, (m.index ?? 0) + WINDOW_AFTER);
    const s = scorePassage(text.slice(start, end), ctx, bookIsAboutSubject);
    if (s) scored.push({ start, end, score: s.score });
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);

  const picked: typeof scored = [];
  for (const w of scored) {
    if (picked.some((p) => w.start < p.end && p.start < w.end)) continue;
    picked.push(w);
    if (picked.length >= limit) break;
  }
  return picked.map((w) => ({
    text: text.slice(w.start, w.end).replace(/\s+/g, " ").trim(),
    leaf: null,
    from: "plain-text",
  }));
}

/**
 * One key per work, so five scans of the same book count once. Title only: the
 * creator is spelled differently from scan to scan, the title rarely is.
 */
export function editionKey(title: string): string {
  return fold(title)
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "a", "an"].includes(w))
    .slice(0, 8)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

function escapePipes(s: string): string {
  return s.replace(/\|/g, "{{!}}");
}

/** "Smith, John, 1850-1920" → "Smith, John": the Archive appends life dates. */
function cleanCreator(creator: string): string {
  return creator.replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?\s*$/, "").trim();
}

export function archiveUrl(identifier: string, leaf: number | null): string {
  const base = `https://archive.org/details/${encodeURIComponent(identifier)}`;
  return leaf === null ? base : `${base}/page/n${leaf}`;
}

export function formatArchiveCitation(item: ArchiveItem, leaf: number | null): Citation {
  const parts = [
    `title=${escapePipes(item.title)}`,
    item.creator ? `author=${escapePipes(cleanCreator(item.creator))}` : null,
    item.publisher ? `publisher=${escapePipes(item.publisher)}` : null,
    item.year !== null ? `year=${item.year}` : null,
    `url=${archiveUrl(item.identifier, leaf)}`,
    "via=Internet Archive",
  ].filter((p): p is string => p !== null);
  const template = `{{cite book |${parts.join(" |")}}}`;
  return { template, ref: `<ref>${template}</ref>`, kind: "cite book" };
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

/** How many books survived each step — the numbers that say whether this works. */
export interface ArchiveFunnel {
  queries: string[];
  /** Distinct books the search returned. */
  hits: number;
  /** Books whose metadata was read. */
  lookedUp: number;
  /** Books that passed the public-domain gate. */
  publicDomain: number;
  /** Why the others did not, counted by reason. */
  rejected: Record<string, number>;
  /** Books searched for a passage. */
  searched: number;
  /** Books with a passage above the score threshold. */
  matched: number;
  /** After collapsing editions and capping. */
  candidates: number;
  /** Non-fatal request failures. */
  errors: string[];
}

export interface ArchiveSourceResult {
  claim: Claim;
  candidates: ArchiveCandidate[];
  funnel: ArchiveFunnel;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The title carries every word of the subject: the whole book is about it. */
function titleIsAbout(title: string | null, subjectTokens: string[]): boolean {
  if (!title || subjectTokens.length === 0) return false;
  const have = tokenSet(title);
  return subjectTokens.every((t) => have.has(t));
}

/** The one term to search inside a book for: its strongest anchor. */
function insideQuery(terms: ClaimTerms): string {
  return terms.numbers[0] ?? terms.names[0] ?? terms.subject;
}

export async function findArchiveCandidates(
  claim: Claim,
  articleTitle: string,
  options: ArchiveSourceOptions = {},
): Promise<ArchiveSourceResult> {
  const client = options.client ?? httpArchiveClient;
  const cutoff = options.cutoffYear ?? publicDomainCutoff();
  const minScore = options.minScore ?? 0.35;
  const concurrency = options.concurrency ?? 3;

  const terms = claimTerms(claim.claim, articleTitle);
  const ctx = scoringContext(claim.claim, terms.subject);
  const queries = buildArchiveQueries(
    terms,
    options.filterInQuery === false ? null : publicDomainFilter(cutoff),
  ).slice(0, options.maxQueries ?? 3);

  const funnel: ArchiveFunnel = {
    queries: [],
    hits: 0,
    lookedUp: 0,
    publicDomain: 0,
    rejected: {},
    searched: 0,
    matched: 0,
    candidates: 0,
    errors: [],
  };

  // 1. Search, strictest query first, until enough distinct books.
  const hits = new Map<string, ArchiveHit>();
  for (const query of queries) {
    funnel.queries.push(query);
    try {
      const response = await client.fullTextSearch(query, options.maxHits ?? 50);
      for (const hit of parseFtsHits(response, query)) {
        if (!hits.has(hit.identifier)) {
          hits.set(hit.identifier, { ...hit, rank: hits.size });
        }
      }
    } catch (err) {
      funnel.errors.push(`search failed: ${(err as Error).message}`);
    }
    if (hits.size >= (options.enoughHits ?? 10)) break;
  }
  funnel.hits = hits.size;

  // Books named for the subject first, then the search engine's own order.
  const ordered = [...hits.values()].sort((a, b) => {
    const about = (h: ArchiveHit): number => (titleIsAbout(h.title, ctx.subjectTokens) ? 0 : 1);
    return about(a) - about(b) || a.rank - b.rank;
  });

  // 2. Public-domain gate, on the metadata.
  const toLookUp = ordered.slice(0, options.metadataLookups ?? 15);
  funnel.lookedUp = toLookUp.length;
  const items = await pool(toLookUp, concurrency, async (hit) => {
    try {
      return parseMetadata(hit.identifier, await client.metadata(hit.identifier));
    } catch (err) {
      funnel.errors.push(`metadata ${hit.identifier}: ${(err as Error).message}`);
      return null;
    }
  });
  const open: { hit: ArchiveHit; item: ArchiveItem }[] = [];
  items.forEach((item, i) => {
    if (!item) return;
    const gate = publicDomainGate(item, cutoff);
    if (gate.ok) open.push({ hit: toLookUp[i], item });
    else funnel.rejected[gate.reason] = (funnel.rejected[gate.reason] ?? 0) + 1;
  });
  funnel.publicDomain = open.length;

  // 3. A passage per book: the hit's own text, else search inside, else OCR text.
  const toSearch = open.slice(0, options.passageLookups ?? 10);
  funnel.searched = toSearch.length;
  const found = await pool(toSearch, concurrency, async ({ hit, item }) => {
    const about = titleIsAbout(item.title, ctx.subjectTokens);
    let best: { passage: Passage; score: number; matched: string[] } | null = null;
    const consider = (passages: Passage[]): void => {
      for (const passage of passages) {
        const s = scorePassage(passage.text, ctx, about);
        if (s && (!best || s.score > best.score)) best = { passage, ...s };
      }
    };
    const goodEnough = (): boolean => best !== null && best.score >= minScore;

    consider(hit.highlights.map((text) => ({ text, leaf: null, from: "search-hit" as const })));
    if (!goodEnough() && item.server && item.dir) {
      try {
        consider(
          parseInsideMatches(
            await client.searchInside(item.identifier, item.server, item.dir, insideQuery(terms)),
          ),
        );
      } catch (err) {
        funnel.errors.push(`search inside ${item.identifier}: ${(err as Error).message}`);
      }
    }
    if (!goodEnough() && item.textFile) {
      try {
        consider(bestWindows(await client.plainText(item.identifier, item.textFile), terms, ctx, about));
      } catch (err) {
        funnel.errors.push(`text ${item.identifier}: ${(err as Error).message}`);
      }
    }
    return goodEnough() ? { hit, item, ...best! } : null;
  });
  const matched = found.filter((f): f is NonNullable<typeof f> => f !== null);
  funnel.matched = matched.length;

  // 4. One per work, best first.
  const byWork = new Map<string, (typeof matched)[number]>();
  for (const m of matched) {
    const key = editionKey(m.item.title);
    const kept = byWork.get(key);
    if (!kept || m.score > kept.score) byWork.set(key, m);
  }
  const ranked = [...byWork.values()]
    .sort((a, b) => b.score - a.score || a.hit.rank - b.hit.rank)
    .slice(0, options.maxCandidates ?? 3);
  funnel.candidates = ranked.length;

  const candidates = ranked.map(({ hit, item, passage, score, matched: anchors }): ArchiveCandidate => {
    const citation = formatArchiveCitation(item, passage.leaf);
    const byline = [item.year, item.creator && cleanCreator(item.creator)].filter(Boolean).join(", ");
    return {
      url: archiveUrl(item.identifier, passage.leaf),
      title: item.title,
      relevance: `Internet Archive, ${byline} — matched ${anchors.join(", ") || "claim wording"}`,
      snippet: truncate(passage.text, 500),
      evidence: {
        origin: "internet-archive",
        identifier: item.identifier,
        year: item.year!,
        passage: passage.text,
        leaf: passage.leaf,
        passageFrom: passage.from,
        score,
        matchedAnchors: anchors,
        query: hit.query,
      },
      citation,
    };
  });

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
  const all = extractClaims(article.wikitext);
  const claims = options.maxClaims ? all.slice(0, options.maxClaims) : all;
  const results: ArchiveSourceResult[] = [];
  for (const claim of claims) {
    results.push(await findArchiveCandidates(claim, article.title, options));
    options.onProgress?.(results.length, claims.length);
  }
  return { article, results };
}

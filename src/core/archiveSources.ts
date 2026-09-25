/**
 * Internet Archive source discovery: find a book whose text carries a
 * {{citation needed}} claim, without a model.
 *
 * A funnel, so that at most a handful of books are ever looked at closely:
 *
 *   1. **Search.** One to three full-text queries built from the claim's
 *      numbers and names plus the article's subject, strictest first.
 *   2. **Access gate**, on the hit's own fields. What matters is that an
 *      editor can read the passage: an open book, or one in the lending
 *      library, which anyone with a free archive.org account can borrow. Books
 *      only print-disabled readers can open are dropped.
 *   3. **Score.** Each hit comes with its matching passages. Each passage is
 *      scored on its own — two passages from one book may be pages apart — with
 *      the sister-wiki scoring: anchors that must match, then anchors and
 *      weighted token coverage. A book counts as its best passage.
 *   4. **Dedupe and look up.** One book per work, however many scans of it the
 *      Archive holds; then, for the few kept, the item metadata: the publisher
 *      and ISBN for the citation, and whether it has been withdrawn.
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
  /** Swap in a fixture-backed or recording client. */
  client?: ArchiveClient;
}

/** Collections of books anyone with a free account can borrow. */
const LENDING_COLLECTIONS = new Set(["inlibrary", "lendinglibrary"]);
/** Books only certified print-disabled readers can open, unless also lent. */
const PRINT_DISABLED = "printdisabled";

/** How an editor gets at the book: read it, or borrow it with a free account. */
export type ArchiveAccess = "open" | "borrow";

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
  isbn: string | null;
  /** Withdrawn from public view. */
  dark: boolean;
  /** Set on every lending-library book, so only telling for the others. */
  restricted: boolean;
}

export function parseItemDetails(response: MetadataResponse): ItemDetails {
  const md = response.metadata ?? {};
  return {
    publisher: first(md.publisher),
    isbn: first(md.isbn),
    dark: response.is_dark === true,
    restricted: String(first(md["access-restricted-item"]) ?? "").toLowerCase() === "true",
  };
}

// ---------------------------------------------------------------------------
// 2. Access gate
// ---------------------------------------------------------------------------

/** Whether an editor can read the book, and how. */
export function accessGate(
  hit: Pick<ArchiveHit, "mediatype" | "collections">,
): { ok: true; access: ArchiveAccess } | { ok: false; reason: string } {
  if (hit.mediatype && hit.mediatype !== "texts") {
    return { ok: false, reason: "not a text" };
  }
  if (hit.collections.some((c) => LENDING_COLLECTIONS.has(c))) {
    return { ok: true, access: "borrow" };
  }
  if (hit.collections.includes(PRINT_DISABLED)) {
    return { ok: false, reason: "print-disabled readers only" };
  }
  return { ok: true, access: "open" };
}

/** The metadata-only checks, for the few books kept. */
export function detailsGate(
  details: ItemDetails,
  access: ArchiveAccess,
): { ok: true } | { ok: false; reason: string } {
  if (details.dark) return { ok: false, reason: "withdrawn" };
  // Every lending-library book is flagged restricted; any other one cannot be
  // borrowed, so nobody without special access can read it.
  if (details.restricted && access === "open") {
    return { ok: false, reason: "access restricted" };
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
  const v = judgePassage(text, ctx, bookIsAboutSubject, datelineYear);
  return "reason" in v ? null : v;
}

/** Why a passage failed a gate, as the console summary counts it. */
export type PassageDropReason = "too short" | "no subject" | "no claim number";

/** `scorePassage`, but saying which gate a passage failed. */
export function judgePassage(
  text: string,
  ctx: ScoringContext,
  bookIsAboutSubject: boolean,
  datelineYear: string | null = null,
): { score: number; matched: string[] } | { reason: PassageDropReason } {
  if (text.length < MIN_PASSAGE_CHARS) return { reason: "too short" };
  const have = tokenSet(text);
  if (
    !bookIsAboutSubject &&
    ctx.subjectTokens.length > 0 &&
    !ctx.subjectTokens.some((t) => have.has(t))
  ) {
    return { reason: "no subject" };
  }
  const query: Anchors = datelineYear
    ? { names: ctx.anchors.names, numbers: ctx.anchors.numbers.filter((n) => n !== datelineYear) }
    : ctx.anchors;
  const anchors = anchorScore(query, text);
  const numbersMatched = query.numbers.some((n) => anchors.matched.includes(n));
  if (ctx.anchors.numbers.length > 0 && !numbersMatched) return { reason: "no claim number" };

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
 * The part of a title that identifies the work: the main title only, since the
 * subtitle after the colon is catalogued on some scans and not others. See
 * `sameWork` for how the creator is used alongside it.
 */
export function editionKey(title: string): string {
  return fold(title.split(/\s*[:;]\s*/)[0])
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "a", "an"].includes(w))
    .slice(0, 8)
    .join(" ");
}

/**
 * Two scans of one work: the same main title, and creators that share a name
 * — or no creator on one of them to say otherwise. Creators are spelled
 * differently from scan to scan ("Tissandier, Gaston, 1843-1899"), so a shared
 * word is enough; a different author under the same title is a different work.
 */
export function sameWork(
  a: Pick<ArchiveHit, "title" | "creator">,
  b: Pick<ArchiveHit, "title" | "creator">,
): boolean {
  if (editionKey(a.title) !== editionKey(b.title)) return false;
  if (!a.creator || !b.creator) return true;
  const theirs = tokenSet(cleanCreator(b.creator));
  return [...tokenSet(cleanCreator(a.creator))].some((t) => theirs.has(t));
}

/**
 * What happened to the passages of the readable books: how many there were,
 * how many each gate dropped, and the best one that scored but fell short —
 * enough to tell from the console why a search came back empty.
 */
export interface PassageStats {
  seen: number;
  /** Counted by gate, plus "below threshold". */
  dropped: Record<string, number>;
  /** The highest-scoring passage under the threshold. */
  bestBelow: { score: number; identifier: string; text: string } | null;
}

/** A hit that passed the gate, with its passages scored. */
export interface ScoredHit {
  hit: ArchiveHit;
  access: ArchiveAccess;
  /** Passages that passed the gates and threshold, best first. */
  passages: { text: string; score: number; matched: string[] }[];
  /** The best passage's score. */
  score: number;
}

export interface RankedHits {
  /** Best first, one per work. */
  ranked: ScoredHit[];
  /** Books an editor can read, open or borrowed. */
  available: number;
  /** Of those, how many are borrowed rather than open. */
  borrowable: number;
  rejected: Record<string, number>;
  /** Available books with at least one passage above the threshold. */
  matched: number;
  passages: PassageStats;
}

/**
 * Steps 2–3 and the dedupe, with no I/O: from search hits to the books worth
 * showing. Kept pure so the user script's copy can be checked against it.
 */
export function rankArchiveHits(
  hits: ArchiveHit[],
  claim: string,
  articleTitle: string,
  minScore: number,
): RankedHits {
  const subject = subjectOf(articleTitle);
  const ctx = scoringContext(claim, subject);
  const rejected: Record<string, number> = {};
  let available = 0;
  let borrowable = 0;
  const scored: ScoredHit[] = [];
  const stats: PassageStats = { seen: 0, dropped: {}, bestBelow: null };
  const drop = (reason: string): void => {
    stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1;
  };

  for (const hit of hits) {
    const gate = accessGate(hit);
    if (!gate.ok) {
      rejected[gate.reason] = (rejected[gate.reason] ?? 0) + 1;
      continue;
    }
    available++;
    if (gate.access === "borrow") borrowable++;
    const about = titleIsAbout(hit.title, ctx.subjectTokens);
    const dateline =
      hit.year !== null && hit.collections.includes("periodicals") ? String(hit.year) : null;
    const passages: ScoredHit["passages"] = [];
    for (const text of hit.highlights) {
      stats.seen++;
      const v = judgePassage(text, ctx, about, dateline);
      if ("reason" in v) {
        drop(v.reason);
      } else if (v.score < minScore) {
        drop("below threshold");
        if (!stats.bestBelow || v.score > stats.bestBelow.score) {
          stats.bestBelow = { score: v.score, identifier: hit.identifier, text };
        }
      } else {
        passages.push({ text, score: v.score, matched: v.matched });
      }
    }
    passages.sort((a, b) => b.score - a.score);
    if (passages.length > 0) {
      scored.push({ hit, access: gate.access, passages, score: passages[0].score });
    }
  }

  // Best first — on a tie, a book anyone can open before one to borrow — and
  // then one per work: each later scan of a work already kept is dropped.
  const openFirst = (x: ScoredHit): number => (x.access === "open" ? 0 : 1);
  scored.sort(
    (a, b) => b.score - a.score || openFirst(a) - openFirst(b) || a.hit.rank - b.hit.rank,
  );
  const ranked: ScoredHit[] = [];
  for (const s of scored) {
    if (!ranked.some((kept) => sameWork(kept.hit, s.hit))) ranked.push(s);
  }
  return { ranked, available, borrowable, rejected, matched: scored.length, passages: stats };
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

/**
 * `url-access=registration` for a lending-library book, as InternetArchiveBot
 * writes it: the link works, after signing in with a free account.
 */
export function formatArchiveCitation(
  hit: Pick<ArchiveHit, "identifier" | "title" | "creator" | "year">,
  access: ArchiveAccess,
  details: Pick<ItemDetails, "publisher" | "isbn"> | null,
): Citation {
  const parts = [
    `title=${escapePipes(hit.title)}`,
    hit.creator ? `author=${escapePipes(cleanCreator(hit.creator))}` : null,
    details?.publisher ? `publisher=${escapePipes(details.publisher)}` : null,
    hit.year !== null ? `year=${hit.year}` : null,
    details?.isbn ? `isbn=${escapePipes(details.isbn)}` : null,
    `url=${detailsUrl(hit.identifier)}`,
    access === "borrow" ? "url-access=registration" : null,
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
  details: Pick<ItemDetails, "publisher" | "isbn"> | null,
  terms: ClaimTerms,
): ArchiveCandidate {
  const { hit } = s;
  const best = s.passages[0];
  const matched = compactAnchors(best.matched);
  const byline = [
    s.access === "borrow" ? "Internet Archive (borrow)" : "Internet Archive",
    hit.year,
    hit.creator && cleanCreator(hit.creator),
  ].filter(Boolean).join(", ");
  return {
    url: detailsUrl(hit.identifier),
    title: hit.title,
    relevance: `${byline} — matched ${matched.join(", ") || "claim wording"}`,
    snippet: best.text,
    evidence: {
      origin: "internet-archive",
      identifier: hit.identifier,
      year: hit.year,
      access: s.access,
      passages: s.passages.map((p) => p.text),
      score: s.score,
      matchedAnchors: matched,
      query: hit.query,
      viewerUrl: viewerUrl(hit.identifier, terms),
    },
    citation: formatArchiveCitation(hit, s.access, details),
  };
}

/**
 * One line on the passages, for the console: "180 passages: 120 no subject,
 * 40 no claim number, 20 below threshold (best 0.25 in someid: "…")".
 */
export function passageSummary(p: PassageStats): string {
  const dropped = Object.entries(p.dropped)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
  const best = p.bestBelow
    ? ` (best below: ${p.bestBelow.score} in ${p.bestBelow.identifier}: "${p.bestBelow.text}")`
    : "";
  return `${p.seen} passage(s)` + (dropped ? ` → dropped: ${dropped}` : "") + best;
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

/** How many books survived each step — the numbers that say whether this works. */
export interface ArchiveFunnel {
  queries: string[];
  /** Distinct books the search returned. */
  hits: number;
  /** Books an editor can read, open or borrowed. */
  available: number;
  /** Of those, how many are borrowed rather than open. */
  borrowable: number;
  /** Why the others did not, counted by reason. */
  rejected: Record<string, number>;
  /** Books with a passage above the score threshold. */
  matched: number;
  /** Why the readable books' passages did or did not count. */
  passages: PassageStats;
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
  const maxCandidates = options.maxCandidates ?? 3;
  const terms = claimTerms(claim.claim, articleTitle);
  const queries = buildArchiveQueries(terms).slice(0, options.maxQueries ?? 3);

  const funnel: ArchiveFunnel = {
    queries: [],
    hits: 0,
    available: 0,
    borrowable: 0,
    rejected: {},
    matched: 0,
    passages: { seen: 0, dropped: {}, bestBelow: null },
    lookedUp: 0,
    candidates: 0,
    errors: [],
  };

  // 1. Search, strictest query first, until enough distinct books.
  const hits = new Map<string, ArchiveHit>();
  for (const query of queries) {
    funnel.queries.push(query);
    let response: SearchResponse | null = null;
    try {
      response = await client.fullTextSearch({ query, size: options.maxHits ?? 50 });
    } catch (err) {
      funnel.errors.push(`search failed: ${(err as Error).message}`);
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
    options.minScore ?? 0.3,
  );
  funnel.available = ranked.available;
  funnel.borrowable = ranked.borrowable;
  funnel.rejected = ranked.rejected;
  funnel.matched = ranked.matched;
  funnel.passages = ranked.passages;

  // 4. Metadata for the few kept: publisher, ISBN, and whether it is still
  // readable. A couple of spares, in case one turns out not to be.
  const shortlist = ranked.ranked.slice(0, maxCandidates + 2);
  funnel.lookedUp = shortlist.length;
  const candidates: ArchiveCandidate[] = [];
  for (const s of shortlist) {
    if (candidates.length >= maxCandidates) break;
    let details: ItemDetails | null = null;
    try {
      details = parseItemDetails(await client.metadata(s.hit.identifier));
      const gate = detailsGate(details, s.access);
      if (!gate.ok) {
        funnel.rejected[gate.reason] = (funnel.rejected[gate.reason] ?? 0) + 1;
        continue;
      }
    } catch (err) {
      // The hit already passed the gate; a lead without a publisher is still a lead.
      funnel.errors.push(`metadata ${s.hit.identifier}: ${(err as Error).message}`);
    }
    candidates.push(toArchiveCandidate(s, details, terms));
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

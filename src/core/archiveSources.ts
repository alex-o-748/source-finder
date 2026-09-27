/**
 * Internet Archive source discovery: find a book whose text carries a
 * {{citation needed}} claim, without a model.
 *
 * A funnel, so that at most a handful of books are ever looked at closely:
 *
 *   1. **Search.** Two families of full-text queries side by side, each
 *      strictest first: the claim's numbers and names with the article's
 *      subject, and the claim's key phrases with the subject's words.
 *   2. **Access gate**, on the hit's own fields. What matters is that an
 *      editor can read the passage: an open book, or one in the lending
 *      library, which anyone with a free archive.org account can borrow. Books
 *      only print-disabled readers can open are dropped.
 *   3. **Score.** Each hit comes with its matching passages. Each passage is
 *      scored on its own — two passages from one book may be pages apart — with
 *      the sister-wiki scoring: anchors that must match, then anchors and
 *      weighted token coverage. A book counts as its best passage. A second
 *      ranking counts the claim units (phrases, numbers, names, longer words)
 *      in a passage, without those gates; the two are taken in turn.
 *   4. **Dedupe and look up.** One book per work, however many scans of it the
 *      Archive holds; then, for the few kept, the item metadata: the publisher
 *      and ISBN for the citation, and whether it has been withdrawn.
 *   5. **Whole text**, optional: for a few open books, the best stretch of
 *      the whole OCR text instead of the search's short highlights.
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
  words,
} from "./relevance.js";
import type { Anchors, TokenBag } from "./relevance.js";
import type { ArchiveCandidate, Article, Citation, Claim } from "./types.js";

export interface ArchiveSourceOptions {
  /** Hits requested per full-text query (default 50). */
  maxHits?: number;
  /** Queries from the claim's numbers and names, strictest first (default 3). */
  maxQueries?: number;
  /** Queries from the claim's key phrases, strictest first (default 4). */
  maxPhraseQueries?: number;
  /** Each family of queries stops loosening once it has found this many distinct books (default 10). */
  enoughHits?: number;
  /** Candidates returned per claim from the search (default 4). */
  maxCandidates?: number;
  /**
   * Read the whole OCR text of open books and show the best passage in it
   * instead of the search's ~100-character highlights (default off). Node
   * only for now: see `streamUrl`.
   */
  fullText?: boolean;
  /** Open books whose whole text is read, per claim (default 5). */
  fullTextBooks?: number;
  /** Extra leads found only in a whole text, beyond `maxCandidates` (default 2). */
  fullTextLeads?: number;
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
  /** The claim's key phrases, most telling first (see `keyPhrases`). */
  phrases: string[];
  /** The subject's own words, each searched on its own: "Princess Feodora of Leiningen" → Princess, Feodora, Leiningen. */
  subjectWords: string[];
}

const MAX_QUERY_NUMBERS = 3;
const MAX_QUERY_NAMES = 2;
const MAX_QUERY_PHRASES = 3;

export function subjectOf(title: string): string {
  return title.replace(/_/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Where a key phrase breaks: function words, and common verbs and adverbs — a
 * phrase worth searching verbatim is a noun group ("digestive enzymes",
 * "Ptolemy II Philadelphus"), not "possesses webbed".
 */
const PHRASE_BREAKS = new Set(
  (
    "a an the of in on at to by for from with as is was were be been being are it its this that these those " +
    "and or but not no nor so than then there their they he she his her him them who whom which what when where " +
    "while also has have had do does did can could would should may might will shall must into onto over under " +
    "after before during about between through up down out off such some any all each other more most many much " +
    "very only just even both either neither however although though because since if until unless whether " +
    "one two three four five six seven eight nine ten first second third including include includes " +
    "became become becomes took take takes taken went go goes gone made make makes led lead leads said say says " +
    "called known used using possesses possess possessed considered consider held hold holds given give gave " +
    "found find finds began begin begins started starts start came come comes saw seen see got get gets " +
    "presumably originally initially usually often later still around almost nearly approximately " +
    "contains contain contained included according reported confirmed refer refers referred"
  ).split(/\s+/),
);

/**
 * The claim's key phrases, most telling first: runs of words between
 * punctuation and `PHRASE_BREAKS` (RAKE-style), with a possessive ending its
 * run ("Feodora's father": a book may say "the father of Feodora"). A run of
 * four or more words rarely recurs verbatim, so it is split into overlapping
 * pairs — unless every word is capitalised, which makes it a name. A phrase
 * made only of the subject's words says nothing new and is dropped.
 *
 * The full-text search highlights an exact phrase as one passage, so a
 * two-word phrase is the one way to ask for words that stand together.
 */
export function keyPhrases(claim: string, subject: string): string[] {
  const subjectTokens = tokenSet(subject);
  const tokens = claim
    .replace(/[‘’“”]/g, "'")
    .split(/(\s+|[,;:()."!?–—]+)/)
    .filter((t) => t.trim().length > 0);
  const runs: string[][] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length) runs.push(run);
    run = [];
  };
  for (const t of tokens) {
    if (/^[,;:()."!?–—]+$/.test(t) || PHRASE_BREAKS.has(t.toLowerCase()) || /^'s$/i.test(t)) {
      flush();
      continue;
    }
    const possessive = /'s$/i.test(t);
    const w = t.replace(/^'+|'+$/g, "").replace(/'s$/i, "");
    if (!w) continue;
    run.push(w);
    if (possessive) flush();
  }
  flush();

  const split: string[][] = [];
  for (const r of runs) {
    if (r.length <= 3 || r.every((w) => /^\p{Lu}/u.test(w))) split.push(r.slice(0, 4));
    else for (let i = 0; i + 1 < r.length; i++) split.push(r.slice(i, i + 2));
  }
  const score = (p: string[]): number => {
    const informative = p.filter((w) => !subjectTokens.has(fold(w)));
    if (informative.length === 0) return -1;
    let s = p.length * 2;
    for (const w of informative) {
      if (/\d/.test(w)) s += 3;
      else if (/^\p{Lu}/u.test(w)) s += 2;
      else if (w.length >= 8) s += 1.5;
      else if (w.length >= 5) s += 0.5;
    }
    return s;
  };
  const scored = split
    .filter((p) => p.join(" ").length >= 4)
    .map((p) => ({ phrase: p.join(" "), score: score(p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((x) => x.phrase))];
}

/** The subject's words worth a search term of their own. */
export function subjectWordsOf(subject: string): string[] {
  return words(subject).filter((w) => w.length >= 3 && !PHRASE_BREAKS.has(w.toLowerCase()));
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
    phrases: keyPhrases(claim, subject).slice(0, MAX_QUERY_PHRASES),
    subjectWords: subjectWordsOf(subject),
  };
}

function phrase(term: string): string {
  return `"${term.replace(/["\\]/g, " ").trim()}"`;
}

/**
 * Terms are joined by a space, which the endpoint reads as AND. An explicit
 * `AND` is not safe: between two terms it is taken for the word "and"
 * (`"Feodora" AND "Leiningen"` returns exactly what `"Feodora" "Leiningen"
 * "and"` does, checked live), and the few passages each book comes back with
 * are then spent highlighting "and".
 */
function allOf(terms: string[]): string {
  return terms.join(" ");
}

/**
 * Full-text queries for a claim from its numbers and names, strictest first:
 * the subject with every number and name, then with the numbers only, then
 * with the single strongest anchor. Empty when the claim has no number or name
 * — the subject alone would match every book about it.
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
    .map(allOf);
  return [...new Set(tiers)];
}

/**
 * Full-text queries from the claim's key phrases, strictest first: the
 * subject's words with three phrases, two, one, and last two phrases without
 * the subject (a Wikipedia title is often not how a book names its subject).
 * These also give a claim with no number or name something to search on.
 */
export function buildPhraseQueries(terms: ClaimTerms): string[] {
  const subject = terms.subjectWords.map(phrase);
  const phrases = terms.phrases.map(phrase);
  if (phrases.length === 0) return [];
  const tiers = [
    [...subject, ...phrases.slice(0, 3)],
    [...subject, ...phrases.slice(0, 2)],
    [...subject, phrases[0]],
    phrases.length >= 2 ? phrases.slice(0, 2) : [],
  ]
    .filter((t) => t.length > 0)
    .map(allOf);
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
  /** The text file that matched, without `_djvu.txt`: several volumes can share an item. */
  file: string | null;
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
      file: first(f.file_basename),
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
  /** The best passage came from the book's whole text. */
  fullText?: true;
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
// 3b. Claim units: a second ranking, and reading whole books
// ---------------------------------------------------------------------------

/**
 * The parts of a claim a passage can be checked for. Strong: a key phrase of
 * two or more words, a number, a name that is not the subject's. Weak: a
 * longer content word, and (for whole books) any word of the subject.
 */
export interface ClaimUnit {
  key: string;
  strong: boolean;
  test: (folded: string, have: Set<string>) => boolean;
}

export function claimUnits(
  claim: string,
  subject: string,
  opts: { minWordLength: number; subjectUnit: boolean },
): ClaimUnit[] {
  const subjectTokens = tokenSet(subject);
  const anchors = anchorsOf(claim);
  const units: ClaimUnit[] = [];
  for (const k of keyPhrases(claim, subject).map(fold)) {
    if (k.includes(" ")) units.push({ key: k, strong: true, test: (f) => f.includes(k) });
  }
  const known = (key: string): boolean => units.some((u) => u.key === key);
  for (const n of anchors.numbers) {
    if (known(n)) continue;
    units.push({ key: n, strong: true, test: (f, have) => have.has(n) || f.includes(n) });
  }
  for (const n of anchors.names) {
    if (known(n) || n.split(" ").every((w) => subjectTokens.has(w))) continue;
    units.push({ key: n, strong: true, test: (f, have) => (n.includes(" ") ? f.includes(n) : have.has(n)) });
  }
  for (const w of tokenSet(claim)) {
    if (w.length < opts.minWordLength || subjectTokens.has(w) || /\d/.test(w)) continue;
    // A word inside a phrase still counts alone: the book may not use the phrase.
    if (known(w)) continue;
    units.push({ key: w, strong: false, test: (_f, have) => have.has(w) });
  }
  const subjectWords = [...subjectTokens];
  if (opts.subjectUnit && subjectWords.length > 0) {
    units.push({ key: `[${subject}]`, strong: false, test: (_f, have) => subjectWords.some((w) => have.has(w)) });
  }
  return units;
}

/** The units a text contains; a word already inside a matched phrase is not counted again. */
export function unitsIn(text: string, units: ClaimUnit[]): ClaimUnit[] {
  const f = fold(text);
  const have = tokenSet(text);
  const hit = units.filter((u) => u.test(f, have));
  return hit.filter((u) => !hit.some((o) => o !== u && o.key.includes(" ") && o.key.split(" ").includes(u.key)));
}

/**
 * Books ranked by the claim units in their best passage, in place of the
 * score's gates: a passage needs two units, one of them strong, and need not
 * name the subject or carry the claim's number. This is what finds "The acini
 * secrete several digestive enzymes" for a claim with neither, and a passage
 * that says "Prince of Leiningen" rather than "Feodora". Top three, most units
 * first, then search order.
 */
export function rankByUnits(hits: ArchiveHit[], claim: string, articleTitle: string): ScoredHit[] {
  const units = claimUnits(claim, subjectOf(articleTitle), { minWordLength: 6, subjectUnit: false });
  const out: ScoredHit[] = [];
  for (const hit of hits) {
    const gate = accessGate(hit);
    if (!gate.ok) continue;
    let best: { text: string; matched: ClaimUnit[] } | null = null;
    for (const text of hit.highlights) {
      const matched = unitsIn(text, units);
      if (matched.length >= 2 && matched.some((u) => u.strong) && (!best || matched.length > best.matched.length)) {
        best = { text, matched };
      }
    }
    if (!best) continue;
    const score = Math.round((best.matched.length / units.length) * 100) / 100;
    out.push({
      hit,
      access: gate.access,
      passages: [{ text: best.text, score, matched: best.matched.map((u) => u.key) }],
      score,
    });
  }
  return out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.passages[0].matched.length - a.s.passages[0].matched.length || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.s);
}

/** The two rankings taken in turn, one book per work. */
export function mergeRankings(first: ScoredHit[], second: ScoredHit[]): ScoredHit[] {
  const out: ScoredHit[] = [];
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    for (const s of [first[i], second[i]]) {
      if (s && !out.some((kept) => sameWork(kept.hit, s.hit))) out.push(s);
    }
  }
  return out;
}

/**
 * The OCR text inside archive.org's `/stream/{id}/{file}_djvu.txt` page, one
 * line, words broken at a line end joined again.
 */
export function streamText(html: string): string | null {
  const m = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WINDOW_CHARS = 450;
const WINDOW_STEP = 150;
/** Two strong units, or one and two weak ones. */
const MIN_WINDOW_SCORE = 4;

/**
 * The best ~450-character stretch of a whole book: the most claim units, a
 * strong one counting double; needs a strong unit and a score of four. Of a
 * run of equally good stretches (the same passage seen from a little before
 * and a little after), the middle one, so the passage is not at an edge. Cut
 * at word boundaries.
 */
export function bestWindow(
  text: string,
  claim: string,
  articleTitle: string,
): { text: string; score: number; matched: string[] } | null {
  const units = claimUnits(claim, subjectOf(articleTitle), { minWordLength: 5, subjectUnit: true });
  const most = units.reduce((n, u) => n + (u.strong ? 2 : 1), 0);
  let best: { starts: number[]; score: number; matched: string[] } | null = null;
  let runOpen = false;
  for (let i = 0; i < text.length; i += WINDOW_STEP) {
    const matched = unitsIn(text.slice(i, i + WINDOW_CHARS), units);
    const strong = matched.filter((u) => u.strong).length;
    const score = strong === 0 ? 0 : strong * 2 + (matched.length - strong);
    if (score >= MIN_WINDOW_SCORE && (!best || score > best.score)) {
      best = { starts: [i], score, matched: matched.map((u) => u.key) };
      runOpen = true;
    } else if (best && runOpen && score === best.score) {
      best.starts.push(i);
    } else {
      runOpen = false;
    }
  }
  if (!best) return null;
  const start = best.starts[Math.floor((best.starts.length - 1) / 2)];
  let window = text.slice(start, start + WINDOW_CHARS);
  if (start > 0) window = `…${window.replace(/^\S*\s+/, "")}`;
  if (start + WINDOW_CHARS < text.length) window = `${window.replace(/\s+\S*$/, "")}…`;
  return {
    text: window,
    score: Math.round((best.score / most) * 100) / 100,
    matched: best.matched.filter((k) => !k.startsWith("[")),
  };
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
      ...(s.fullText && { fullText: true as const }),
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
  /** Books ranked by the claim units in a passage (at most three). */
  byUnits: number;
  /** Open books whose whole text was read, and how many held a passage. */
  fullText?: { read: number; windows: number };
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
  const maxCandidates = options.maxCandidates ?? 4;
  const terms = claimTerms(claim.claim, articleTitle);
  const families = [
    buildArchiveQueries(terms).slice(0, options.maxQueries ?? 3),
    buildPhraseQueries(terms).slice(0, options.maxPhraseQueries ?? 4),
  ];

  const funnel: ArchiveFunnel = {
    queries: [],
    hits: 0,
    available: 0,
    borrowable: 0,
    rejected: {},
    matched: 0,
    byUnits: 0,
    passages: { seen: 0, dropped: {}, bestBelow: null },
    lookedUp: 0,
    candidates: 0,
    errors: [],
  };

  // 1. Search: the two families side by side, each strictest first until it
  // has enough distinct books of its own.
  const searchFamily = async (queries: string[]): Promise<{ used: string[]; hits: ArchiveHit[] }> => {
    const used: string[] = [];
    const found = new Map<string, ArchiveHit>();
    for (const query of queries) {
      used.push(query);
      let response: SearchResponse | null = null;
      try {
        response = await client.fullTextSearch({ query, size: options.maxHits ?? 50 });
      } catch (err) {
        funnel.errors.push(`search failed: ${(err as Error).message}`);
      }
      for (const hit of response ? parseSearchHits(response, query) : []) {
        if (!found.has(hit.identifier)) found.set(hit.identifier, hit);
      }
      if (found.size >= (options.enoughHits ?? 10)) break;
    }
    return { used, hits: [...found.values()] };
  };
  const results = await Promise.all(families.map(searchFamily));
  const hits = new Map<string, ArchiveHit>();
  for (const r of results) {
    funnel.queries.push(...r.used);
    for (const hit of r.hits) {
      if (!hits.has(hit.identifier)) hits.set(hit.identifier, { ...hit, rank: hits.size });
    }
  }
  funnel.hits = hits.size;

  // 2–3. Gate, score, one per work — by the passage score, and by claim units.
  const all = [...hits.values()];
  const ranked = rankArchiveHits(all, claim.claim, articleTitle, options.minScore ?? 0.3);
  const byUnits = rankByUnits(all, claim.claim, articleTitle);
  funnel.available = ranked.available;
  funnel.borrowable = ranked.borrowable;
  funnel.rejected = ranked.rejected;
  funnel.matched = ranked.matched;
  funnel.byUnits = byUnits.length;
  funnel.passages = ranked.passages;

  // A couple of spares, in case one turns out not to be readable.
  const shortlist = mergeRankings(ranked.ranked, byUnits).slice(0, maxCandidates + 2);
  const extras: ScoredHit[] = [];
  if (options.fullText) await readWholeBooks(all, shortlist, extras, claim.claim, articleTitle, client, options, funnel);

  // 4. Metadata for the few kept: publisher, ISBN, and whether it is still
  // readable.
  funnel.lookedUp = shortlist.length + extras.length;
  const candidates: ArchiveCandidate[] = [];
  const lookUp = async (list: ScoredHit[], cap: number): Promise<void> => {
    let added = 0;
    for (const s of list) {
      if (added >= cap) break;
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
      added++;
    }
  };
  await lookUp(shortlist, maxCandidates);
  await lookUp(extras, options.fullTextLeads ?? 2);
  funnel.candidates = candidates.length;

  return { claim, candidates, funnel };
}

/**
 * Reads the whole OCR text of open books — those on the shortlist first, then
 * the other open books in search order, `fullTextBooks` in all — and puts the
 * best window of each in front of its passages. A book not on the shortlist
 * whose text has a window becomes an extra lead. Lending-library books are
 * skipped: their text is not public.
 */
async function readWholeBooks(
  hits: ArchiveHit[],
  shortlist: ScoredHit[],
  extras: ScoredHit[],
  claim: string,
  articleTitle: string,
  client: ArchiveClient,
  options: ArchiveSourceOptions,
  funnel: ArchiveFunnel,
): Promise<void> {
  if (!client.streamPage) return;
  const others = hits
    .filter((h) => {
      const gate = accessGate(h);
      return gate.ok && gate.access === "open" && !shortlist.some((s) => sameWork(s.hit, h));
    })
    .filter((h, i, list) => list.findIndex((o) => sameWork(o, h)) === i)
    .map((hit): ScoredHit => ({ hit, access: "open", passages: [], score: 0 }));
  const toRead = [...shortlist.filter((s) => s.access === "open"), ...others].slice(0, options.fullTextBooks ?? 5);
  funnel.fullText = { read: 0, windows: 0 };
  for (const s of toRead) {
    let text: string | null = null;
    try {
      text = streamText(await client.streamPage(s.hit.identifier, s.hit.file ?? s.hit.identifier));
    } catch (err) {
      funnel.errors.push(`text ${s.hit.identifier}: ${(err as Error).message}`);
    }
    if (!text) continue;
    funnel.fullText.read++;
    const window = bestWindow(text, claim, articleTitle);
    if (!window) continue;
    funnel.fullText.windows++;
    s.passages.unshift(window);
    s.score = Math.max(s.score, window.score);
    s.fullText = true;
    if (!shortlist.includes(s)) extras.push(s);
  }
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

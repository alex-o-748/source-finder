/**
 * The librarian: the steps of finding a fact in the Internet Archive that a
 * person does and word matching cannot.
 *
 *   1. **Plan.** Restate the claim with what its paragraph says it is about
 *      ("Feodora's father" is Emich Carl, Prince of Leiningen), and write the
 *      full-text queries a book would match: its wording, not Wikipedia's.
 *   2. **Name books.** The biographies, histories and reference works likely
 *      to state the fact, from the model's knowledge of the literature.
 *   3. **Search inside the shortlist**, once per telling term (the year, the
 *      name): `identifier:(a OR b …)` works inside the full-text search, so one
 *      query returns that term's highlights in every book, borrowable ones too.
 *   4. **Check** every book's passages against the restated claim, in one call,
 *      and keep a verdict only when its quote is in the passages.
 *
 * Measured on the eval set (docs/internet-archive-search-ideas.md): the
 * planner's queries are what find the books; a small model writes them well
 * enough, but only a large one names real books or judges well. The models are
 * open-weight, served through the CNfirmed Worker (its `/hf` route), so the
 * editor needs no key. The user script mirrors this module; the parity tests
 * run both on the same replies.
 */

import { fold } from "./relevance.js";
import type { ClaimTerms } from "./archiveSources.js";

export const WORKER_URL = "https://publicai-proxy.alaexis.workers.dev";

export interface LibrarianModels {
  /** Restates the claim and writes the queries. null turns the step off. */
  planner: string | null;
  /** Names books likely to state the fact. null turns the step off. */
  books: string | null;
  /** Checks the books' passages. null leaves the check to the Verify API. */
  judge: string | null;
}

/**
 * GLM-5.2 for every step: it names real books (gpt-oss-20b, Apertus and the
 * Lift Wing Qwens mostly invent them), judges with 86% precision on the hand
 * labels (gpt-oss-20b: 65%), and plans better than gpt-oss-20b, which pulls
 * the article's name into a claim about something else ("Goodrich 23 price"
 * for a claim about national ticket prices) or gives no plan. About 3 US cents
 * a claim in all, paid by the Worker; "openai/gpt-oss-20b" as the planner
 * costs next to nothing and finds nearly as much.
 */
export const DEFAULT_LIBRARIAN_MODELS: LibrarianModels = {
  planner: "zai-org/GLM-5.2",
  books: "zai-org/GLM-5.2",
  judge: "zai-org/GLM-5.2",
};

/**
 * Output tokens per call, thinking included. The Worker gives up on Hugging
 * Face after 60 seconds, about 8,000 tokens of GLM-5.2, and now and then the
 * model thinks until it runs out (finish_reason "length", no answer): the caps
 * keep a call inside the Worker's minute, and such a call is tried once more.
 */
export const PLAN_MAX_TOKENS = 6000;
export const BOOKS_MAX_TOKENS = 6000;
export const JUDGE_MAX_TOKENS = 7000;
/** Naming books is recall, not reasoning: less thinking, fewer runaways. */
export const BOOKS_EFFORT = "low";
/** Paragraph sent with a claim, in characters. */
export const PARAGRAPH_CHARS = 2000;

export interface ChatClient {
  /** The model's reply text. Throws when there is none. `effort` is sent as `reasoning_effort`. */
  chat(model: string, system: string, user: string, maxTokens: number, effort?: string): Promise<string>;
}

/** The request body for the Worker's `/hf` route. The user script sends the same. */
export function workerRequestBody(model: string, system: string, user: string, maxTokens: number, effort?: string): string {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(effort && { reasoning_effort: effort }),
  });
}

/**
 * The Worker's `/hf` route: Hugging Face Inference Providers, open-weight
 * models on an allowlist, paid for by the Worker. It allows 20 requests a
 * minute per address: a 429 is waited out up to three times. A 5xx (the
 * Worker's own minute ran out) or a reply with no answer is tried once more.
 */
export function workerChatClient(base?: string, sleep = defaultSleep): ChatClient {
  const url = `${(base || process.env.CNFIRMED_PROXY_URL || WORKER_URL).replace(/\/+$/, "")}/hf`;
  return {
    async chat(model, system, user, maxTokens, effort) {
      const body = workerRequestBody(model, system, user, maxTokens, effort);
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const text = await res.text();
        if (workerShouldRetry(res.status, text, attempt)) {
          await sleep(WORKER_RETRY_WAIT_MS * 2 ** attempt);
          continue;
        }
        return workerReplyText(res.status, text);
      }
    },
  };
}

export const WORKER_RETRIES = 3;
export const WORKER_RETRY_WAIT_MS = 10_000;

/** A 429, up to three times; a 5xx or a reply with no answer, once. */
export function workerShouldRetry(status: number, text: string, attempt: number): boolean {
  if (status === 429) return attempt < WORKER_RETRIES;
  if (status >= 500) return attempt < 1;
  return status >= 200 && status < 300 && replyContent(text) === null && attempt < 1;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseReply(text: string): { choices?: { message?: { content?: unknown } }[]; error?: { message?: unknown } | string } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A chat-completions reply's message content, or null when it has none. */
export function replyContent(text: string): string | null {
  const content = parseReply(text)?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content : null;
}

/** The message content of a chat-completions reply, or an error naming why there is none. */
export function workerReplyText(status: number, text: string): string {
  if (status < 200 || status >= 300) {
    const data = parseReply(text);
    const err = data && data.error;
    const message = (err && typeof err === "object" ? err.message : err) || text.slice(0, 200);
    throw new Error(`Worker ${status}: ${String(message)}`);
  }
  const content = replyContent(text);
  if (content === null) throw new Error("Worker: empty reply");
  return content;
}

/**
 * Characters the full-text search's parser rejects or reads as syntax. A "/"
 * starts a regular expression even inside quotes, "~" is proximity, "[" and
 * "]" a range: each fails the query with HTTP 400, as does an unbalanced quote
 * (checked live, 2026-10). ":" and the brackets name fields and groups.
 */
const QUERY_SYNTAX = /[/\\~[\]{}^*?:()!+&|<>=]/g;

/** A term for a quoted phrase: no quotes and none of the parser's syntax. */
export function safeTerm(term: string): string {
  return String(term ?? "").replace(QUERY_SYNTAX, " ").replace(/"/g, " ").replace(/\s+/g, " ").trim();
}

/** A model's query the parser accepts: no syntax characters, quotes balanced, no term starting with "-". */
export function safeQuery(query: string): string {
  let q = String(query ?? "").replace(QUERY_SYNTAX, " ");
  if ((q.match(/"/g) ?? []).length % 2) q = q.replace(/"/g, " ");
  return q
    .replace(/"([^"]*)"/g, (_, inner: string) => (inner.trim() ? `"${inner.trim()}"` : " "))
    .replace(/(^|\s)-+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first JSON object in a reply, whatever surrounds it. */
export function jsonObjectIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clip(text: string, chars: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > chars ? `${t.slice(0, chars)}…` : t;
}

function articleName(title: string): string {
  return String(title).replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// 1. Plan
// ---------------------------------------------------------------------------

export interface ArchivePlan {
  /** The claim as one self-contained sentence. */
  fact: string;
  /** Full-text queries, most specific first. */
  queries: string[];
  /** What a passage stating the claim must mention, each as the wordings a book may use; numbers and names first. */
  terms: string[][];
}

export const PLAN_MAX_QUERIES = 3;

export const PLAN_SYSTEM = `You help a Wikipedia editor find a book on the Internet Archive that states a claim. Work out exactly what must be found, then the words a book would print.

Reply with JSON only:
{"fact": "...", "queries": ["...", "...", "..."], "terms": [["..."], ["...", "..."]]}

- fact: the claim as one self-contained sentence. Replace every pronoun and every phrase that points elsewhere ("her mother", "the city", "his reign", "it") with the name the paragraph gives.
- queries: three queries for a full-text search over the OCR of millions of books. Every space-separated term must appear in the book; put a multi-word term in double quotes. No OR, AND, NEAR or wildcards. Two or three terms each: a name as a book would print it, the specific number or date, one distinctive word. Not Wikipedia's wording, and never a whole clause. Most specific first.
- terms: the three to six things a passage stating the claim must mention, each a list of the ways a book might write it, numbers and names first. The person or thing the claim is about is one of them, by name.

Take every name, number and date from the paragraph and the claim; do not add any from memory.

Example 1. Article: Mary Shelley. Paragraph: "Mary Shelley was born in London on 30 August 1797 to the philosopher William Godwin and the writer Mary Wollstonecraft. Her mother died eleven days after the birth." Claim: "Her mother died eleven days after the birth."
{"fact": "Mary Wollstonecraft, the mother of Mary Shelley, died eleven days after Mary's birth in 1797.", "queries": ["Wollstonecraft died 1797", "Wollstonecraft \\"eleven days\\" daughter", "\\"Mary Wollstonecraft\\" death September 1797"], "terms": [["1797"], ["Wollstonecraft"], ["died", "death"], ["eleven days", "11 days"], ["daughter", "Mary"]]}

Example 2. Article: Golden Gate Bridge. Paragraph: "Joseph Strauss led the design. The bridge opened to vehicle traffic on 28 May 1937, a day after its pedestrian opening." Claim: "The bridge opened to vehicle traffic on 28 May 1937."
{"fact": "The Golden Gate Bridge opened to vehicle traffic on 28 May 1937.", "queries": ["\\"Golden Gate Bridge\\" 1937 traffic", "\\"Golden Gate\\" \\"May 28\\" opened", "\\"Golden Gate\\" 1937 automobiles"], "terms": [["1937"], ["Golden Gate"], ["May 28", "28 May", "28th of May"], ["opened", "opening", "dedicated"], ["traffic", "vehicles", "automobiles", "cars"]]}`;

export interface ClaimInput {
  articleTitle: string;
  section: string | null;
  paragraph: string;
  claim: string;
}

export function planPrompt(c: ClaimInput): string {
  return (
    `Article: ${articleName(c.articleTitle)}\n` +
    `Section: ${c.section || "(lead)"}\n` +
    `Paragraph: ${clip(c.paragraph, PARAGRAPH_CHARS)}\n\n` +
    `Claim: ${c.claim}`
  );
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flat(3).filter((x): x is string | number => typeof x === "string" || typeof x === "number").map(String);
}

/**
 * The plan, or null when the reply has none worth using. Small models nest a
 * term list one level too deep, or return a query as an array; both are read.
 */
export function parsePlan(text: string): ArchivePlan | null {
  const j = jsonObjectIn(text);
  if (!j) return null;
  const fact = typeof j.fact === "string" ? j.fact.replace(/\s+/g, " ").trim() : "";
  const queries = (Array.isArray(j.queries) ? j.queries : [])
    .map((q) => (Array.isArray(q) ? strings(q).join(" ") : typeof q === "string" ? q : ""))
    .map(safeQuery)
    .filter((q) => q.length >= 3);
  const terms = (Array.isArray(j.terms) ? j.terms : [])
    .map((g) => (Array.isArray(g) ? strings(g) : strings([g])))
    .map((g) => [...new Set(g.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length >= 2))])
    .filter((g) => g.length > 0);
  if (!queries.length && !terms.length) return null;
  return { fact, queries: [...new Set(queries)].slice(0, PLAN_MAX_QUERIES), terms: terms.slice(0, 6) };
}

/** A number, then a name, then anything else: what makes a passage about this claim. */
function specificity(group: string[]): number {
  if (group.some((a) => /\d/.test(a))) return 0;
  if (group.some((a) => /^\p{Lu}/u.test(a.trim()))) return 1;
  return 2;
}

export const SHELF_TERMS = 3;

/**
 * The terms to search inside the shortlist for, one query each: the plan's
 * most telling concepts (its first wording of each), or without a plan the
 * claim's own numbers, names and key phrases.
 */
export function tellingTerms(plan: ArchivePlan | null, terms: ClaimTerms): string[] {
  const out: string[] = [];
  const add = (t: string | undefined): void => {
    const v = safeTerm(String(t ?? ""));
    if (v.length >= 2 && !out.some((o) => fold(o) === fold(v))) out.push(v);
  };
  if (plan && plan.terms.length) {
    const ordered = plan.terms.map((g, i) => ({ g, i })).sort((a, b) => specificity(a.g) - specificity(b.g) || a.i - b.i);
    for (const { g } of ordered) add(g[0]);
  } else {
    for (const t of [...terms.numbers, ...terms.names, ...terms.phrases]) add(t);
  }
  return out.slice(0, SHELF_TERMS);
}

/** The plan's concepts that are names (capitalised, no number): who or what the claim is about. */
export function nameConcepts(terms: string[][]): string[][] {
  return terms.filter((g) => specificity(g) === 1);
}

/** Folded words, hyphens as spaces: "Saxe-Coburg-Gotha" holds "Saxe-Coburg". */
function splitKey(text: string): string {
  return fold(String(text ?? "")).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A passage's words two ways, padded: hyphenation joined ("com- pleted"), and hyphens as spaces. */
function wordingsOf(text: string): { joined: string; split: string } {
  return { joined: ` ${quoteKey(text)} `, split: ` ${splitKey(text)} ` };
}

function wordsIn(padded: string, words: string): boolean {
  if (!words) return false;
  if (padded.includes(` ${words} `)) return true;
  return /\p{L}$/u.test(words) && (padded.includes(` ${words}s `) || padded.includes(` ${words}es `));
}

/**
 * Whether a concept's wording is in a passage as whole words, a plural
 * allowed: "23" is not in "1923", nor "Carl" in "Carlisle".
 */
function mentions(t: { joined: string; split: string }, alt: string): boolean {
  return wordsIn(t.joined, quoteKey(alt)) || wordsIn(t.split, splitKey(alt));
}

/** How many of the plan's concepts a passage mentions. */
export function planCoverage(text: string, terms: string[][]): number {
  const t = wordingsOf(text);
  return terms.filter((alts) => alts.some((a) => mentions(t, a))).length;
}

/** The plan's concepts a passage mentions, by their first wording. */
export function planMatched(text: string, terms: string[][]): string[] {
  const t = wordingsOf(text);
  return terms.filter((alts) => alts.some((a) => mentions(t, a))).map((alts) => fold(alts[0]));
}

// ---------------------------------------------------------------------------
// 2. Name books
// ---------------------------------------------------------------------------

export interface NamedBook {
  title: string;
  /** The first author's surname, as the model gave it. */
  author: string | null;
  year: number | null;
}

export const MAX_NAMED_BOOKS = 6;

export const BOOKS_SYSTEM = `You are a reference librarian. A Wikipedia editor needs a published book that states a claim. Name the books most likely to state it: standard biographies, histories, monographs and reference works on the subject, older public-domain works included. Only books you are sure exist; a wrong title wastes a search.

Reply with JSON only: {"books": [{"title": "the book's title", "author": "the first author's surname", "year": 1900}]}, up to six, most likely first.`;

export function booksPrompt(c: ClaimInput): string {
  return `Article: ${articleName(c.articleTitle)}\nParagraph: ${clip(c.paragraph, PARAGRAPH_CHARS)}\n\nClaim: ${c.claim}`;
}

export function parseBooks(text: string): NamedBook[] {
  const j = jsonObjectIn(text);
  const list = j && Array.isArray(j.books) ? j.books : [];
  const out: NamedBook[] = [];
  for (const b of list) {
    if (!b || typeof b !== "object") continue;
    const r = b as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim() : "";
    if (title.length < 3) continue;
    const author = typeof r.author === "string" && r.author.trim() ? r.author.replace(/\s+/g, " ").trim() : null;
    const year = Number.parseInt(String(r.year ?? ""), 10);
    out.push({ title, author, year: Number.isFinite(year) ? year : null });
    if (out.length >= MAX_NAMED_BOOKS) break;
  }
  return out;
}

/** Short title words a catalogue search does without. */
const TITLE_STOPWORDS = new Set(
  "the and for its his her our are was who how why les des der die das und von del los las une con per".split(" "),
);

/**
 * The catalogue search that finds a named book: up to five of the title's
 * words of three letters or more (not "the" or "and": "Roman Art" needs
 * "Art"), and the author's surname, apostrophe kept (O'Brien). Null when the
 * title gives nothing to search on.
 */
export function catalogueQuery(book: NamedBook): string | null {
  const words = book.title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w.toLowerCase()))
    .slice(0, 5);
  if (!words.length) return null;
  const surname =
    (book.author ?? "")
      .trim()
      .split(/\s+/)
      .pop()
      ?.replace(/[\u2018\u2019`]/g, "'")
      .replace(/[^\p{L}'-]/gu, "")
      .replace(/^'+|'+$/g, "") ?? "";
  return `title:(${words.join(" AND ")})${surname.length > 2 ? ` AND creator:(${surname})` : ""}`;
}

// ---------------------------------------------------------------------------
// 3. Search inside the shortlist
// ---------------------------------------------------------------------------

/** Books per shelf query; the search returns one hit per book. */
export const SHELF_SIZE = 20;

/**
 * Whether `identifier:` can find a book in the full-text search. An identifier
 * with a dot (the Digital Library of India's "in.ernet.dli.2015.226985") is
 * never matched, quoted, escaped or not, and one left unquoted in a list
 * empties the whole query: checked live, 2026-10.
 */
export function shelfSearchable(identifier: string): boolean {
  return !identifier.includes(".");
}

/** One query per shelf of books, for one term; each identifier quoted, the unsearchable ones left out. */
export function shelfQueries(term: string, identifiers: string[]): { query: string; size: number }[] {
  const ids = identifiers.filter(shelfSearchable);
  const out: { query: string; size: number }[] = [];
  for (let i = 0; i < ids.length; i += SHELF_SIZE) {
    const shelf = ids.slice(i, i + SHELF_SIZE);
    out.push({ query: `"${term}" identifier:(${shelf.map((id) => `"${id}"`).join(" OR ")})`, size: shelf.length });
  }
  return out;
}

/**
 * A telling term as the book reader's search inside takes it. Unquoted, the
 * words of "Prince Charles" must all be in the book but each paragraph need
 * hold only one of them, so a term of several words is quoted, as a phrase.
 */
export function insideTerm(term: string): string {
  const t = safeTerm(term);
  return t.includes(" ") ? `"${t}"` : t;
}

// ---------------------------------------------------------------------------
// 4. Check
// ---------------------------------------------------------------------------

export interface JudgedBook {
  title: string;
  year: number | null;
  passages: string[];
}

export interface ArchiveVerdict {
  verdict: "supports" | "partial" | "unsupported";
  /** Words from the passages that state the claim; verified to be in them. */
  quote: string;
  reason: string;
}

/** Characters of passages sent per book. */
export const JUDGE_BOOK_CHARS = 1600;

export const JUDGE_SYSTEM = `You decide, for each book, whether its passages state a claim from a Wikipedia article. The passages are OCR text from scans: noisy, and cut mid-sentence.

- "supports": the book's passages state the claim's fact, with its specific content (who, what, and any number or date).
- "partial": they state a substantial part of what the claim asserts (the event but not the date, or one of two facts), enough to cite for that part.
- "no": they are only about the same topic, use the same names or numbers in a different statement, only confirm a background detail of the claim (where a place is, who someone was), or are unrelated.

Be strict: shared words are not support. Judge each book only on its own passages, not on what it probably says elsewhere and not on another book's passages. A book may name a person or place differently from the article (a title instead of a name, another spelling or language); use what you know to connect them.

For "supports" and "partial", quote the words in that book's passages that state it, exactly as written.

Reply with JSON only: {"books": [{"id": "B1", "verdict": "supports", "quote": "...", "why": "one short sentence"}]}, one entry per book, in order.`;

export function judgePrompt(c: ClaimInput & { fact: string | null }, books: JudgedBook[]): string {
  const head =
    `Article: ${articleName(c.articleTitle)}\n` +
    `Claim: ${c.claim}\n` +
    (c.fact && c.fact !== c.claim ? `What the claim says, with the names its paragraph gives: ${c.fact}\n` : "") +
    `The claim's paragraph, for context only: ${clip(c.paragraph, 1200)}\n`;
  const list = books.map((b, i) => {
    let used = 0;
    const lines: string[] = [];
    for (const p of b.passages) {
      const t = clip(p, 600);
      if (used + t.length > JUDGE_BOOK_CHARS && lines.length) break;
      lines.push(`- ${t}`);
      used += t.length;
    }
    return `B${i + 1}. ${clip(b.title, 160)}${b.year ? ` (${b.year})` : ""}\n${lines.join("\n") || "- (no passage)"}`;
  });
  return `${head}\n${list.join("\n\n")}`;
}

/** Folded, hyphenation joined, punctuation dropped: how a quote is looked for in OCR text. */
export function quoteKey(text: string): string {
  return fold(String(text ?? ""))
    .replace(/(\p{L})-\s+(\p{L})/gu, "$1$2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a quote is in the passages, as words: every piece of it between
 * ellipses must be there, and together they must run to three words. A model
 * that cannot point at the words has not read them.
 */
export function quoteInPassages(quote: string, passages: string[]): boolean {
  const pieces = String(quote ?? "")
    .split(/\.\.\.|…|\[\s*\.\.\.\s*\]/)
    .map(quoteKey)
    .filter((p) => p.length > 0);
  if (!pieces.length) return false;
  if (pieces.join(" ").split(" ").length < 3) return false;
  // Compared without spaces: "Saxe- Coburg" broken across OCR lines is
  // "Saxe-Coburg" in the quote, and "Saxe Coburg" if the model drops the hyphen.
  const hay = passages.map(quoteKey).join(" ").replace(/ /g, "");
  return pieces.every((p) => hay.includes(p.replace(/ /g, "")));
}

/**
 * A verdict per book, in order: null where the reply gives none. A
 * "supports" or "partial" whose quote is not in that book's passages is
 * counted as not stating the claim.
 */
export function parseJudgement(text: string, books: JudgedBook[]): (ArchiveVerdict | null)[] {
  const j = jsonObjectIn(text);
  const list = j && Array.isArray(j.books) ? j.books : null;
  if (!list) throw new Error("check: the model gave no verdicts");
  const byId = new Map<string, Record<string, unknown>>();
  list.forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const r = e as Record<string, unknown>;
    const id = String(r.id ?? `B${i + 1}`).trim().toUpperCase();
    if (!byId.has(id)) byId.set(id, r);
  });
  return books.map((b, i) => {
    const r = byId.get(`B${i + 1}`);
    if (!r) return null;
    const v = String(r.verdict ?? "").trim().toLowerCase();
    const reason = typeof r.why === "string" ? r.why.trim() : "";
    const quote = typeof r.quote === "string" ? r.quote.trim() : "";
    if (v === "no" || v === "unsupported") return { verdict: "unsupported", quote: "", reason };
    if (v !== "supports" && v !== "partial") return null;
    if (!quoteInPassages(quote, b.passages)) {
      return { verdict: "unsupported", quote: "", reason: `Not counted: its quote is not in the passages. ${reason}`.trim() };
    }
    return { verdict: v, quote, reason };
  });
}

/**
 * Checks every book's passages against the claim in one call. Throws when the
 * model gives no usable reply, so the caller can fall back to the Verify API.
 */
export async function judgeArchiveBooks(
  c: ClaimInput & { fact: string | null },
  books: JudgedBook[],
  client: ChatClient,
  model: string,
): Promise<(ArchiveVerdict | null)[]> {
  if (!books.length) return [];
  const text = await client.chat(model, JUDGE_SYSTEM, judgePrompt(c, books), JUDGE_MAX_TOKENS);
  return parseJudgement(text, books);
}

/**
 * Ways to find a claim in the Internet Archive, compared on the eval set's
 * book-plausible claims. Each strategy proposes up to five books per claim;
 * every book is then read the same way (searched inside for the claim's most
 * telling terms, all books in one query per term, plus the best stretches of an
 * open book's whole text) and judged by the same model against the claim.
 *
 *   baseline   what the user script proposes today (from results/baseline.json)
 *   baseline+r the same books, read with the shared reader
 *   tavily     a web search engine restricted to archive.org, queried with the claim
 *   tavily-llm the same, queried with the claim restated by a small model
 *   llm-fts    archive.org full-text search, queries written by a small model
 *   topic      catalogue search for books *about* the subject (small-model
 *              queries), then search inside them: what a librarian does
 *   cited      the books the article already cites, found on the Archive, then
 *              searched inside
 *   claude-web Claude with web search restricted to archive.org (paid baseline)
 *
 * The planner (which restates the claim and writes the queries) and the judge
 * are chosen by flag. Results go to eval/experiments/results/<name>.json; every
 * request is cached in eval/cassettes-experiments/ (not committed), so a re-run
 * costs nothing. See docs/internet-archive-search-ideas.md for what this found.
 *
 * Usage:
 *   NODE_USE_ENV_PROXY=1 npx tsx eval/experiments/archive-ideas.ts \
 *     --planner worker|manual|claude   # GPT-OSS-20b via the Worker (default), plans-manual.json, or Claude Haiku
 *     --judge worker|verify|claude     # GPT-OSS-20b (default), the Verify API, or Claude Sonnet
 *     --confirm                        # also ask the Verify API about every book the judge keeps
 *     [--limit N] [--only <claim id prefix>] [--skip a,b] [--name run] [--no-shelf]
 *   NODE_USE_ENV_PROXY=1 npx tsx eval/experiments/archive-ideas.ts --calibrate --judge verify
 *                                      # the judge against the hand labels, on today's leads
 *   npx tsx eval/experiments/review.ts <run> [--supports]   # what the judge kept, for checking by hand
 *
 * claude-web is skipped unless --skip is given (it needs a funded Anthropic
 * key in CNFIRMED_ANTHROPIC_API_KEY).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  type Book,
  type FtsHit,
  catalogue,
  claude,
  fts,
  iaIdentifier,
  jsonOf,
  metadata,
  pool,
  tavily,
  textOf,
  usage,
  verify,
  wholeText,
  workerChat,
  jsonIn,
} from "./lib.js";

const PLANNER = "claude-haiku-5-5";
const JUDGE = "claude-sonnet-5-5";
const AGENT = "claude-sonnet-5-5";
const MAX_LEADS = 5;
const OUT_DIR = process.env.EXP_OUT ?? "eval/experiments/results";

interface EvalClaim {
  id: string;
  title: string;
  revid: number;
  section: string | null;
  claim: string;
  context: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function loadClaims(): EvalClaim[] {
  const claims = JSON.parse(readFileSync("eval/claims.json", "utf8")) as (EvalClaim & { claim: string })[];
  const gold = JSON.parse(readFileSync("eval/gold.json", "utf8")) as Record<string, { claim: string; bookPlausible: boolean }>;
  return claims
    .filter((c) => gold[c.id]?.bookPlausible)
    .map((c) => ({ ...c, claim: gold[c.id].claim }));
}

/** Wikitext → roughly readable prose, for prompts. */
function prose(wikitext: string): string {
  return wikitext
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// The small model's plan: how a librarian would look for this
// ---------------------------------------------------------------------------

interface Plan {
  fact: string;
  fulltext_queries: string[];
  catalogue_queries: string[];
  evidence: string[][];
}

const PLAN_SYSTEM = `You help a Wikipedia editor find a book on the Internet Archive that states a fact. Think like a reference librarian: first work out exactly what must be found, then which books would say it, then the words those books would print.

Reply with JSON only:
{
  "fact": "the claim restated as one self-contained sentence, with pronouns and implied people, places and things named from the paragraph and your own knowledge (\\"Feodora's father died in 1814\\" -> \\"Emich Carl, Prince of Leiningen, the father of Princess Feodora of Leiningen, died in 1814\\")",
  "fulltext_queries": ["three queries for the Archive's full-text search over the OCR of millions of books. Every space-separated term must appear in the book; put a multi-word term in double quotes. No OR, AND, NEAR or wildcards. Two to four terms each. Use the words a book would print, not Wikipedia's phrasing: names in their usual book form, the specific number or date, a distinctive noun. No generic words. Most specific first"],
  "catalogue_queries": ["three short keyword searches over book titles and subjects for books likely to contain the fact: a biography of the person, a history of the place, institution or event, a monograph or reference work on the topic. Keywords only, e.g. Queen Victoria girlhood"],
  "evidence": [["the three to six concepts a passage stating the fact must contain, each a list of the wordings or spellings a book might use", "e.g. [[\\"1814\\"], [\\"died\\", \\"death\\", \\"deceased\\"], [\\"Leiningen\\", \\"Emich\\"], [\\"father\\"]]"]]
}`;

const PLANNER_KIND = flag("--planner") ?? "worker";

// gpt-oss-20b confidently invents names (it gave Feodora's father as "Prince
// August of Hesse-Kassel, who died in 1830"), so it is told to take them from
// the paragraph only.
const WORKER_ADDENDUM = `

Take every name, number and date from the paragraph and the claim; do not add any from memory, since a wrong name sends the search to the wrong books.`;

async function plan(c: EvalClaim): Promise<Plan> {
  const user = `Article: ${c.title}\nSection: ${c.section ?? "(lead)"}\nParagraph: ${prose(c.context).slice(0, 2500)}\n\nClaim needing a source: ${c.claim}`;
  let p: Plan | null;
  if (PLANNER_KIND === "manual") {
    // Plans written by hand, standing in for a capable model (no API credit here).
    const plans = JSON.parse(readFileSync("eval/experiments/plans-manual.json", "utf8")) as Record<string, Plan>;
    p = plans[c.id] ?? null;
  } else if (PLANNER_KIND === "claude") {
    const msg = await claude("planner", {
      model: PLANNER,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: PLAN_SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    p = jsonOf<Plan>(msg);
  } else {
    p = jsonIn<Plan>(await workerChat("planner", PLAN_SYSTEM + WORKER_ADDENDUM, user));
  }
  if (!p) throw new Error(`planner gave no plan for ${c.id}`);
  // Small models sometimes return a query as an array or object.
  p.fulltext_queries = (p.fulltext_queries ?? []).slice(0, 3).map(String);
  p.catalogue_queries = (p.catalogue_queries ?? []).slice(0, 3).map(String);
  // Small models sometimes nest each group one level deeper: [[["1814"]], …].
  p.evidence = (p.evidence ?? [])
    .map((g) => (Array.isArray(g) ? (g as unknown[]).flat(3) : [g]).map(String).filter((x) => x.trim().length > 1))
    .filter((g) => g.length > 0);
  return p;
}

// ---------------------------------------------------------------------------
// The reader: where in a book the claim is
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WIN = 1000;
const STEP = 250;

/**
 * The best stretches of a whole text: windows scored by the evidence concepts
 * they contain, each concept weighted by how rare it is in this book (a word on
 * every page says nothing). Needs two concepts. Up to two, not overlapping.
 */
export function locate(text: string, evidence: string[][], max = 2): string[] {
  const t = fold(text);
  const n = Math.max(1, Math.ceil(t.length / STEP));
  const groups = evidence.map((alts) => {
    const re = new RegExp(alts.map((a) => `(?<![\\p{L}\\p{N}])${escapeRe(fold(a))}(?![\\p{L}\\p{N}])`).join("|"), "gu");
    const pos: number[] = [];
    for (const m of t.matchAll(re)) {
      pos.push(m.index!);
      if (pos.length > 5000) break;
    }
    return pos;
  });
  const specific = evidence.map(isSpecific);
  const weights = groups.map((pos, gi) => {
    const buckets = new Set(pos.map((p) => Math.floor(p / STEP))).size;
    return buckets === 0 ? 0 : (1 + Math.log(n / buckets)) * (specific[gi] ? 2 : 1);
  });
  // Bucket each concept's hits by window start.
  const scores = new Float64Array(n);
  const counts = new Uint8Array(n);
  const hasSpecific = new Uint8Array(n);
  groups.forEach((pos, gi) => {
    const seen = new Set<number>();
    for (const p of pos) {
      const last = Math.floor(p / STEP);
      for (let w = Math.max(0, last - Math.floor(WIN / STEP) + 1); w <= last; w++) {
        if (seen.has(w)) continue;
        seen.add(w);
        scores[w] += weights[gi];
        counts[w]++;
        if (specific[gi]) hasSpecific[w] = 1;
      }
    }
  });
  // Two concepts, one of them a number or a name when the claim has any.
  const needSpecific = specific.some(Boolean);
  const order = [...scores.keys()]
    .filter((w) => counts[w] >= 2 && (!needSpecific || hasSpecific[w]))
    .sort((a, b) => scores[b] - scores[a]);
  const picked: number[] = [];
  for (const w of order) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.abs(p - w) * STEP < WIN)) continue;
    picked.push(w);
  }
  return picked.map((w) => {
    const start = Math.max(0, w * STEP - 100);
    return `…${text.slice(start, w * STEP + WIN + 100).replace(/^\S*\s+/, "").replace(/\s+\S*$/, "")}…`;
  });
}

/** A concept that is a number or a name: what makes a passage about this claim. */
function isSpecific(alts: string[]): boolean {
  return alts.some((a) => /\d/.test(a) || /^\p{Lu}/u.test(a.trim()));
}

/** Concepts, most telling first: numbers, then names, then the rest. */
function bySpecificity(evidence: string[][]): string[][] {
  const rank = (g: string[]) => (g.some((a) => /\d/.test(a)) ? 0 : g.some((a) => /^\p{Lu}/u.test(a.trim())) ? 1 : 2);
  return [...evidence].sort((a, b) => rank(a) - rank(b));
}

/**
 * Search inside a shelf of books at once: `identifier:(a OR b …)` works inside
 * the full-text search, so one query per telling term returns each book's
 * highlights around that term, lending-library books included. Once per term,
 * so the five highlights a book gets are spent around the year or the name
 * rather than around "died".
 */
async function shelfSearch(ids: string[], evidence: string[][]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const terms = bySpecificity(evidence)
    .slice(0, 3)
    .map((g) => g[0])
    .filter(Boolean);
  const shelves: string[][] = [];
  for (let i = 0; i < ids.length; i += 20) shelves.push(ids.slice(i, i + 20));
  await Promise.all(
    shelves.flatMap((shelf) =>
      terms.map(async (x) => {
        const hits = await fts(`"${x.replace(/"/g, "")}" identifier:(${shelf.join(" OR ")})`, shelf.length);
        for (const h of hits) out.set(h.identifier, [...new Set([...(out.get(h.identifier) ?? []), ...h.highlights])]);
      }),
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

interface Lead {
  strategy: string;
  identifier: string;
  title: string;
  year: number | null;
  access: "open" | "borrow";
  /** What the strategy itself came back with: highlights, search snippets, quotes. */
  native: string[];
  /** Best stretches of the whole text (open books). */
  windows: string[];
  verdict?: Verdict;
}

interface Verdict {
  verdict: "supports" | "partial" | "no";
  quote: string;
  why: string;
}

async function toLead(strategy: string, b: Book, native: string[], p: Plan): Promise<Lead | null> {
  const meta = await metadata(b.identifier);
  if (!meta.ok || !meta.access) return null;
  const lead: Lead = {
    strategy,
    identifier: b.identifier,
    title: meta.title,
    year: meta.year,
    access: meta.access,
    native,
    windows: [],
  };
  if (meta.access === "open") {
    const text = await wholeText(b.identifier, b.file);
    if (text) lead.windows = locate(text, p.evidence);
  }
  return lead;
}

function dedupe<T extends { identifier: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.identifier) ? false : (seen.add(x.identifier), true)));
}

/** Interleave several ranked lists. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

async function leadsFrom(strategy: string, books: (Book & { native?: string[] })[], p: Plan, max = MAX_LEADS): Promise<Lead[]> {
  const out: Lead[] = [];
  for (const b of dedupe(books)) {
    if (out.length >= max) break;
    const l = await toLead(strategy, b, b.native ?? [], p);
    if (l) out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

type Strategy = (c: EvalClaim, p: Plan) => Promise<Lead[]>;

function baselineBooks(c: EvalClaim): (Book & { native: string[] })[] {
  const base = JSON.parse(readFileSync("eval/results/baseline.json", "utf8")) as {
    id: string;
    archive: { key: string; title: string; evidence: string[]; where: string }[];
  }[];
  const r = base.find((x) => x.id === c.id);
  return (r?.archive ?? []).map((a) => ({
    identifier: a.key.replace(/^ia:/, ""),
    title: a.title,
    year: null,
    access: a.where.includes("borrow") ? "borrow" : "open",
    native: a.evidence,
  }));
}

async function tavilyBooks(query: string): Promise<(Book & { native: string[] })[]> {
  const results = await tavily({
    query: query.slice(0, 400),
    include_domains: ["archive.org"],
    search_depth: "advanced",
    max_results: 10,
    chunks_per_source: 3,
  });
  const out: (Book & { native: string[] })[] = [];
  for (const r of results) {
    const id = iaIdentifier(r.url);
    if (!id) continue;
    // Stream pages come back as archive.org's navigation, not the book.
    const content = /Save Page Now|Internet Archive Audio/.test(r.content) ? "" : r.content;
    out.push({ identifier: id, title: r.title, year: null, access: "open", native: content ? content.split(" [...] ") : [] });
  }
  return out;
}

/** Concept coverage of a passage, for ranking search hits. */
function coverage(text: string, evidence: string[][]): number {
  const t = fold(text);
  return evidence.filter((alts) => alts.some((a) => t.includes(fold(a)))).length;
}

// Cite-book templates in the article: the books its editors already use.
interface CitedBook {
  title: string;
  last: string | null;
  isbn: string | null;
  inSection: boolean;
}

function templates(wikitext: string, names: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\{\\{\\s*(?:${names.source})\\s*\\|`, "gi");
  for (const m of wikitext.matchAll(re)) {
    let depth = 0;
    let i = m.index!;
    for (; i < wikitext.length - 1; i++) {
      if (wikitext.startsWith("{{", i)) (depth++, i++);
      else if (wikitext.startsWith("}}", i)) {
        depth--;
        i++;
        if (depth === 0) break;
      }
    }
    out.push(wikitext.slice(m.index!, i + 1));
  }
  return out;
}

function field(tpl: string, names: string[]): string | null {
  for (const n of names) {
    const m = new RegExp(`\\|\\s*${n}\\s*=\\s*([^|}]*)`, "i").exec(tpl);
    if (m && m[1].trim()) return prose(m[1]).trim();
  }
  return null;
}

let wikitexts: Map<string, string> | null = null;

/**
 * The article's wikitext as the eval recorded it (Wikipedia answers this
 * sandbox's live requests with 429).
 */
function recordedWikitext(title: string): string {
  if (!wikitexts) {
    wikitexts = new Map();
    for (const f of readdirSync("eval/cassettes/en.wikipedia.org")) {
      const rec = JSON.parse(gunzipSync(readFileSync(`eval/cassettes/en.wikipedia.org/${f}`)).toString("utf8")) as { key: string; body: string };
      if (!rec.key.includes("rvprop=content")) continue;
      try {
        for (const page of JSON.parse(rec.body).query?.pages ?? []) {
          const content = page.revisions?.[0]?.slots?.main?.content;
          if (content) wikitexts.set(page.title, content);
        }
      } catch {
        /* not JSON */
      }
    }
  }
  return wikitexts.get(title) ?? "";
}

async function citedBooks(c: EvalClaim): Promise<CitedBook[]> {
  const text = recordedWikitext(c.title);
  // The claim's section, for "cited nearby".
  let section = "";
  if (c.section) {
    const re = new RegExp(`^=+\\s*${escapeRe(c.section)}\\s*=+\\s*$`, "m");
    const m = re.exec(text);
    if (m) {
      const rest = text.slice(m.index + m[0].length);
      const end = /^==[^=]/m.exec(rest);
      section = end ? rest.slice(0, end.index) : rest;
    }
  }
  const sectionLasts = new Set(
    [...section.matchAll(/\{\{\s*(?:sfn|harvnb|harv|sfnp|rp)\s*\|\s*([^|}]+)/gi)].map((m) => fold(m[1].trim())),
  );
  const books: CitedBook[] = [];
  const seen = new Set<string>();
  for (const tpl of templates(text, /cite book|citation/)) {
    const title = field(tpl, ["title"]);
    if (!title) continue;
    const isBookish = /cite book/i.test(tpl) || /\|\s*(isbn|publisher)\s*=/i.test(tpl);
    if (!isBookish) continue;
    const key = fold(title);
    if (seen.has(key)) continue;
    seen.add(key);
    const last = field(tpl, ["last", "last1", "author", "author1", "editor-last", "editor1-last", "editor"]);
    const isbn = field(tpl, ["isbn", "ISBN"]);
    books.push({
      title,
      last,
      isbn: isbn ? isbn.replace(/[^0-9Xx]/g, "") : null,
      inSection: section.includes(tpl) || (last != null && sectionLasts.has(fold(last.split(",")[0]))),
    });
  }
  return books.sort((a, b) => Number(b.inSection) - Number(a.inSection));
}

async function findOnArchive(b: CitedBook): Promise<Book | null> {
  if (b.isbn) {
    const hits = await catalogue(`isbn:${b.isbn}`, 3);
    if (hits[0]) return hits[0];
  }
  const words = b.title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
  if (words.length === 0) return null;
  const last = b.last?.split(/[,\s]/)[0];
  const q = `title:(${words.join(" AND ")})${last && last.length > 2 ? ` AND creator:(${last})` : ""}`;
  const hits = await catalogue(q, 3);
  return hits[0] ?? null;
}

const AGENT_SYSTEM = `You find sources for Wikipedia claims in books on the Internet Archive (archive.org). Search archive.org for a book whose text states the claim, the way a reference librarian would: think about which books would cover it, search for them, and look for the passage. Only books on archive.org count. When done, reply with JSON only: {"books": [{"url": "the archive.org URL", "quote": "the words in the book that state the claim"}]}, up to three, best first, or {"books": []}.`;

async function claudeWeb(c: EvalClaim): Promise<(Book & { native: string[] })[]> {
  const msg = await claude("claude-web", {
    model: AGENT,
    max_tokens: 16000,
    output_config: { effort: "low" },
    system: AGENT_SYSTEM,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5, allowed_domains: ["archive.org"] }],
    messages: [
      {
        role: "user",
        content: `Article: ${c.title}\nParagraph: ${prose(c.context).slice(0, 2000)}\n\nClaim: ${c.claim}`,
      },
    ],
  });
  // Text the search actually returned, by URL: the model's citations.
  const cited = new Map<string, string[]>();
  for (const b of msg.content as unknown as { type: string; citations?: { url?: string; cited_text?: string }[] }[]) {
    for (const ct of b.citations ?? []) {
      if (!ct.url || !ct.cited_text) continue;
      const id = iaIdentifier(ct.url);
      if (id) cited.set(id, [...(cited.get(id) ?? []), ct.cited_text]);
    }
  }
  const answer = jsonOf<{ books?: { url: string; quote?: string }[] }>(msg);
  const out: (Book & { native: string[] })[] = [];
  for (const b of answer?.books ?? []) {
    const id = iaIdentifier(b.url);
    if (!id) continue;
    out.push({ identifier: id, title: id, year: null, access: "open", native: cited.get(id) ?? [] });
  }
  return out;
}

// A shortlist of books named by the model, as a librarian would from memory.
interface NamedBook {
  title: string;
  author?: string;
  year?: number | string;
}

const BOOKS_SYSTEM = `You are a reference librarian. A Wikipedia editor needs a published book that states a fact. Name the books most likely to state it: standard biographies, histories, monographs and reference works on the subject, older public-domain works included. Only books you are sure exist; a wrong title wastes a search.

Reply with JSON only: {"books": [{"title": "the book's title", "author": "the first author's surname", "year": 1900}]}, up to six, most likely first.`;

/** What happened to each claim's named books, for the report. */
export const shortlists: Record<string, { named: NamedBook[]; found: string[] }> = {};

async function namedBooks(c: EvalClaim, p: Plan): Promise<NamedBook[]> {
  if (PLANNER_KIND === "manual") {
    const lists = JSON.parse(readFileSync("eval/experiments/books-manual.json", "utf8")) as Record<string, NamedBook[]>;
    return lists[c.id] ?? [];
  }
  const user = `Article: ${c.title}\nParagraph: ${prose(c.context).slice(0, 2000)}\n\nClaim: ${c.claim}\nThe claim, with the names it implies filled in: ${p.fact}`;
  const r = jsonIn<{ books?: NamedBook[] }>(await workerChat("planner", BOOKS_SYSTEM, user, 16000));
  return (r?.books ?? []).filter((b) => b && typeof b.title === "string").slice(0, 6);
}

const STRATEGIES: Record<string, Strategy> = {
  baseline: async (c) =>
    baselineBooks(c).map((b) => ({ strategy: "baseline", ...b, title: b.title, windows: [] }) as Lead),
  "baseline+r": async (c, p) => leadsFrom("baseline+r", baselineBooks(c), p),
  tavily: async (c, p) => leadsFrom("tavily", await tavilyBooks(`${c.title}: ${c.claim}`), p),
  "tavily-llm": async (_c, p) => leadsFrom("tavily-llm", await tavilyBooks(p.fact), p),
  "llm-fts": async (_c, p) => {
    const lists = await Promise.all(p.fulltext_queries.map((q) => fts(q, 25)));
    const hits = interleave(lists).map((h: FtsHit) => ({ ...h, native: h.highlights, score: coverage(h.highlights.join(" "), p.evidence) }));
    // Best-covered first; ties keep the search's order.
    const ranked = dedupe(hits).sort((a, b) => b.score - a.score);
    return leadsFrom("llm-fts", ranked, p);
  },
  topic: async (_c, p) => {
    // Titles and subject headings only: across all metadata the search drifts.
    const fielded = (q: string) => {
      const w = q.replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim().split(/\s+/).join(" AND ");
      return `title:(${w}) OR subject:(${w})`;
    };
    const lists = await Promise.all(p.catalogue_queries.map((q) => catalogue(fielded(q), 8)));
    return leadsFrom("topic", interleave(lists), p);
  },
  cited: async (c, p) => {
    const books = await citedBooks(c);
    const found: Book[] = [];
    for (const b of books.slice(0, 15)) {
      if (found.length >= MAX_LEADS) break;
      const hit = await findOnArchive(b);
      if (hit) found.push(hit);
    }
    return leadsFrom("cited", found, p);
  },
  "claude-web": async (c, p) => leadsFrom("claude-web", await claudeWeb(c), p),
  "llm-books": async (c, p) => {
    const named = await namedBooks(c, p);
    const found: Book[] = [];
    for (const b of named) {
      const surname = String(b.author ?? "").trim().split(/\s+/).pop() ?? null;
      const hit = await findOnArchive({ title: String(b.title), last: surname || null, isbn: null, inSection: false });
      if (hit) found.push(hit);
    }
    shortlists[c.id] = { named, found: found.map((b) => b.identifier) };
    return leadsFrom("llm-books", found, p, 8);
  },
};

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `You decide whether passages from one book state a claim from a Wikipedia article. The passages are OCR text from a scan and may be noisy or cut mid-sentence.

- "supports": the passages state the claim's fact, with its specific content (who, what, and any number or date).
- "partial": the passages state a substantial part of the claim (for example the event but not the date, or one of two facts), enough to cite for that part.
- "no": the passages are only about the same topic, use the same names or numbers in a different statement, or are unrelated.

Be strict: shared words are not support, and you judge only what is written in the passages, not what the book probably says elsewhere.

Reply with JSON only: {"verdict": "supports" | "partial" | "no", "quote": "the exact words from the passages that state it, or an empty string", "why": "one short sentence"}`;

function evidenceOf(l: { native: string[]; windows: string[] }): string {
  const native = l.native.join("\n…\n").slice(0, 3000);
  return [native, ...l.windows].filter(Boolean).join("\n\n---\n\n");
}

const JUDGE_KIND = flag("--judge") ?? "worker";

async function judge(c: EvalClaim, l: { title: string; year: number | null; native: string[]; windows: string[] }, fact?: string): Promise<Verdict> {
  if (!l.native.join("").trim() && !l.windows.length) return { verdict: "no", quote: "", why: "No passage." };
  if (JUDGE_KIND === "verify") {
    // As the user script sends it: the passages one per line, no title or year.
    const content = [...l.native, ...l.windows].join("\n").slice(0, 12_000);
    const r = await verify(fact || c.claim, content);
    const v = String(r?.verdict ?? "").toUpperCase();
    return {
      verdict: v === "SUPPORTED" ? "supports" : v === "PARTIALLY SUPPORTED" ? "partial" : "no",
      quote: r?.verified_text ?? "",
      why: r?.comments ?? (r ? "" : "422: source unusable"),
    };
  }
  const resolved = fact ? `\nThe same claim with the names it implies filled in from its article (use this only to know who or what the claim is about): ${fact}` : "";
  const user = `Article: ${c.title}\nClaim: ${c.claim}${resolved}\nThe claim's paragraph, for context only: ${prose(c.context).slice(0, 1200)}\n\nBook: ${l.title}${l.year ? ` (${l.year})` : ""}\nPassages:\n${evidenceOf(l)}`;
  if (JUDGE_KIND === "worker") {
    const v = jsonIn<Verdict>(await workerChat("judge", JUDGE_SYSTEM, user, 4000));
    return v && ["supports", "partial", "no"].includes(v.verdict) ? v : { verdict: "no", quote: "", why: "unparsed" };
  }
  const msg = await claude("judge", {
    model: JUDGE,
    max_tokens: 3000,
    output_config: { effort: "low" },
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const v = jsonOf<Verdict>(msg);
  return v && ["supports", "partial", "no"].includes(v.verdict) ? v : { verdict: "no", quote: "", why: `unparsed: ${textOf(msg).slice(0, 100)}` };
}

// ---------------------------------------------------------------------------
// Calibration: the judge against the hand labels, on the baseline's leads
// ---------------------------------------------------------------------------

async function calibrate(claims: EvalClaim[]): Promise<void> {
  const labels = JSON.parse(readFileSync("eval/labels.json", "utf8")) as Record<string, Record<string, { verdict: string }>>;
  const m: Record<string, Record<string, number>> = {};
  await pool(claims, 4, async (c) => {
    for (const b of baselineBooks(c)) {
      const label = labels[c.id]?.[`ia:${b.identifier}`]?.verdict ?? "?";
      const v = await judge(c, { title: b.title, year: null, native: b.native, windows: [] });
      const row = (m[label] ??= {});
      row[v.verdict] = (row[v.verdict] ?? 0) + 1;
      if ((label === "supports" || label === "partial") !== (v.verdict !== "no"))
        console.log(`  disagree ${c.title} | ${b.identifier} | label ${label} | judge ${v.verdict}: ${v.why.slice(0, 160)}`);
    }
  });
  console.log(`\nlabel → ${JUDGE_KIND} verdicts`);
  for (const [label, row] of Object.entries(m)) console.log(`  ${label.padEnd(10)} ${JSON.stringify(row)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ClaimResult {
  id: string;
  title: string;
  claim: string;
  plan: Plan;
  leads: Lead[];
  /** Per book: the verdict on everything any strategy found in it. */
  verdicts: Record<string, Verdict>;
  /** The Verify API's verdict on the books the first judge kept (--confirm). */
  confirmed: Record<string, Verdict>;
  errors: string[];
}

async function main(): Promise<void> {
  let claims = loadClaims();
  if (flag("--only")) claims = claims.filter((c) => c.id.startsWith(flag("--only")!));
  if (flag("--ids")) {
    const prefixes = flag("--ids")!.split(",");
    claims = claims.filter((c) => prefixes.some((x) => c.id.startsWith(x)));
  }
  if (flag("--limit")) claims = claims.slice(0, Number(flag("--limit")));
  if (args.includes("--calibrate")) return calibrate(claims);
  const skip = new Set((flag("--skip") ?? "claude-web").split(",").filter(Boolean));
  const names = Object.keys(STRATEGIES).filter((s) => !skip.has(s));
  console.log(`${claims.length} claims × ${names.join(", ")}; planner ${PLANNER_KIND}, judge ${JUDGE_KIND}`);

  const results = await pool(claims, 4, async (c, i) => {
    const r: ClaimResult = { id: c.id, title: c.title, claim: c.claim, plan: { fact: "", fulltext_queries: [], catalogue_queries: [], evidence: [] }, leads: [], verdicts: {}, confirmed: {}, errors: [] };
    try {
      r.plan = await plan(c);
    } catch (e) {
      r.errors.push(`plan: ${(e as Error).message}`);
    }
    await Promise.all(
      names.map(async (s) => {
        try {
          r.leads.push(...(await STRATEGIES[s](c, r.plan)));
        } catch (e) {
          r.errors.push(`${s}: ${(e as Error).message}`);
        }
      }),
    );
    // Search inside every book any strategy proposed, in one query per term.
    if (!args.includes("--no-shelf")) {
      try {
        const shelf = await shelfSearch([...new Set(r.leads.filter((l) => l.strategy !== "baseline").map((l) => l.identifier))], r.plan.evidence);
        for (const l of r.leads) if (l.strategy !== "baseline") l.native = [...new Set([...l.native, ...(shelf.get(l.identifier) ?? [])])];
      } catch (e) {
        r.errors.push(`shelf: ${(e as Error).message}`);
      }
    }
    // One verdict per book, on the union of what every strategy found in it:
    // in a combined pipeline the passages would be pooled the same way.
    const byBook = new Map<string, Lead[]>();
    for (const l of r.leads) if (l.strategy !== "baseline") byBook.set(l.identifier, [...(byBook.get(l.identifier) ?? []), l]);
    for (const [id, ls] of byBook) {
      const native = [...new Set(ls.flatMap((l) => l.native))];
      const windows = [...new Set(ls.flatMap((l) => l.windows))];
      r.verdicts[id] = await judge(c, { title: ls[0].title, year: ls[0].year, native, windows }, r.plan.fact);
    }
    for (const l of r.leads) l.verdict = l.strategy === "baseline" ? await judge(c, l) : r.verdicts[l.identifier];
    // Second opinion from the production check, on what the first judge kept.
    if (args.includes("--confirm")) {
      for (const [id, v] of Object.entries(r.verdicts)) {
        if (v.verdict === "no") continue;
        const ls = byBook.get(id)!;
        const content = [...new Set(ls.flatMap((l) => [...l.native, ...l.windows]))].join("\n").slice(0, 12_000);
        // The claim with its names resolved: "Feodora's father" is Emich Carl.
        const res = await verify(r.plan.fact || c.claim, content);
        const vv = String(res?.verdict ?? "").toUpperCase();
        r.confirmed[id] = {
          verdict: vv === "SUPPORTED" ? "supports" : vv === "PARTIALLY SUPPORTED" ? "partial" : "no",
          quote: res?.verified_text ?? "",
          why: res?.comments ?? "",
        };
      }
    }
    const good = r.leads.filter((l) => l.verdict?.verdict !== "no").map((l) => `${l.strategy}:${l.verdict?.verdict}`);
    console.log(`[${i + 1}/${claims.length}] ${c.title}: ${good.join(" ") || "nothing"}${r.errors.length ? ` (errors: ${r.errors.join("; ")})` : ""}`);
    return r;
  });

  mkdirSync(OUT_DIR, { recursive: true });
  for (const r of results) if (shortlists[r.id]) (r as ClaimResult & { shortlist?: unknown }).shortlist = shortlists[r.id];
  writeFileSync(`${OUT_DIR}/${flag("--name") ?? "latest"}.json`, JSON.stringify(results, null, 1));
  report(results, names, claims.length);
}

function report(results: ClaimResult[], names: string[], n: number): void {
  const pct = (x: number) => `${Math.round((100 * x) / n)}%`;
  const combos: Record<string, (l: Lead) => boolean> = Object.fromEntries(names.map((s) => [s, (l: Lead) => l.strategy === s]));
  combos["all new (no baseline)"] = (l) => !l.strategy.startsWith("baseline");
  combos["all"] = () => true;
  const rows = Object.entries(combos).map(([s, pick]) => {
    let found = 0;
    let partly = 0;
    let any = 0;
    let leads = 0;
    let good = 0;
    for (const r of results) {
      const ls = r.leads.filter(pick);
      leads += ls.length;
      good += ls.filter((l) => l.verdict?.verdict !== "no").length;
      if (ls.length) any++;
      if (ls.some((l) => l.verdict?.verdict === "supports")) found++;
      if (ls.some((l) => l.verdict?.verdict !== "no")) partly++;
    }
    return `| ${s} | ${pct(found)} (${found}) | ${pct(partly)} (${partly}) | ${pct(any)} | ${leads ? Math.round((100 * good) / leads) : 0}% of ${leads} |`;
  });
  console.log(`\n| Strategy | States it | States it or part | Any lead | Leads judged good |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}`);
  if (results.some((r) => Object.keys(r.confirmed).length)) {
    // Both judges agree it is good; the Verify API's verdict decides which kind.
    const both = (r: ClaimResult, l: Lead) => (l.strategy === "baseline" ? undefined : r.confirmed[l.identifier]?.verdict);
    const crow = Object.entries(combos).map(([s, pick]) => {
      let found = 0;
      let partly = 0;
      for (const r of results) {
        const ls = r.leads.filter(pick);
        if (ls.some((l) => both(r, l) === "supports")) found++;
        if (ls.some((l) => both(r, l) === "supports" || both(r, l) === "partial")) partly++;
      }
      return `| ${s} | ${pct(found)} (${found}) | ${pct(partly)} (${partly}) |`;
    });
    console.log(`\nKept by both judges:\n| Strategy | States it | States it or part |\n| --- | --- | --- |\n${crow.join("\n")}`);
  }
  console.log("\nCalls:");
  for (const [tag, u] of Object.entries(usage)) console.log(`  ${tag}: ${u.calls} calls, ${u.input} in / ${u.output} out tokens`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

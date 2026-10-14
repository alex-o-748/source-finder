/**
 * Shared plumbing for the Internet Archive search experiments: a disk cache,
 * polite per-host HTTP, the archive.org endpoints, Tavily, and Claude.
 *
 * Everything is cached by request, so a re-run costs nothing and a strategy
 * can be changed without paying again for the others.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { stripHighlight, streamText, yearOf } from "../../src/core/archiveSources.js";

export const CACHE_DIR = process.env.EXP_CACHE ?? "eval/cassettes-experiments";

function cachePath(key: string): string {
  const h = createHash("sha1").update(key).digest("hex");
  return join(CACHE_DIR, h.slice(0, 2), `${h}.json.gz`);
}

export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = cachePath(key);
  if (existsSync(p)) return JSON.parse(gunzipSync(readFileSync(p)).toString("utf8")) as T;
  const v = await fn();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, gzipSync(JSON.stringify(v)));
  return v;
}

// ---------------------------------------------------------------------------
// HTTP: a few requests in flight per host, retried on 429/5xx.
// ---------------------------------------------------------------------------

const inFlight = new Map<string, number>();
const waiters = new Map<string, (() => void)[]>();
const LIMITS: Record<string, number> = {
  "archive.org": 4,
  "archive.org#fts": Number(process.env.FTS_CONCURRENCY ?? 4),
  "api.tavily.com": 4,
  "en.wikipedia.org": 2,
  "publicai-proxy.alaexis.workers.dev": 3,
  "citation-verifier.toolforge.org": 2,
};

async function acquire(host: string): Promise<void> {
  const limit = LIMITS[host] ?? 4;
  if ((inFlight.get(host) ?? 0) < limit) {
    inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
    return;
  }
  await new Promise<void>((r) => waiters.set(host, [...(waiters.get(host) ?? []), r]));
  inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
}
function release(host: string): void {
  inFlight.set(host, (inFlight.get(host) ?? 1) - 1);
  const q = waiters.get(host);
  const next = q?.shift();
  if (next) next();
}

const UA = "CNfirmed-experiments/0.1 (https://github.com/alex-o-748/source-finder)";

export async function http(
  url: string,
  init: RequestInit = {},
  timeoutMs = 90_000,
): Promise<{ status: number; body: string }> {
  // The full-text search takes ~25 s a query; it gets its own lane so the
  // fast archive.org calls (metadata, catalogue, texts) do not queue behind it.
  const host = url.includes("/services/search/beta/") ? "archive.org#fts" : new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    await acquire(host);
    let res: Response | null = null;
    let err: unknown = null;
    try {
      res = await fetch(url, {
        ...init,
        headers: { "user-agent": UA, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        err = new Error(`HTTP ${res.status}`);
      } else {
        return { status: res.status, body };
      }
    } catch (e) {
      err = e;
    } finally {
      release(host);
    }
    if (attempt >= 4) throw err;
    const wait = Number(res?.headers.get("retry-after")) || 2 ** attempt * 3;
    await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
  }
}

// ---------------------------------------------------------------------------
// archive.org
// ---------------------------------------------------------------------------

export type Access = "open" | "borrow";

export interface Book {
  identifier: string;
  title: string;
  year: number | null;
  access: Access;
  /** Volume whose OCR text matched, when known. */
  file?: string;
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
}

/** Lending library → borrow; print-disabled only → unreadable (null); else open. */
export function accessOf(collections: string[], mediatype?: string): Access | null {
  if (mediatype && mediatype !== "texts") return null;
  if (collections.some((c) => c === "inlibrary" || c === "lendinglibrary")) return "borrow";
  if (collections.includes("printdisabled")) return null;
  return "open";
}

export interface FtsHit extends Book {
  highlights: string[];
}

/** archive.org's own full-text search (what the user script uses). */
export async function fts(query: string, size = 25): Promise<FtsHit[]> {
  const params = new URLSearchParams({ service_backend: "fts", user_query: query, hits_per_page: String(size) });
  const url = `https://archive.org/services/search/beta/page_production/?${params}`;
  const r = await cached(`fts:${query}:${size}`, async () => {
    const res = await http(url, {}, 120_000);
    if (res.status !== 200) return { error: res.status, hits: [] as unknown[] };
    const j = JSON.parse(res.body);
    return { hits: (j?.response?.body?.hits?.hits ?? []) as unknown[] };
  });
  const out: FtsHit[] = [];
  for (const h of r.hits as { fields?: Record<string, unknown>; highlight?: { text?: unknown } }[]) {
    const f = h.fields ?? {};
    const access = accessOf(arr(f.collection), arr(f.mediatype)[0]);
    if (!access) continue;
    out.push({
      identifier: arr(f.identifier)[0],
      title: arr(f.title)[0] ?? arr(f.identifier)[0],
      year: yearOf(f.year) ?? yearOf(f.date),
      access,
      file: arr(f.file_basename)[0],
      highlights: arr(h.highlight?.text).map(stripHighlight).filter(Boolean),
    });
  }
  return out;
}

/** Catalogue (metadata) search: titles, subjects, descriptions. Fast. */
export async function catalogue(q: string, rows = 10): Promise<Book[]> {
  const params = new URLSearchParams({ q: `(${q}) AND mediatype:texts`, rows: String(rows), output: "json" });
  for (const f of ["identifier", "title", "year", "date", "collection", "mediatype"]) params.append("fl[]", f);
  const url = `https://archive.org/advancedsearch.php?${params}`;
  const r = await cached(`adv:${q}:${rows}`, async () => {
    const res = await http(url);
    if (res.status !== 200) return { docs: [] as unknown[] };
    return { docs: (JSON.parse(res.body)?.response?.docs ?? []) as unknown[] };
  });
  const out: Book[] = [];
  for (const d of r.docs as Record<string, unknown>[]) {
    const access = accessOf(arr(d.collection), arr(d.mediatype)[0]);
    if (!access) continue;
    out.push({ identifier: String(d.identifier), title: arr(d.title)[0] ?? String(d.identifier), year: yearOf(d.year) ?? yearOf(d.date), access });
  }
  return out;
}

/** How many catalogue records match, whatever their access: does the book exist on the Archive at all? */
export async function catalogueCount(q: string): Promise<number> {
  const params = new URLSearchParams({ q: `(${q}) AND mediatype:texts`, rows: "0", output: "json" });
  const r = await cached(`advcount:${q}`, async () => {
    const res = await http(`https://archive.org/advancedsearch.php?${params}`);
    return { n: res.status === 200 ? Number(JSON.parse(res.body)?.response?.numFound ?? 0) : 0 };
  });
  return r.n;
}

export interface Meta {
  ok: boolean;
  title: string;
  year: number | null;
  access: Access | null;
  djvu: string[];
  isbn: string[];
}

export async function metadata(identifier: string): Promise<Meta> {
  return cached(`meta:${identifier}`, async () => {
    const res = await http(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    if (res.status !== 200) return { ok: false, title: identifier, year: null, access: null, djvu: [], isbn: [] };
    const j = JSON.parse(res.body);
    const md = j.metadata ?? {};
    const files = (j.files ?? []) as { name: string }[];
    return {
      ok: !!j.metadata && !j.is_dark,
      title: arr(md.title)[0] ?? identifier,
      year: yearOf(md.year) ?? yearOf(md.date),
      access: accessOf(arr(md.collection), arr(md.mediatype)[0]),
      djvu: files.filter((f) => f.name.endsWith("_djvu.txt")).map((f) => f.name.replace(/_djvu\.txt$/, "")),
      isbn: arr(md.isbn),
    };
  });
}

/** An open book's whole OCR text, or null (lending-library books have none public). */
export async function wholeText(identifier: string, file?: string): Promise<string | null> {
  const meta = await metadata(identifier);
  if (meta.access !== "open") return null;
  const vol = file && meta.djvu.includes(file) ? file : meta.djvu[0];
  if (!vol) return null;
  const r = await cached(`text:${identifier}/${vol}`, async () => {
    const url = `https://archive.org/stream/${encodeURIComponent(identifier)}/${encodeURIComponent(vol)}_djvu.txt`;
    const res = await http(url, {}, 120_000);
    if (res.status !== 200) return { text: null as string | null };
    return { text: streamText(res.body) };
  });
  return r.text;
}

// ---------------------------------------------------------------------------
// Tavily (key injected by the network proxy here; via the Worker in production)
// ---------------------------------------------------------------------------

export interface TavilyResult {
  url: string;
  title: string;
  content: string;
}

export async function tavily(body: Record<string, unknown>): Promise<TavilyResult[]> {
  const r = await cached(`tavily:${JSON.stringify(body)}`, async () => {
    const res = await http("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) return { results: [] as TavilyResult[], error: res.status };
    return { results: (JSON.parse(res.body).results ?? []) as TavilyResult[] };
  });
  return r.results;
}

// ---------------------------------------------------------------------------
// Google Books (needs a key: GOOGLE_BOOKS_API_KEY, or one the network proxy
// injects for books.googleapis.com; without one the quota is zero)
// ---------------------------------------------------------------------------

export interface GbVolume {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  isbns: string[];
  /** Google's snippet around the match, as plain text. */
  snippet: string;
  /** NO_PAGES, PARTIAL, ALL_PAGES: how much of the book Google shows. */
  viewability: string;
  link: string;
}

function unhtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Google Books full-text search: relevance-ranked volumes with a snippet each. */
export async function googleBooks(q: string, max = 10): Promise<GbVolume[]> {
  const params = new URLSearchParams({
    q,
    maxResults: String(max),
    printType: "books",
    fields:
      "items(id,volumeInfo(title,authors,publishedDate,industryIdentifiers,canonicalVolumeLink),accessInfo(viewability),searchInfo(textSnippet))",
  });
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const r = await cached(`gbooks:${q}:${max}`, async () => {
    const res = await http(`https://www.googleapis.com/books/v1/volumes?${params}`, key ? { headers: { "x-goog-api-key": key } } : {});
    // Not cached: a missing key or a spent quota is not an answer.
    if (res.status !== 200) throw new Error(`Google Books HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    return { items: (JSON.parse(res.body).items ?? []) as unknown[] };
  });
  return (r.items as Record<string, any>[]).map((it) => {
    const vi = it.volumeInfo ?? {};
    return {
      id: String(it.id),
      title: String(vi.title ?? ""),
      authors: arr(vi.authors),
      year: yearOf(vi.publishedDate),
      isbns: ((vi.industryIdentifiers ?? []) as { type: string; identifier: string }[])
        .filter((x) => x.type === "ISBN_13" || x.type === "ISBN_10")
        .map((x) => x.identifier),
      snippet: unhtml(String(it.searchInfo?.textSnippet ?? "")),
      viewability: String(it.accessInfo?.viewability ?? ""),
      link: String(vi.canonicalVolumeLink ?? `https://books.google.com/books?id=${it.id}`),
    };
  });
}

/** archive.org/details/X, /stream/X/…, /download/X/… → X */
export function iaIdentifier(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?archive\.org\/(?:details|stream|download|embed)\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

export const anthropic = new Anthropic({
  apiKey: process.env.CNFIRMED_ANTHROPIC_API_KEY,
  // Claude Code sets ANTHROPIC_BASE_URL for itself; this goes to the public API.
  baseURL: "https://api.anthropic.com",
  maxRetries: 4,
});

export const usage: Record<string, { calls: number; input: number; output: number; searches: number }> = {};

const PRICE: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

export function costOf(model: string, u: { input: number; output: number; searches: number }): number {
  const [i, o] = PRICE[model] ?? [0, 0];
  return (u.input * i + u.output * o) / 1e6 + u.searches * 0.01;
}

let claudeSlots = 6;
const claudeQueue: (() => void)[] = [];

/** One Messages call, cached by its request body; usage tallied under `tag`. */
export async function claude(tag: string, params: Record<string, unknown>): Promise<Anthropic.Message> {
  const msg = await cached(`claude:${JSON.stringify(params)}`, async () => {
    if (claudeSlots === 0) await new Promise<void>((r) => claudeQueue.push(r));
    else claudeSlots--;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await anthropic.messages.create(params as any, { timeout: 600_000 })) as Anthropic.Message;
    } finally {
      const next = claudeQueue.shift();
      if (next) next();
      else claudeSlots++;
    }
  });
  const u = (usage[tag] ??= { calls: 0, input: 0, output: 0, searches: 0 });
  u.calls++;
  const mu = msg.usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
  u.input += mu.input_tokens + (mu.cache_read_input_tokens ?? 0) * 0.1 + (mu.cache_creation_input_tokens ?? 0) * 1.25;
  u.output += mu.output_tokens;
  u.searches += mu.server_tool_use?.web_search_requests ?? 0;
  return msg;
}

// ---------------------------------------------------------------------------
// Free paths: GPT-OSS through the CNfirmed Worker, and the Verify API
// ---------------------------------------------------------------------------

const WORKER = process.env.CNFIRMED_PROXY_URL ?? "https://publicai-proxy.alaexis.workers.dev";

/** gpt-oss-20b on Hugging Face via the Worker, which pays for it: free to the caller. */
export async function workerChat(tag: string, system: string, user: string, maxTokens = 6000): Promise<string> {
  return chatVia(tag, "/hf", "openai/gpt-oss-20b", system, user, maxTokens);
}

/**
 * Any model the Worker serves: `/hf` (Hugging Face, allowlisted, paid by the
 * Worker), `/liftwing` (Wikimedia's Lift Wing, free) or `/chat` (PublicAI,
 * free; any path the Worker does not know goes there).
 */
export async function chatVia(tag: string, route: string, model: string, system: string, user: string, maxTokens = 6000): Promise<string> {
  const body = { model, max_tokens: maxTokens, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  // gpt-oss on /hf keeps its original cache key, so earlier runs replay.
  const key = route === "/hf" && model === "openai/gpt-oss-20b" ? `worker:${JSON.stringify(body)}` : `chat:${route}:${JSON.stringify(body)}`;
  const r = await cached(key, async () => {
    const res = await http(`${WORKER}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 300_000);
    const j = JSON.parse(res.body);
    if (res.status !== 200) throw new Error(`Worker ${route} ${res.status}: ${res.body.slice(0, 200)}`);
    return { text: (j.choices?.[0]?.message?.content ?? "") as string, usage: j.usage ?? {} };
  });
  const u = (usage[tag] ??= { calls: 0, input: 0, output: 0, searches: 0 });
  u.calls++;
  u.input += r.usage.prompt_tokens ?? 0;
  u.output += r.usage.completion_tokens ?? 0;
  return r.text;
}

export function jsonIn<T>(t: string): T | null {
  const m = /\{[\s\S]*\}/.exec(t);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

export interface VerifyResult {
  verdict: string;
  support_score?: number | null;
  comments?: string | null;
  verified_text?: string | null;
}

const VERIFY = process.env.CNFIRMED_VERIFY_URL ?? "https://citation-verifier.toolforge.org";
/** The Verify API allows 30 requests a minute across every caller; take at most this many. */
const VERIFY_PER_MINUTE = Number(process.env.VERIFY_PER_MINUTE ?? 20);
let verifyNext = 0;

/** The production claim-vs-passages check, paced well under its shared budget. */
export async function verify(claim: string, sourceContent: string): Promise<VerifyResult | null> {
  const r = await cached(`verify:${claim}\n${sourceContent}`, async () => {
    const now = Date.now();
    const at = Math.max(now, verifyNext);
    verifyNext = at + 60_000 / VERIFY_PER_MINUTE;
    if (at > now) await new Promise((res) => setTimeout(res, at - now));
    const res = await http(`${VERIFY}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim, source_content: sourceContent.slice(0, 50_000) }),
    }, 180_000);
    if (res.status === 422) return { result: null };
    if (res.status !== 200) throw new Error(`Verify API ${res.status}: ${res.body.slice(0, 200)}`);
    return { result: JSON.parse(res.body) as VerifyResult };
  });
  const u = (usage.verify ??= { calls: 0, input: 0, output: 0, searches: 0 });
  u.calls++;
  return r.result;
}

export function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export function jsonOf<T>(msg: Anthropic.Message): T | null {
  const t = textOf(msg);
  const m = /\{[\s\S]*\}/.exec(t);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

/** Runs `fn` over `items`, `n` at a time, in order of completion. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * Record-and-replay for every HTTP request the pipeline makes.
 *
 * The core library and the user script both call the global `fetch`, and only
 * that. Swapping it for this one freezes the whole run: the article's wikitext,
 * its interlanguage links, the sister wikis' wikitext and the Internet Archive's
 * answers are saved once, and every later run reads them back from disk. That
 * makes an evaluation repeatable (nobody's edit to an article moves the
 * numbers) and fast (no network at all), and it runs where the network is
 * blocked.
 *
 * Modes:
 *   - `replay`: disk only. A request that was never recorded fails, loudly, so
 *     a code change that asks for something new is noticed rather than hidden.
 *   - `record`: disk first; a miss goes to the network and is saved.
 *
 * Live requests are sent one at a time per host, spaced out, and retried on 429
 * and 5xx honouring `Retry-After`. Wikipedia rate-limits unauthenticated API
 * traffic from shared cloud addresses quickly (a handful of parallel requests
 * was enough), and the Internet Archive is a donated service.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export type CassetteMode = "replay" | "record";

export interface CassetteOptions {
  dir: string;
  mode: CassetteMode;
  /** Minimum gap between two live requests to the same host (default 1000 ms). */
  minIntervalMs?: number;
  /**
   * Live requests in flight per host (default 1). The Internet Archive's
   * full-text search takes 20-odd seconds to answer; two at a time is still
   * gentle.
   */
  hostConcurrency?: Record<string, number>;
  /** Retries on 429 / 5xx / network errors before giving up (default 6). */
  maxRetries?: number;
  log?: (line: string) => void;
  /** Sees every response body, replayed or live: for tallying model usage. */
  observe?: (key: string, body: string) => void;
}

interface Recorded {
  key: string;
  status: number;
  contentType: string | null;
  body: string;
}

export interface CassetteStats {
  hits: number;
  recorded: number;
  misses: string[];
  retries: number;
}

/**
 * Sent with every live request. The user script sets no user agent (a browser
 * supplies one), and Wikimedia throttles generic ones such as Node's default
 * harder, so recording identifies itself.
 */
const EVAL_USER_AGENT = "CNfirmed-eval/0.1 (https://github.com/alex-o-748/source-finder)";

/** Query parameters that change nothing about the answer. */
const IGNORED_PARAMS = new Set(["origin"]);

/**
 * A request's identity: method, host, path and sorted query, without noise.
 * A request with a body (a model call) is also identified by a hash of the
 * body, so each prompt has its own recording. Headers never are: they carry
 * the API key, which is never written to disk.
 */
export function requestKey(url: string, method = "GET", body?: string): string {
  const u = new URL(url);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !IGNORED_PARAMS.has(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = new URLSearchParams(params).toString();
  const digest = body ? `#${createHash("sha1").update(body).digest("hex").slice(0, 16)}` : "";
  return `${method.toUpperCase()} ${u.host}${u.pathname}${query ? `?${query}` : ""}${digest}`;
}

export function cassettePath(dir: string, key: string): string {
  const host = key.split(" ")[1].split("/")[0];
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
  return join(dir, host, `${hash}.json.gz`);
}

/**
 * A failure worth retrying and never worth recording. The Internet Archive's
 * full-text search reports its own backend failing (an upstream 502) as a 400.
 */
export function isTransient(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 400 && body.includes("search backend encountered an exception");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  const backoff = Math.min(60_000, 2_000 * 2 ** attempt);
  return Number.isFinite(seconds) ? Math.max(seconds * 1000, 1000) : backoff;
}

/**
 * Replaces `globalThis.fetch` with the recording/replaying one and returns its
 * running statistics. Call once, before the pipeline makes any request.
 */
export function installCassette(options: CassetteOptions): CassetteStats {
  const realFetch = globalThis.fetch.bind(globalThis);
  const minInterval = options.minIntervalMs ?? 1000;
  const maxRetries = options.maxRetries ?? 6;
  const log = options.log ?? (() => {});
  const stats: CassetteStats = { hits: 0, recorded: 0, misses: [], retries: 0 };

  // One chain per lane, `hostConcurrency` lanes per host (one by default):
  // live requests to a host overlap at most that much.
  const queues = new Map<string, Promise<unknown>>();
  const laneTurn = new Map<string, number>();
  const lastSent = new Map<string, number>();

  async function live(
    url: string,
    init: RequestInit | undefined,
    host: string,
    lanes: number,
  ): Promise<{ res: Response; body: string }> {
    for (let attempt = 0; ; attempt++) {
      const wait = (lastSent.get(host) ?? 0) + minInterval / lanes - Date.now();
      if (wait > 0) await sleep(wait);
      lastSent.set(host, Date.now());
      let res: Response;
      try {
        // The caller's abort signal is dropped: a request may sit in the queue
        // longer than the caller's timeout expects, and that is fine here.
        const headers = new Headers(init?.headers);
        headers.set("user-agent", EVAL_USER_AGENT);
        res = await realFetch(url, { ...init, headers, signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        stats.retries++;
        log(`  network error on ${host}, retry ${attempt + 1}: ${(err as Error).message}`);
        await sleep(2_000 * 2 ** attempt);
        continue;
      }
      const body = await res.text();
      if (isTransient(res.status, body) && attempt < maxRetries) {
        const ms = retryAfterMs(res, attempt);
        stats.retries++;
        log(`  ${res.status} from ${host}, waiting ${Math.round(ms / 1000)}s`);
        await sleep(ms);
        continue;
      }
      return { res, body };
    }
  }

  const cassetteFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : undefined;
    const key = requestKey(url, method, body);
    const path = cassettePath(options.dir, key);

    if (existsSync(path)) {
      const rec = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as Recorded;
      stats.hits++;
      options.observe?.(key, rec.body);
      return new Response(rec.body, {
        status: rec.status,
        headers: rec.contentType ? { "content-type": rec.contentType } : {},
      });
    }
    if (options.mode === "replay") {
      stats.misses.push(key);
      throw new Error(`not recorded: ${key}`);
    }

    const host = new URL(url).host;
    const lanes = options.hostConcurrency?.[host] ?? 1;
    const turn = laneTurn.get(host) ?? 0;
    laneTurn.set(host, turn + 1);
    const lane = `${host}#${turn % lanes}`;
    const previous = queues.get(lane) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => live(url, init, host, lanes));
    queues.set(lane, run);
    const { res, body: text } = await run;
    // Rate limits and server errors that outlived the retries are not facts
    // about the world; everything else (200, 404, a MediaWiki error) is.
    options.observe?.(key, text);
    if (!isTransient(res.status, text)) {
      const rec: Recorded = { key, status: res.status, contentType: res.headers.get("content-type"), body: text };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, gzipSync(JSON.stringify(rec)));
      stats.recorded++;
    }
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: { "content-type": res.headers.get("content-type") ?? "" },
    });
  };

  globalThis.fetch = cassetteFetch as typeof fetch;
  return stats;
}

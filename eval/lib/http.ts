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
  /**
   * Where a request's recording lives, when not in `dir`: a whole book's text
   * runs to a megabyte, too much to commit, so those go to an ignored folder.
   */
  dirFor?: (key: string) => string;
  mode: CassetteMode;
  /**
   * Where a live request goes, when not to its own URL: a Worker route not
   * deployed yet, served by a local copy (`wrangler dev`). It is recorded
   * under the URL the pipeline asked for, so a replay needs nothing local.
   * Spacing, lanes, timeouts and retries follow the host it goes to.
   */
  liveUrl?: (url: string) => string;
  /** Minimum gap between two live requests to the same host (default 1000 ms). */
  minIntervalMs?: number;
  /** The same, for particular hosts: the CNfirmed Worker allows 20 requests a minute. */
  hostMinIntervalMs?: Record<string, number>;
  /**
   * Live requests in flight per host (default 1). The Internet Archive's
   * full-text search takes 20-odd seconds to answer; two at a time is still
   * gentle.
   */
  hostConcurrency?: Record<string, number>;
  /** Retries on 429 / 5xx / network errors before giving up (default 6). */
  maxRetries?: number;
  /**
   * Per host, how long one live request may take (default 60 s), and whether
   * a timeout or dropped connection is retried (default yes). A model call
   * with web search can run for minutes, and is billed even when abandoned,
   * so it gets a long wait and no retry.
   */
  hostTimeouts?: Record<string, { ms: number; retryNetworkErrors: boolean }>;
  /**
   * Hosts, or a host and the start of a path (`worker.dev/hf`), whose error
   * responses are never recorded. A model API's 400 or 401 (no credit, a bad
   * key) says nothing about the claim, and replaying it would hide the gap
   * from the next --record.
   */
  recordOnlyOk?: string[];
  /**
   * Hosts, or a host and the start of a path, whose client retries its own
   * server errors: a 5xx is handed back at once (a 429 is still waited out
   * here), so a billed call is not repeated twice over.
   */
  clientRetries5xx?: string[];
  /** A response that is not to be recorded, though it is no error: say, a model's reply with no answer. */
  skipRecording?: (key: string, status: number, body: string) => boolean;
  log?: (line: string) => void;
  /** Sees every response body, replayed or live, and how long it took live. */
  observe?: (key: string, body: string, ms: number | undefined) => void;
}

interface Recorded {
  key: string;
  status: number;
  contentType: string | null;
  body: string;
  /** Wall-clock time of the live request, when recorded. */
  ms?: number;
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

/** Whether a request key is for one of `targets`: a host, or a host and the start of a path. */
export function keyMatches(key: string, targets: string[] | undefined): boolean {
  const target = key.slice(key.indexOf(" ") + 1);
  return (targets ?? []).some((t) => target === t || target.startsWith(t.includes("/") ? t : `${t}/`));
}

export function cassettePath(dir: string, key: string): string {
  const host = key.split(" ")[1].split("/")[0];
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
  return join(dir, host, `${hash}.json.gz`);
}

/**
 * A failure worth retrying and never worth recording. The Internet Archive's
 * full-text search reports its own backend failing as a 400, but serves that
 * failure for the same URL for some 20 minutes, so asking again is no use:
 * it is recorded, and the client asks for one more hit instead
 * (`searchWithRetry` in src/core/internetArchive.ts).
 */
export function isTransient(status: number, _body: string): boolean {
  return status === 429 || status >= 500;
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
    clientRetries: boolean,
  ): Promise<{ res: Response; body: string; ms: number }> {
    const timeout = options.hostTimeouts?.[host] ?? { ms: 60_000, retryNetworkErrors: true };
    for (let attempt = 0; ; attempt++) {
      // The slot is taken before the wait, so lanes waiting together go out
      // one gap apart.
      const gap = options.hostMinIntervalMs?.[host] ?? minInterval / lanes;
      const at = Math.max(Date.now(), (lastSent.get(host) ?? 0) + gap);
      lastSent.set(host, at);
      if (at > Date.now()) await sleep(at - Date.now());
      let res: Response;
      const started = Date.now();
      try {
        // The caller's abort signal is dropped: a request may sit in the queue
        // longer than the caller's timeout expects, and that is fine here.
        const headers = new Headers(init?.headers);
        headers.set("user-agent", EVAL_USER_AGENT);
        res = await realFetch(url, { ...init, headers, signal: AbortSignal.timeout(timeout.ms) });
      } catch (err) {
        if (attempt >= maxRetries || !timeout.retryNetworkErrors) throw err;
        stats.retries++;
        log(`  network error on ${host}, retry ${attempt + 1}: ${(err as Error).message}`);
        await sleep(2_000 * 2 ** attempt);
        continue;
      }
      const body = await res.text();
      if (isTransient(res.status, body) && !(clientRetries && res.status >= 500) && attempt < maxRetries) {
        const ms = retryAfterMs(res, attempt);
        stats.retries++;
        log(`  ${res.status} from ${host}, waiting ${Math.round(ms / 1000)}s`);
        await sleep(ms);
        continue;
      }
      return { res, body, ms: Date.now() - started };
    }
  }

  const cassetteFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body = typeof init?.body === "string" ? init.body : undefined;
    const key = requestKey(url, method, body);
    const path = cassettePath(options.dirFor?.(key) ?? options.dir, key);

    if (existsSync(path)) {
      const rec = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as Recorded;
      stats.hits++;
      options.observe?.(key, rec.body, rec.ms);
      return new Response(rec.body, {
        status: rec.status,
        headers: rec.contentType ? { "content-type": rec.contentType } : {},
      });
    }
    if (options.mode === "replay") {
      stats.misses.push(key);
      throw new Error(`not recorded: ${key}`);
    }

    const target = options.liveUrl?.(url) ?? url;
    const host = new URL(target).host;
    const lanes = options.hostConcurrency?.[host] ?? 1;
    const turn = laneTurn.get(host) ?? 0;
    laneTurn.set(host, turn + 1);
    const lane = `${host}#${turn % lanes}`;
    const previous = queues.get(lane) ?? Promise.resolve();
    const clientRetries = keyMatches(key, options.clientRetries5xx);
    const run = previous.catch(() => {}).then(() => live(target, init, host, lanes, clientRetries));
    queues.set(lane, run);
    const { res, body: text, ms } = await run;
    // Rate limits and server errors that outlived the retries are not facts
    // about the world; everything else (200, 404, a MediaWiki error) is.
    options.observe?.(key, text, ms);
    if (
      !isTransient(res.status, text) &&
      (res.ok || !keyMatches(key, options.recordOnlyOk)) &&
      !options.skipRecording?.(key, res.status, text)
    ) {
      const rec: Recorded = { key, status: res.status, contentType: res.headers.get("content-type"), body: text, ms };
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

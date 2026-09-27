/**
 * Thin Internet Archive client.
 *
 * Two read-only endpoints on `archive.org` itself, neither needing a key:
 *
 *   - Full-text search over OCRed books, the endpoint archive.org's own search
 *     page uses (`/services/search/beta/page_production/?service_backend=fts`).
 *     Each hit carries the book's year, collections and matching passages, so
 *     the access check and the scoring need no further request.
 *   - Item metadata (`/metadata/{id}`), for what a hit lacks: the publisher,
 *     and the access-restriction flag, checked once more for the few books
 *     kept.
 *
 * Only `archive.org` is on Wikipedia's CSP allowlist, so these are the
 * endpoints the user script can reach too — checked from the console on a
 * Wikipedia page. The `ia` package's `be-api.us.archive.org` full-text host,
 * search-inside-the-book and OCR downloads (which redirect to numbered
 * `*.archive.org` servers) are all refused there, so neither front end uses
 * them: the CLI and the user script see the same data.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { USER_AGENT } from "./mediawiki.js";

export const SEARCH_URL = "https://archive.org/services/search/beta/page_production/";
export const METADATA_URL = "https://archive.org/metadata/";
export const STREAM_URL = "https://archive.org/stream/";

const REQUEST_TIMEOUT_MS = 30_000;
/** Longest `Retry-After` honoured on a 429 before giving up. */
const MAX_RETRY_AFTER_S = 30;

/** The search response, as far as it is read. */
export type SearchResponse = {
  response?: { body?: { hits?: { total?: unknown; hits?: unknown[] } } | null };
};
export type MetadataResponse = {
  metadata?: Record<string, unknown>;
  is_dark?: boolean;
};

export interface SearchRequest {
  /**
   * Lucene syntax: `AND` and field ranges such as `year:[1450 TO 1930]` both
   * work in this endpoint's `user_query` (checked live).
   */
  query: string;
  size: number;
}

export interface ArchiveClient {
  fullTextSearch(request: SearchRequest): Promise<SearchResponse>;
  metadata(identifier: string): Promise<MetadataResponse>;
  /** The `/stream/` page holding an open book's whole OCR text (HTML, the text in a `<pre>`). */
  streamPage?(identifier: string, file: string): Promise<string>;
}

/**
 * An open book's whole OCR text, served by archive.org itself. Readable from
 * Node; not from a Wikipedia page until archive.org sends a CORS header on it
 * (`/metadata` and the search do, this does not). `/download/…_djvu.txt`
 * redirects to a numbered server Wikipedia's CSP refuses.
 */
export function streamUrl(identifier: string, file: string): string {
  return `${STREAM_URL}${encodeURIComponent(identifier)}/${encodeURIComponent(file)}_djvu.txt`;
}

/** Query-string parameters for a full-text search. The user script builds the same. */
export function searchParams(request: SearchRequest): URLSearchParams {
  return new URLSearchParams({
    service_backend: "fts",
    user_query: request.query,
    hits_per_page: String(request.size),
  });
}

async function get(url: string, accept: string, retried = false): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      // The Archive asks every automated client to identify itself.
      headers: { "user-agent": USER_AGENT, accept },
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 && !retried) {
    const wait = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(wait) && wait <= MAX_RETRY_AFTER_S) {
      await new Promise((r) => setTimeout(r, Math.max(wait, 1) * 1000));
      return get(url, accept, true);
    }
  }
  if (!res.ok) {
    // Status text is empty over HTTP/2, so the code alone.
    throw new Error(`Internet Archive: HTTP ${res.status}`);
  }
  return res;
}

async function getJson<T>(url: string): Promise<T> {
  return (await (await get(url, "application/json")).json()) as T;
}

/** The live client. */
export const httpArchiveClient: ArchiveClient = {
  fullTextSearch(request) {
    return getJson<SearchResponse>(`${SEARCH_URL}?${searchParams(request).toString()}`);
  },
  metadata(identifier) {
    return getJson<MetadataResponse>(METADATA_URL + encodeURIComponent(identifier));
  },
  async streamPage(identifier, file) {
    return (await get(streamUrl(identifier, file), "text/html")).text();
  },
};

/**
 * Wraps a client so every response is also written to `dir`, one file per
 * call, named for the call. Turns a live run into fixtures for the offline
 * tests.
 */
export function recordingClient(inner: ArchiveClient, dir: string): ArchiveClient {
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const save = (name: string, body: unknown): void => {
    const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 80);
    const file = join(dir, `${String(++n).padStart(3, "0")}-${safe}.json`);
    writeFileSync(file, JSON.stringify(body, null, 2));
  };
  return {
    async fullTextSearch(request) {
      const r = await inner.fullTextSearch(request);
      save(`search-${request.query}`, { request, response: r });
      return r;
    },
    async metadata(identifier) {
      const r = await inner.metadata(identifier);
      save(`metadata-${identifier}`, r);
      return r;
    },
    ...(inner.streamPage && {
      async streamPage(identifier: string, file: string) {
        const r = await inner.streamPage!(identifier, file);
        save(`stream-${identifier}`, { length: r.length });
        return r;
      },
    }),
  };
}

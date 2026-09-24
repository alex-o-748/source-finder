/**
 * Thin Internet Archive client.
 *
 * Four read-only endpoints, none of which needs a key:
 *
 *   - Full-text search over OCRed books (`be-api.us.archive.org/ia-pub-fts-api`),
 *     the endpoint the official `internetarchive` Python package uses for
 *     `ia search --fts`. A query is Lucene when prefixed with `!L`.
 *   - Item metadata (`archive.org/metadata/{id}`): citation fields, rights
 *     flags, and the server/dir the search-inside endpoint needs.
 *   - Search inside one book (`{server}/fulltext/inside.php`), the BookReader
 *     endpoint: matching passages with their page.
 *   - The book's plain OCR text (`archive.org/download/{id}/{file}_djvu.txt`),
 *     the fallback when neither of the above yields a passage.
 *
 * Everything behind the `ArchiveClient` interface so tests run on fixtures and
 * a live run can be recorded into new ones. Response shapes of the full-text
 * and search-inside endpoints are not documented; the parsers in
 * `archiveSources.ts` accept every shape seen in the reference clients and
 * `cnfirmed archive --record` exists to pin them down.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { USER_AGENT } from "./mediawiki.js";

export const FTS_URL = "https://be-api.us.archive.org/ia-pub-fts-api";
export const METADATA_URL = "https://archive.org/metadata/";
export const DOWNLOAD_URL = "https://archive.org/download/";

const REQUEST_TIMEOUT_MS = 30_000;
/** Longest `Retry-After` honoured on a 429 before giving up. */
const MAX_RETRY_AFTER_S = 30;
/** OCR text of a long book runs to megabytes; nothing past this is needed. */
const MAX_TEXT_BYTES = 8_000_000;

/** The raw response shapes, as loosely as they are known. */
export type FtsResponse = { hits?: { total?: unknown; hits?: unknown[] } };
export type MetadataResponse = {
  metadata?: Record<string, unknown>;
  files?: { name?: string; format?: string }[];
  server?: string;
  dir?: string;
  is_dark?: boolean;
};
export type InsideResponse = { matches?: unknown[]; error?: string };

export interface ArchiveClient {
  /** Full-text search. `query` is plain Lucene; the `!L` prefix is added here. */
  fullTextSearch(query: string, size: number): Promise<FtsResponse>;
  metadata(identifier: string): Promise<MetadataResponse>;
  /** Search inside one book. Needs `server` and `dir` from its metadata. */
  searchInside(
    identifier: string,
    server: string,
    dir: string,
    query: string,
  ): Promise<InsideResponse>;
  /** The book's plain OCR text, from the named `_djvu.txt` file. */
  plainText(identifier: string, file: string): Promise<string>;
}

async function request(
  url: string,
  init: RequestInit = {},
  retried = false,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: controller.signal,
      // The Archive asks every automated client to identify itself.
      headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 && !retried) {
    const wait = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    if (Number.isFinite(wait) && wait <= MAX_RETRY_AFTER_S) {
      await new Promise((r) => setTimeout(r, Math.max(wait, 1) * 1000));
      return request(url, init, true);
    }
  }
  if (!res.ok) {
    throw new Error(`Internet Archive: ${res.status} ${res.statusText} for ${url}`);
  }
  return res;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await request(url, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  return (await res.json()) as T;
}

/** The live client. */
export const httpArchiveClient: ArchiveClient = {
  fullTextSearch(query, size) {
    return getJson<FtsResponse>(FTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Mirrors `internetarchive.search.Search._full_text_search` with an
      // explicit size, which turns scrolling off.
      body: JSON.stringify({
        q: `!L ${query}`,
        size: String(size),
        from: "0",
        scroll: false,
      }),
    });
  },

  metadata(identifier) {
    return getJson<MetadataResponse>(
      METADATA_URL + encodeURIComponent(identifier),
    );
  },

  searchInside(identifier, server, dir, query) {
    const params = new URLSearchParams({
      item_id: identifier,
      doc: identifier,
      path: dir,
      q: query,
    });
    return getJson<InsideResponse>(
      `https://${server}/fulltext/inside.php?${params.toString()}`,
    );
  },

  async plainText(identifier, file) {
    const res = await request(
      `${DOWNLOAD_URL}${encodeURIComponent(identifier)}/${encodeURIComponent(file)}`,
    );
    const text = await res.text();
    return text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
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
    const file = join(dir, `${String(++n).padStart(3, "0")}-${safe}`);
    if (typeof body === "string") writeFileSync(`${file}.txt`, body);
    else writeFileSync(`${file}.json`, JSON.stringify(body, null, 2));
  };
  return {
    async fullTextSearch(query, size) {
      const r = await inner.fullTextSearch(query, size);
      save(`fts-${query}`, { request: { query, size }, response: r });
      return r;
    },
    async metadata(identifier) {
      const r = await inner.metadata(identifier);
      save(`metadata-${identifier}`, r);
      return r;
    },
    async searchInside(identifier, server, dir2, query) {
      const r = await inner.searchInside(identifier, server, dir2, query);
      save(`inside-${identifier}-${query}`, { request: { query }, response: r });
      return r;
    },
    async plainText(identifier, file) {
      const r = await inner.plainText(identifier, file);
      save(`text-${identifier}`, r);
      return r;
    },
  };
}

/**
 * The hints API: a lookup, never a computation. Everything it returns was
 * computed ahead of time by the batch job (src/hints/batch.ts).
 *
 *   GET /v1/hints?wiki=en&page_id=12345&text=<the snippet's text or HTML>
 *
 * 200 {wiki, page_id, title, rev_id, computed_at, claims: [...]}: the claims
 *     of that article whose sentence is in `text` (every claim without `text`),
 *     each with the books a model checked and found to state it. A claim with
 *     `books: []` was looked for and nothing was found.
 * 404 {error: "not_checked"}: the article has not been computed yet.
 * 400 {error: "..."}: a bad parameter.
 *
 * Read-only public data, so any origin may call it from a browser.
 */

import { createServer, type Server } from "node:http";
import type { BookHint, ClaimHints, PageHints } from "./compute.js";
import { matchClaims } from "./match.js";
import type { HintStore } from "./store.js";

/** Longer than any Citation Hunt snippet (800 characters of text, as HTML). */
export const MAX_TEXT_CHARS = 20_000;

export interface Reply {
  status: number;
  body: unknown;
}

export interface PublicClaim {
  claim: string;
  section: string | null;
  status: ClaimHints["status"];
  books: Omit<BookHint, "identifier">[];
}

// Only these fields of a stored claim are served: `verdicts` and `error` stay internal.

function publicClaim(c: ClaimHints): PublicClaim {
  return {
    claim: c.claim,
    section: c.section,
    status: c.status,
    books: c.books.map(({ identifier: _id, ...b }) => b),
  };
}

export function publicPage(page: PageHints, claims: ClaimHints[]) {
  return {
    wiki: page.wiki,
    page_id: page.pageId,
    title: page.title,
    rev_id: page.revId,
    computed_at: page.computedAt,
    claims: claims.map(publicClaim),
  };
}

export async function handleRequest(method: string, rawUrl: string, store: HintStore): Promise<Reply> {
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/healthz") return { status: 200, body: { ok: true } };
  if (url.pathname === "/" || url.pathname === "") {
    return {
      status: 200,
      body: {
        name: "CNfirmed hints",
        usage: "GET /v1/hints?wiki=en&page_id=<id>&text=<snippet text>",
        source: "https://github.com/alex-o-748/source-finder",
      },
    };
  }
  if (url.pathname !== "/v1/hints") return { status: 404, body: { error: "not_found" } };
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: { error: "method_not_allowed" } };

  const wiki = url.searchParams.get("wiki") ?? "en";
  const pageIdParam = url.searchParams.get("page_id") ?? "";
  const text = url.searchParams.get("text");
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(wiki)) return { status: 400, body: { error: "bad wiki" } };
  if (!/^[1-9]\d{0,12}$/.test(pageIdParam)) return { status: 400, body: { error: "page_id is required" } };
  if (text !== null && text.length > MAX_TEXT_CHARS) return { status: 400, body: { error: "text is too long" } };

  const page = await store.get(wiki, Number(pageIdParam));
  if (!page) return { status: 404, body: { error: "not_checked" } };
  const claims = text === null ? page.claims : matchClaims(page.claims, text);
  return { status: 200, body: publicPage(page, claims) };
}

export function createHintServer(store: HintStore): Server {
  return createServer(async (req, res) => {
    let reply: Reply;
    try {
      reply = await handleRequest(req.method ?? "GET", req.url ?? "/", store);
    } catch (err) {
      console.error(err);
      reply = { status: 500, body: { error: "internal_error" } };
    }
    const json = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": reply.status === 200 ? "public, max-age=300" : "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : json);
  });
}

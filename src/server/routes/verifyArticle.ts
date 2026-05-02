import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { fetchArticle } from "../../core/fetchArticle.js";
import { extractClaims } from "../../core/extractClaims.js";
import { runArticle } from "../../core/runArticle.js";

interface VerifyArticleBody {
  articleTitle?: string;
  maxClaims?: number;
  candidatesPerClaim?: number;
  verifyTopN?: number;
}

export const verifyArticleRoute = new Hono();

verifyArticleRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as VerifyArticleBody;
  if (!body.articleTitle) {
    return c.json({ error: "expected { articleTitle }" }, 400);
  }

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    try {
      // Pre-fetch once so we can emit `started` with a known total before
      // runArticle re-fetches internally. Cheap (one Wikipedia API hit).
      const preview = await fetchArticle(body.articleTitle!);
      const allClaims = extractClaims(preview.wikitext);
      const total = body.maxClaims
        ? Math.min(body.maxClaims, allClaims.length)
        : allClaims.length;
      await send("started", {
        articleTitle: preview.title,
        revid: preview.revid,
        total,
      });

      // runArticle fires onProgress AFTER each claim resolves; we use it to
      // emit progress ticks. Buffered claim-result events follow at the end.
      const run = await runArticle(body.articleTitle!, {
        maxClaims: body.maxClaims,
        candidatesPerClaim: body.candidatesPerClaim,
        verifyTopN: body.verifyTopN,
        onProgress: (done, totalSeen, claim) => {
          // Fire-and-forget — Hono stream.writeSSE returns a promise; we don't
          // await inside the sync callback. SSE order is preserved by the
          // single underlying writer.
          void send("claim-progress", {
            phase: "verifying",
            done,
            total: totalSeen,
            claim,
          });
        },
      });

      run.results.forEach((result, index) => {
        void send("claim-result", { index, result });
      });

      await send("done", {
        article: {
          title: run.article.title,
          lang: run.article.lang,
          revid: run.article.revid,
          url: run.article.url,
        },
      });
    } catch (err) {
      await send("error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
});

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { fetchArticle } from "../../core/fetchArticle.js";
import { extractClaims } from "../../core/extractClaims.js";
import { findSources } from "../../core/findSources.js";
import { verifySource } from "../../core/verifySource.js";
import { formatCitation } from "../../core/formatCitation.js";
import type {
  ClaimResult,
  ClaimSuggestion,
} from "../../core/types.js";
import { rankSuggestions } from "../rank.js";

interface VerifyClaimBody {
  articleTitle?: string;
  revid?: number;
  claimIndex?: number;
  candidatesPerClaim?: number;
  verifyTopN?: number;
}

export const verifyClaimRoute = new Hono();

verifyClaimRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as VerifyClaimBody;
  if (!body.articleTitle || typeof body.claimIndex !== "number") {
    return c.json({ error: "expected { articleTitle, claimIndex }" }, 400);
  }

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    try {
      await send("started", {
        articleTitle: body.articleTitle,
        claimIndex: body.claimIndex,
      });

      const article = await fetchArticle(body.articleTitle!);
      const claims = extractClaims(article.wikitext);
      const claim = claims[body.claimIndex!];
      if (!claim) {
        await send("error", {
          message: `claim index ${body.claimIndex} out of range (article has ${claims.length} CN claims)`,
          where: "extract",
        });
        return;
      }

      await send("claim-progress", {
        phase: "finding",
        claim,
        revid: article.revid,
      });

      const candidates = await findSources(claim, {
        maxResults: body.candidatesPerClaim ?? 5,
      });
      const toVerify = candidates.slice(0, body.verifyTopN ?? 3);

      const suggestions: ClaimSuggestion[] = [];
      for (let i = 0; i < toVerify.length; i++) {
        const candidate = toVerify[i];
        await send("claim-progress", {
          phase: "verifying",
          candidate: { url: candidate.url, title: candidate.title },
          i: i + 1,
          n: toVerify.length,
        });
        try {
          const verdict = await verifySource(claim.claim, candidate.url);
          suggestions.push({
            source: candidate,
            verdict,
            citation: formatCitation(candidate),
          });
        } catch (err) {
          suggestions.push({
            source: candidate,
            verdict: {
              verdict: "SOURCE UNAVAILABLE",
              confidence: 0,
              comments: `verification failed: ${(err as Error).message}`,
              reliability: "n/a",
              reliabilityReason: "verifier error — reliability not assessed",
            },
            citation: formatCitation(candidate),
          });
        }
      }

      rankSuggestions(suggestions);
      const result: ClaimResult = { claim, suggestions };
      await send("claim-result", { index: body.claimIndex, result });
      await send("done", {
        article: {
          title: article.title,
          lang: article.lang,
          revid: article.revid,
          url: article.url,
        },
      });
    } catch (err) {
      await send("error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
});

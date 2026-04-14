import { fetchArticle } from "./fetchArticle.js";
import { extractClaims } from "./extractClaims.js";
import { findSources } from "./findSources.js";
import { verifySource } from "./verifySource.js";
import { formatCitation } from "./formatCitation.js";
import type {
  ArticleRun,
  Claim,
  ClaimResult,
  ClaimSuggestion,
} from "./types.js";

interface RunOptions {
  /** Cap the number of claims processed (useful for cost/latency control). */
  maxClaims?: number;
  /** Candidates to return per claim before verification. */
  candidatesPerClaim?: number;
  /** Candidates to verify per claim (top-N from findSources). */
  verifyTopN?: number;
  /** Called after each claim completes; useful for progress logging. */
  onProgress?: (done: number, total: number, claim: Claim) => void;
}

/**
 * End-to-end: fetch an article, extract every {{cn}} claim, find candidate
 * sources, verify each, and format citations for the winners.
 */
export async function runArticle(
  urlOrTitle: string,
  options: RunOptions = {},
): Promise<ArticleRun> {
  const article = await fetchArticle(urlOrTitle);
  const allClaims = extractClaims(article.wikitext);
  const claims = options.maxClaims
    ? allClaims.slice(0, options.maxClaims)
    : allClaims;

  const verifyTopN = options.verifyTopN ?? 3;
  const candidatesPerClaim = options.candidatesPerClaim ?? 5;

  const results: ClaimResult[] = [];
  let done = 0;
  for (const claim of claims) {
    try {
      const candidates = await findSources(claim, {
        maxResults: candidatesPerClaim,
      });
      const toVerify = candidates.slice(0, verifyTopN);
      const suggestions: ClaimSuggestion[] = [];
      for (const candidate of toVerify) {
        try {
          const verdict = await verifySource(claim.claim, candidate.url);
          const citation = formatCitation(candidate);
          suggestions.push({ source: candidate, verdict, citation });
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
      // Rank by (verdict, reliability), then by confidence desc within bucket.
      //   0: SUPPORTED + reliability high|medium   — fully promotable
      //   1: SUPPORTED + reliability low           — says it, but wrong kind of source
      //   2: PARTIALLY SUPPORTED (any reliability) — weak but not useless
      //   3: NOT SUPPORTED or SOURCE UNAVAILABLE   — not useful
      const bucket = (s: ClaimSuggestion): number => {
        const v = s.verdict.verdict;
        if (v === "SUPPORTED") {
          return s.verdict.reliability === "low" ? 1 : 0;
        }
        if (v === "PARTIALLY SUPPORTED") return 2;
        return 3;
      };
      suggestions.sort((a, b) => {
        const ba = bucket(a);
        const bb = bucket(b);
        if (ba !== bb) return ba - bb;
        return b.verdict.confidence - a.verdict.confidence;
      });
      results.push({ claim, suggestions });
    } catch (err) {
      results.push({
        claim,
        suggestions: [],
        error: (err as Error).message,
      });
    } finally {
      done++;
      options.onProgress?.(done, claims.length, claim);
    }
  }

  return { article, results };
}

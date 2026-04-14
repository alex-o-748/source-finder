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
              supports: false,
              confidence: 0,
              reliability: "low",
              reliabilityReason: "verifier error — reliability not assessed",
              reasoning: `verification failed: ${(err as Error).message}`,
            },
            citation: formatCitation(candidate),
          });
        }
      }
      // Rank on both axes: fully-promotable (supports + reliability>=medium)
      // first, then substantiating-but-low-reliability, then non-substantiating.
      // Within each bucket, higher confidence wins.
      const bucket = (s: ClaimSuggestion): number => {
        if (!s.verdict.supports) return 2;
        return s.verdict.reliability === "low" ? 1 : 0;
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

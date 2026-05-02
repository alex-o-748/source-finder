import type { ClaimSuggestion } from "../core/types.js";

// Mirror of the ranking in runArticle.ts so single-claim verification
// produces results in the same order as a full article run.
export function rankSuggestions(suggestions: ClaimSuggestion[]): void {
  const bucket = (s: ClaimSuggestion): number => {
    const v = s.verdict.verdict;
    if (v === "SUPPORTED") return s.verdict.reliability === "low" ? 1 : 0;
    if (v === "PARTIALLY SUPPORTED") return 2;
    return 3;
  };
  suggestions.sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    return b.verdict.confidence - a.verdict.confidence;
  });
}

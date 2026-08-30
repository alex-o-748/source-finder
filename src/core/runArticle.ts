import { fetchArticle } from "./fetchArticle.js";
import { extractClaims } from "./extractClaims.js";
import { findSources } from "./findSources.js";
import { verifySource } from "./verifySource.js";
import { formatCitation } from "./formatCitation.js";
import {
  findWikiCandidates,
  loadWikiCorpus,
  urlKey,
} from "./wikiSources.js";
import type { WikiCorpus, WikiSourceOptions } from "./wikiSources.js";
import type {
  ArticleRun,
  CandidateSource,
  Claim,
  ClaimResult,
  ClaimSuggestion,
  WikiCandidate,
} from "./types.js";

interface RunOptions {
  /** Cap the number of claims processed (useful for cost/latency control). */
  maxClaims?: number;
  /** Candidates to return per claim before verification. */
  candidatesPerClaim?: number;
  /** Candidates to verify per claim (top-N from each discovery stage). */
  verifyTopN?: number;
  /** Skip the free wiki-local stage and go straight to web search. */
  skipWikiSources?: boolean;
  /** Never run the paid web search, whatever the wiki-local stage turns up. */
  wikiOnly?: boolean;
  /** Run the web search even when a wiki-local source already substantiates. */
  alwaysWebSearch?: boolean;
  /** Tuning for the wiki-local stage. */
  wiki?: WikiSourceOptions;
  /** Called after each claim completes; useful for progress logging. */
  onProgress?: (done: number, total: number, claim: Claim) => void;
}

/** Turns a wiki-local lead into a candidate the verifier can act on. */
function toCandidate(candidate: WikiCandidate): CandidateSource | null {
  if (!candidate.url) return null;
  return {
    url: candidate.url,
    title: candidate.title,
    snippet: candidate.snippet,
    relevance: candidate.relevance,
    origin: candidate.evidence.origin,
    evidence: candidate.evidence,
  };
}

/** Verifies each candidate, converting verifier failures into a verdict. */
async function verifyAll(
  claim: Claim,
  candidates: CandidateSource[],
): Promise<ClaimSuggestion[]> {
  const suggestions: ClaimSuggestion[] = [];
  for (const candidate of candidates) {
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
  return suggestions;
}

/** True when a suggestion is good enough that a web search would add nothing. */
function isConclusive(suggestion: ClaimSuggestion): boolean {
  return (
    suggestion.verdict.verdict === "SUPPORTED" &&
    suggestion.verdict.reliability !== "low"
  );
}

/**
 * Rank by (verdict, reliability), then confidence, then origin.
 *   0: SUPPORTED + reliability high|medium   — fully promotable
 *   1: SUPPORTED + reliability low           — says it, but wrong kind of source
 *   2: PARTIALLY SUPPORTED (any reliability) — weak but not useless
 *   3: NOT SUPPORTED or SOURCE UNAVAILABLE   — not useful
 */
function bucket(s: ClaimSuggestion): number {
  const v = s.verdict.verdict;
  if (v === "SUPPORTED") return s.verdict.reliability === "low" ? 1 : 0;
  if (v === "PARTIALLY SUPPORTED") return 2;
  return 3;
}

function rank(suggestions: ClaimSuggestion[]): ClaimSuggestion[] {
  return suggestions.sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (b.verdict.confidence !== a.verdict.confidence) {
      return b.verdict.confidence - a.verdict.confidence;
    }
    // On a tie, prefer the source Wikipedia already trusts for this fact.
    const wiki = (s: ClaimSuggestion): number =>
      s.source.origin && s.source.origin !== "web" ? 0 : 1;
    return wiki(a) - wiki(b);
  });
}

/**
 * End-to-end: fetch an article, extract every {{cn}} claim, find candidate
 * sources, verify each, and format citations for the winners.
 *
 * Discovery runs in two stages. The wiki-local stage — citations already in
 * this article, and citations other language editions attach to the same fact —
 * is free and runs first. The web search runs only for claims it could not
 * resolve, which is where the money goes.
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

  let corpus: WikiCorpus | null = null;
  const warnings: string[] = [];
  if (!options.skipWikiSources && claims.length > 0) {
    try {
      corpus = await loadWikiCorpus(article, claims, options.wiki);
      warnings.push(...corpus.warnings);
    } catch (err) {
      warnings.push(`wiki-local stage unavailable: ${(err as Error).message}`);
    }
  }

  const results: ClaimResult[] = [];
  let done = 0;
  for (const claim of claims) {
    try {
      const wikiCandidates = corpus
        ? findWikiCandidates(corpus, claim, {
            maxCandidates: candidatesPerClaim,
            ...options.wiki,
          })
        : [];

      const wikiSources = wikiCandidates
        .map(toCandidate)
        .filter((c): c is CandidateSource => c !== null)
        .slice(0, verifyTopN);
      const suggestions = await verifyAll(claim, wikiSources);

      const resolved = suggestions.some(isConclusive);
      const runWebSearch =
        !options.wikiOnly && (options.alwaysWebSearch || !resolved);

      if (runWebSearch) {
        const seen = new Set(wikiSources.map((s) => urlKey(s.url)));
        const webCandidates = (
          await findSources(claim, { maxResults: candidatesPerClaim })
        ).filter((c) => !seen.has(urlKey(c.url)));
        suggestions.push(
          ...(await verifyAll(
            claim,
            webCandidates.slice(0, verifyTopN).map((c) => ({
              ...c,
              origin: "web" as const,
            })),
          )),
        );
      }

      results.push({
        claim,
        suggestions: rank(suggestions),
        wikiCandidates,
        webSearchSkipped: !runWebSearch && !options.wikiOnly,
      });
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

  return { article, results, warnings };
}

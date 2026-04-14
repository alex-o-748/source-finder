/**
 * Shared types for the CNfirmed core library.
 */

/** Metadata about a fetched Wikipedia article. */
export interface Article {
  /** Canonical page title, e.g. "Eiffel Tower". */
  title: string;
  /** Language code of the wiki, e.g. "en". */
  lang: string;
  /** Revision ID of the fetched revision. */
  revid: number;
  /** Raw MediaWiki wikitext for the page. */
  wikitext: string;
  /** Canonical URL of the article. */
  url: string;
}

/** A single claim on the page that carries a {{citation needed}}-style tag. */
export interface Claim {
  /** The sentence (or fragment) being claimed. */
  claim: string;
  /** A wider window of text around the claim (paragraph-level). */
  context: string;
  /** Section heading the claim lives under, if any. */
  section: string | null;
  /** Character offset within the wikitext where the {{cn}} tag begins. */
  offset: number;
  /** The exact template text matched, e.g. "{{citation needed|date=May 2024}}". */
  tag: string;
}

/** A candidate source returned from web search. */
export interface CandidateSource {
  url: string;
  title: string;
  /** Snippet or short description returned by the search tool. */
  snippet: string;
  /** Claude's relevance note for this candidate. */
  relevance: string;
}

/** Verdict from the verifier on whether a source supports a claim. */
export interface VerifyVerdict {
  /**
   * Substantiation axis: does the source actually state (or directly imply)
   * the specific claim? Pure reading-comprehension judgment.
   */
  supports: boolean;
  /** Confidence in the substantiation judgment, in [0, 1]. */
  confidence: number;
  /** A quote from the source that most directly substantiates (or contradicts) the claim. */
  supportingQuote?: string;

  /**
   * Reliability axis (per WP:RS): is this an appropriate source *for the kind
   * of claim being made*? Context-sensitive — a peer-reviewed paper is needed
   * for a medical claim, a magazine is fine for a pop-culture fact, a
   * self-published blog can substantiate the author's own bio but not third
   * parties, BLP needs strong sourcing, etc.
   *
   * Kept separate from `supports` so callers can distinguish "doesn't say it"
   * from "says it, but wrong kind of source". A suggestion with supports:true
   * and reliability:"low" is still surfaced so a human editor can decide.
   */
  reliability: "high" | "medium" | "low";
  /** Why the reliability grade — BLP, SPS, primary-vs-secondary, etc. */
  reliabilityReason: string;

  /** Short reasoning explaining the overall verdict. */
  reasoning: string;
}

/** Formatted Wikipedia cite template output. */
export interface Citation {
  /** e.g. "{{cite web|url=...|title=...|access-date=...}}" */
  template: string;
  /** Which template was used: "cite web" | "cite news" | "cite journal" | "cite book". */
  kind: "cite web" | "cite news" | "cite journal" | "cite book";
}

/** A candidate source paired with its verification verdict and formatted citation. */
export interface ClaimSuggestion {
  source: CandidateSource;
  verdict: VerifyVerdict;
  citation: Citation;
}

/** Top-level result for one claim in an article run. */
export interface ClaimResult {
  claim: Claim;
  suggestions: ClaimSuggestion[];
  /** If the pipeline failed for this claim, the error message. */
  error?: string;
}

/** Top-level article run result. */
export interface ArticleRun {
  article: Article;
  results: ClaimResult[];
}

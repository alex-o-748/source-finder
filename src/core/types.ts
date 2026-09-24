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

/**
 * Where a candidate source came from. Wiki-local origins cost nothing to
 * discover and are tried before the web search.
 */
export type SourceOrigin = "web" | "same-article" | "sister-wiki";

/**
 * Why a wiki-local candidate is believed to fit the claim: the citation was
 * already attached, by a human editor, to a sentence we matched to this claim.
 * Recorded so an editor can judge the lead without re-deriving it — and so a
 * miss shows up as weak evidence rather than a confident wrong answer.
 */
export interface WikiEvidence {
  origin: "same-article" | "sister-wiki";
  /** Language edition the citation was lifted from. */
  lang: string;
  /** Title of the article the citation was lifted from. */
  article: string;
  /** URL of that article. */
  articleUrl: string;
  /** The sentence that citation is attached to, in that article. */
  sentence: string;
  /** Section heading the citation sits under, if any. */
  section: string | null;
  /** Matching signal, 0-1. Not a substantiation verdict — only a lead. */
  score: number;
  /** For sister wikis: the translation-stable anchors that matched. */
  matchedAnchors?: string[];
  /** `name=` of the ref, when it can be re-used as `<ref name="…" />`. */
  refName: string | null;
  /** The ref body as written, so the citation can be copied verbatim. */
  refWikitext: string;
}

/** A candidate source: from web search, or lifted from a wiki citation. */
export interface CandidateSource {
  url: string;
  title: string;
  /** Snippet or short description returned by the search tool. */
  snippet: string;
  /** Claude's relevance note for this candidate. */
  relevance: string;
  /** Defaults to "web" when absent. */
  origin?: SourceOrigin;
  /** Present only for wiki-local candidates. */
  evidence?: WikiEvidence;
}

/**
 * A citation found on a wiki. Unlike `CandidateSource` the URL may be absent:
 * books and shortened footnotes are real leads for a human editor even though
 * nothing can be fetched and verified automatically.
 */
export interface WikiCandidate {
  url: string | null;
  title: string;
  /** One-line provenance, e.g. "cited on de.wikipedia for: …". */
  relevance: string;
  /** The sentence the citation supports on its home wiki. */
  snippet: string;
  evidence: WikiEvidence;
  /** Ready-to-paste `<ref>` re-using the existing citation. */
  ref: string;
}

/** Substantiation verdict values emitted by the verifier. */
export type SubstantiationVerdict =
  | "SUPPORTED"
  | "PARTIALLY SUPPORTED"
  | "NOT SUPPORTED"
  | "SOURCE UNAVAILABLE";

/** WP:RS reliability grade, or "n/a" when the source is unavailable. */
export type Reliability = "high" | "medium" | "low" | "n/a";

/** Verdict from the verifier on whether a source supports a claim. */
export interface VerifyVerdict {
  /**
   * Substantiation axis: does the source actually state (or directly imply)
   * the specific claim? Pure reading-comprehension judgment.
   *
   * SUPPORTED / PARTIALLY SUPPORTED / NOT SUPPORTED / SOURCE UNAVAILABLE.
   * See also `confidence` for a 0-100 gradation within a verdict.
   */
  verdict: SubstantiationVerdict;
  /** Confidence in the substantiation judgment, 0-100. 0 iff SOURCE UNAVAILABLE. */
  confidence: number;
  /** Short explanation of the substantiation verdict, normally including the relevant quote. */
  comments: string;

  /**
   * Reliability axis (per WP:RS): is this an appropriate source *for the kind
   * of claim being made*? Context-sensitive. Kept independent of `verdict` so
   * callers can distinguish "doesn't say it" from "says it, but wrong kind of
   * source". A (SUPPORTED, "low") pair is still surfaced so a human editor
   * can see the source does say it but needs a better one.
   *
   * "n/a" is used only when `verdict` is "SOURCE UNAVAILABLE".
   */
  reliability: Reliability;
  /** Brief WP:RS-grounded rationale for the reliability grade. */
  reliabilityReason: string;
}

/** Formatted Wikipedia cite template output. */
export interface Citation {
  /** e.g. "{{cite web|url=...|title=...|access-date=...}}" */
  template: string;
  /** Editor-ready `<ref>{{cite ...}}</ref>` snippet that replaces the {{cn}} tag. */
  ref: string;
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
  /**
   * Wiki-local candidates found before (and possibly instead of) the web
   * search, including the ones with no fetchable URL that never reach the
   * verifier. Kept so callers can report what the free layer covered.
   */
  wikiCandidates?: WikiCandidate[];
  /** True when the web search was skipped because wiki-local sources sufficed. */
  webSearchSkipped?: boolean;
  /** If the pipeline failed for this claim, the error message. */
  error?: string;
}

/** Top-level article run result. */
export interface ArticleRun {
  article: Article;
  results: ClaimResult[];
  /** Non-fatal problems from the wiki-local stage (unreachable sister wikis…). */
  warnings?: string[];
}

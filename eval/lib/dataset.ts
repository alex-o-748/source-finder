/**
 * The evaluation set's on-disk shape, and how a recorded claim is found again
 * in a replayed article.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractClaims } from "../../src/core/extractClaims.js";
import { articleUrl } from "../../src/core/fetchArticle.js";
import type { Claim } from "../../src/core/types.js";

export const EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CASSETTE_DIR = join(EVAL_DIR, "cassettes");

export interface EvalClaim {
  /** `Title@revid#offset` — the tag's position in that exact revision. */
  id: string;
  /** Subject stratum it was drawn from (eval/strata.ts). */
  stratum: string;
  /** Whether the stratum is one where a digitised book is a plausible source. */
  bookLeaning: boolean;
  lang: string;
  title: string;
  revid: number;
  /** Character offset of the {{cn}} tag in the revision's wikitext. */
  offset: number;
  tag: string;
  section: string | null;
  /** The claim as the extractor read it when the set was drawn. */
  claim: string;
  context: string;
  /** How many {{cn}}-family tags the whole article carries. */
  tagsInArticle: number;
}

export function loadClaims(): EvalClaim[] {
  return JSON.parse(readFileSync(join(EVAL_DIR, "claims.json"), "utf8")) as EvalClaim[];
}

/**
 * The claim at the recorded tag, as the *current* extractor reads it. Matching
 * on the tag's offset rather than on the text means an extractor change shows
 * up as a different claim text, not as a lost claim.
 */
export function claimAt(wikitext: string, offset: number): Claim | undefined {
  return extractClaims(wikitext).find((c) => c.offset === offset);
}

/** What `fetchArticle` takes for a claim's article: its URL, which carries the language. */
export function articleRef(c: Pick<EvalClaim, "lang" | "title">): string {
  return articleUrl(c.lang, c.title);
}

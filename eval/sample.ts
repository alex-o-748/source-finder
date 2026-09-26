/**
 * Draws the evaluation claims from Category:All articles with unsourced
 * statements, stratified by subject (see strata.ts), and writes
 * eval/claims.json.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx eval/sample.ts
 *
 * Every request goes through the cassette, so the article revisions the claims
 * were drawn from are the ones later runs replay. Re-running with the cassette
 * in place reproduces the same set without touching the network.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchArticle } from "../src/core/fetchArticle.js";
import { extractClaims } from "../src/core/extractClaims.js";
import { mwApi } from "../src/core/mediawiki.js";
import type { Claim } from "../src/core/types.js";
import { installCassette } from "./lib/http.js";
import { CATEGORY, STRATA } from "./strata.js";
import { EVAL_DIR, CASSETTE_DIR, type EvalClaim } from "./lib/dataset.js";

const SEARCH_SIZE = 40;
const MAX_ARTICLE_BYTES = 300_000;

const stats = installCassette({
  dir: CASSETTE_DIR,
  mode: process.argv.includes("--replay") ? "replay" : "record",
  log: (line) => console.error(line),
});

interface SearchResponse {
  query?: { search?: { title: string; size: number }[] };
}

/** Deterministic per-title choice, so a re-run picks the same claim. */
function seededIndex(seed: string, n: number): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % n;
}

/**
 * Claims a human would recognise as a sentence. Tags inside tables, infobox
 * parameters and bare list fragments are real, but the extractor has nothing to
 * work with there; they are counted as skipped rather than drawn.
 */
export function usableClaim(c: Claim): string | null {
  const text = c.claim;
  if (text.length < 30) return "too short";
  if (text.length > 700) return "too long";
  if (/^[|!{]/.test(text) || text.includes("||")) return "table or template";
  if (text.split(/\s+/).length < 5) return "too few words";
  return null;
}

async function main(): Promise<void> {
  const claims: EvalClaim[] = [];
  const seen = new Set<string>();
  const skipped: Record<string, number> = {};

  for (const stratum of STRATA) {
    const data = await mwApi<SearchResponse>("en", {
      action: "query",
      list: "search",
      srsearch: `incategory:"${CATEGORY}" ${stratum.search}`,
      srsort: "random",
      srlimit: String(SEARCH_SIZE),
      srnamespace: "0",
      srprop: "size",
    });
    const pages = data.query?.search ?? [];
    let taken = 0;
    for (const page of pages) {
      if (taken >= stratum.quota) break;
      if (seen.has(page.title)) continue;
      if (page.size > MAX_ARTICLE_BYTES || /^List of|\(disambiguation\)$/.test(page.title)) {
        skipped["list, disambiguation or oversized"] = (skipped["list, disambiguation or oversized"] ?? 0) + 1;
        continue;
      }
      seen.add(page.title);
      const article = await fetchArticle(page.title);
      const all = extractClaims(article.wikitext);
      const usable = all.filter((c) => {
        const why = usableClaim(c);
        if (why) skipped[why] = (skipped[why] ?? 0) + 1;
        return !why;
      });
      if (usable.length === 0) {
        skipped["no usable claim"] = (skipped["no usable claim"] ?? 0) + 1;
        continue;
      }
      const claim = usable[seededIndex(article.title, usable.length)];
      claims.push({
        id: `${article.title}@${article.revid}#${claim.offset}`,
        stratum: stratum.id,
        bookLeaning: stratum.bookLeaning,
        lang: article.lang,
        title: article.title,
        revid: article.revid,
        offset: claim.offset,
        tag: claim.tag,
        section: claim.section,
        claim: claim.claim,
        context: claim.context,
        tagsInArticle: all.length,
      });
      taken++;
      console.error(`[${stratum.id} ${taken}/${stratum.quota}] ${article.title}: ${claim.claim.slice(0, 90)}`);
    }
    if (taken < stratum.quota) console.error(`! ${stratum.id}: only ${taken}/${stratum.quota}`);
  }

  writeFileSync(join(EVAL_DIR, "claims.json"), JSON.stringify(claims, null, 2) + "\n");
  console.error(
    `\n${claims.length} claims written. skipped: ${JSON.stringify(skipped)}\n` +
      `requests: ${stats.hits} replayed, ${stats.recorded} recorded, ${stats.retries} retries`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

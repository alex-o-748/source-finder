import { findArticleWikiSources } from "../../core/wikiSources.js";

interface WikiArgs {
  urlOrTitle: string;
  maxClaims?: number;
  sisterWikis?: number;
  json: boolean;
}

/**
 * The wiki-local stage on its own: which {{cn}} claims can be answered from
 * citations Wikimedia already holds, with no model and no API key.
 */
export async function wikiCommand(args: WikiArgs): Promise<void> {
  const run = await findArticleWikiSources(args.urlOrTitle, {
    maxClaims: args.maxClaims,
    maxSisterWikis: args.sisterWikis,
  });

  if (args.json) {
    const { wikitext: _omit, ...article } = run.article;
    void _omit;
    process.stdout.write(
      JSON.stringify(
        { article, results: run.results, warnings: run.warnings },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const covered = run.results.filter((r) => r.candidates.length > 0).length;
  console.log(`# ${run.article.title}`);
  console.log(`  ${run.article.url}`);
  console.log(
    `  ${covered}/${run.results.length} claim(s) have a wiki-local lead`,
  );
  for (const warning of run.warnings) console.log(`  ! ${warning}`);
  console.log();

  run.results.forEach((r, i) => {
    console.log(`## [${i + 1}] ${r.claim.section ?? "(no section)"}`);
    console.log(`    claim: ${r.claim.claim}`);
    if (r.candidates.length === 0) {
      console.log("    (nothing on wiki — this one needs a web search)");
      console.log();
      return;
    }
    r.candidates.forEach((c, j) => {
      const mark = c.evidence.origin === "sister-wiki" ? "🌐" : "📄";
      console.log(
        `    ${mark} [${j + 1}] ${c.title}  (match ${c.evidence.score})`,
      );
      console.log(`       ${c.url ?? "(no URL — offline source)"}`);
      console.log(`       ${c.relevance}`);
      if (c.evidence.matchedAnchors?.length) {
        console.log(`       matched: ${c.evidence.matchedAnchors.join(", ")}`);
      }
      console.log(`       ref:  ${c.ref}`);
    });
    console.log();
  });

  console.log(
    "Leads, not verdicts: each one is a source a human editor cited for a similar",
  );
  console.log(
    "sentence. Read it before pasting — use `cnfirmed verify` to check one.",
  );
}

import { findArticleWikiSources } from "../../core/wikiSources.js";

interface WikiArgs {
  urlOrTitle: string;
  maxClaims?: number;
  sisterWikis?: number;
  skipWikidata?: boolean;
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
    skipWikidata: args.skipWikidata,
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
  // Per-origin coverage is the number Phase 2 of the plan is measuring: how
  // much of the backlog each free pass reaches on its own.
  const byOrigin = new Map<string, number>();
  for (const result of run.results) {
    for (const origin of new Set(result.candidates.map((c) => c.evidence.origin))) {
      byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + 1);
    }
  }
  console.log(`# ${run.article.title}`);
  console.log(`  ${run.article.url}`);
  console.log(
    `  ${covered}/${run.results.length} claim(s) have a wiki-local lead`,
  );
  if (byOrigin.size > 0) {
    const breakdown = [...byOrigin]
      .sort((a, b) => b[1] - a[1])
      .map(([origin, n]) => `${origin} ${n}`)
      .join(", ");
    console.log(`  by origin: ${breakdown}`);
  }
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
      const mark =
        c.evidence.origin === "sister-wiki" ? "🌐"
        : c.evidence.origin === "wikidata" ? "🔗"
        : "📄";
      console.log(
        `    ${mark} [${j + 1}] ${c.title}  (match ${c.evidence.score})`,
      );
      console.log(`       ${c.url ?? "(no URL — offline source)"}`);
      console.log(`       ${c.relevance}`);
      if (c.evidence.statement) {
        console.log(
          `       statement: ${c.evidence.statement.propertyLabel} = ` +
            `${c.evidence.statement.value}  (${c.evidence.statement.entity} ` +
            `${c.evidence.statement.property})`,
        );
      }
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
    "sentence, or attached to the Wikidata statement asserting the same value.",
  );
  console.log(
    "Read it before pasting — use `cnfirmed verify` to check one.",
  );
}

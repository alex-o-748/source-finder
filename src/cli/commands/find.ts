import { runArticle } from "../../core/runArticle.js";

interface FindArgs {
  urlOrTitle: string;
  maxClaims?: number;
  json: boolean;
}

export async function findCommand(args: FindArgs): Promise<void> {
  const run = await runArticle(args.urlOrTitle, {
    maxClaims: args.maxClaims,
    onProgress: (done, total, claim) => {
      if (!args.json) {
        process.stderr.write(
          `[${done}/${total}] ${truncate(claim.claim, 80)}\n`,
        );
      }
    },
  });

  if (args.json) {
    const { wikitext: _omit, ...article } = run.article;
    void _omit;
    process.stdout.write(
      JSON.stringify({ article, results: run.results }, null, 2) + "\n",
    );
    return;
  }

  console.log(`# ${run.article.title}`);
  console.log(`  ${run.article.url}`);
  console.log(`  ${run.results.length} claim(s) processed`);
  console.log();

  run.results.forEach((r, i) => {
    console.log(`## [${i + 1}] ${r.claim.section ?? "(no section)"}`);
    console.log(`    claim: ${r.claim.claim}`);
    if (r.error) {
      console.log(`    ERROR: ${r.error}`);
      console.log();
      return;
    }
    if (r.suggestions.length === 0) {
      console.log(`    (no candidate sources found)`);
      console.log();
      return;
    }
    r.suggestions.forEach((s, j) => {
      const mark = s.verdict.supports ? "✓" : "✗";
      console.log(
        `    ${mark} [${j + 1}] (${s.verdict.confidence.toFixed(2)}) ${s.source.title}`,
      );
      console.log(`       ${s.source.url}`);
      if (s.verdict.supportingQuote) {
        console.log(`       quote: ${truncate(s.verdict.supportingQuote, 160)}`);
      }
      console.log(`       ${s.verdict.reasoning}`);
      if (s.verdict.supports) {
        console.log(`       cite: ${s.citation.template}`);
      }
    });
    console.log();
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

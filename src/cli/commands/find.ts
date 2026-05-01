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
      const mark = verdictMark(s.verdict.verdict);
      const flag =
        s.verdict.verdict === "SUPPORTED" && s.verdict.reliability === "low"
          ? "  [low-reliability — find a better source]"
          : "";
      console.log(
        `    ${mark} [${j + 1}] ${s.verdict.verdict} (conf=${s.verdict.confidence}/100, rel=${s.verdict.reliability}) ${s.source.title}${flag}`,
      );
      console.log(`       ${s.source.url}`);
      console.log(`       ${truncate(s.verdict.comments, 240)}`);
      if (s.verdict.reliabilityReason) {
        console.log(`       reliability: ${s.verdict.reliabilityReason}`);
      }
      console.log(`       cite: ${s.citation.template}`);
      console.log(`       ref:  ${s.citation.ref}`);
    });
    console.log();
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function verdictMark(v: string): string {
  switch (v) {
    case "SUPPORTED":
      return "✓";
    case "PARTIALLY SUPPORTED":
      return "~";
    case "NOT SUPPORTED":
      return "✗";
    case "SOURCE UNAVAILABLE":
      return "?";
    default:
      return "•";
  }
}

import { findArticleArchiveSources } from "../../core/archiveSources.js";
import type { ArchiveFunnel } from "../../core/archiveSources.js";
import { httpArchiveClient, recordingClient } from "../../core/internetArchive.js";

interface ArchiveArgs {
  urlOrTitle: string;
  maxClaims?: number;
  /** Save every raw Archive response here, as fixtures. */
  record?: string;
  /** Put the public-domain filter in the search query (else only in the gate). */
  queryFilter: boolean;
  json: boolean;
}

function funnelLine(f: ArchiveFunnel): string {
  const rejected = Object.entries(f.rejected)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
  return (
    `${f.queries.length} quer${f.queries.length === 1 ? "y" : "ies"} → ` +
    `${f.hits} books → ${f.publicDomain}/${f.lookedUp} public domain` +
    (rejected ? ` (${rejected})` : "") +
    ` → ${f.matched}/${f.searched} with a passage → ${f.candidates} lead(s)`
  );
}

/**
 * The Internet Archive stage on its own: public-domain books whose text
 * carries each {{cn}} claim. No model, no API key. Prints how many books
 * survive each step of the funnel, which is what says whether the stage is
 * worth wiring into `find`.
 */
export async function archiveCommand(args: ArchiveArgs): Promise<void> {
  const client = args.record
    ? recordingClient(httpArchiveClient, args.record)
    : httpArchiveClient;
  const run = await findArticleArchiveSources(args.urlOrTitle, {
    maxClaims: args.maxClaims,
    filterInQuery: args.queryFilter,
    client,
    onProgress: args.json
      ? undefined
      : (done, total) => process.stderr.write(`\r  searched ${done}/${total}`),
  });
  if (!args.json) process.stderr.write("\r\x1b[K");

  if (args.json) {
    const { wikitext: _omit, ...article } = run.article;
    void _omit;
    process.stdout.write(JSON.stringify({ article, results: run.results }, null, 2) + "\n");
    return;
  }

  const covered = run.results.filter((r) => r.candidates.length > 0).length;
  console.log(`# ${run.article.title}`);
  console.log(`  ${run.article.url}`);
  console.log(`  ${covered}/${run.results.length} claim(s) have an Internet Archive lead`);
  if (args.record) console.log(`  raw responses saved to ${args.record}`);
  console.log();

  run.results.forEach((r, i) => {
    console.log(`## [${i + 1}] ${r.claim.section ?? "(no section)"}`);
    console.log(`    claim:  ${r.claim.claim}`);
    console.log(`    funnel: ${funnelLine(r.funnel)}`);
    if (r.funnel.queries.length === 0) {
      console.log("    (no number or name to search for)");
    }
    for (const q of r.funnel.queries) console.log(`    query:  ${q}`);
    for (const e of r.funnel.errors) console.log(`    ! ${e}`);
    r.candidates.forEach((c, j) => {
      console.log(`    📚 [${j + 1}] ${c.title}  (match ${c.evidence.score}, via ${c.evidence.passageFrom})`);
      console.log(`       ${c.url}`);
      console.log(`       ${c.relevance}`);
      console.log(`       "${c.snippet}"`);
      console.log(`       ref:  ${c.citation.ref}`);
    });
    console.log();
  });

  console.log("Leads, not verdicts: the passage carries the claim's numbers and names, which");
  console.log("is not the same as stating it. Read it before pasting. Old sources may be");
  console.log("outdated — see WP:AGEMATTERS.");
}

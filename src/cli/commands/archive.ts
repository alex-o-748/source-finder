import { findArticleArchiveSources } from "../../core/archiveSources.js";
import type { ArchiveFunnel } from "../../core/archiveSources.js";
import { httpArchiveClient, recordingClient } from "../../core/internetArchive.js";

interface ArchiveArgs {
  urlOrTitle: string;
  maxClaims?: number;
  /** Save every raw Archive response here, as fixtures. */
  record?: string;
  /** Ask the search to filter to public domain (else only the gate does). */
  searchFilter: boolean;
  json: boolean;
}

function funnelLine(f: ArchiveFunnel): string {
  const rejected = Object.entries(f.rejected)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
  return (
    `${f.queries.length} quer${f.queries.length === 1 ? "y" : "ies"} → ` +
    `${f.hits} books → ${f.publicDomain} public domain` +
    (rejected ? ` (dropped: ${rejected})` : "") +
    ` → ${f.matched} with a matching passage → ${f.candidates} lead(s)` +
    (f.filter === "gate only" ? "  [search unfiltered]" : "")
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
    filterInSearch: args.searchFilter,
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
    if (r.funnel.queries.length === 0) {
      console.log("    (no number or name to search for)");
      console.log();
      return;
    }
    console.log(`    funnel: ${funnelLine(r.funnel)}`);
    for (const q of r.funnel.queries) console.log(`    query:  ${q}`);
    for (const e of r.funnel.errors) console.log(`    ! ${e}`);
    r.candidates.forEach((c, j) => {
      console.log(`    📚 [${j + 1}] ${c.title}  (match ${c.evidence.score})`);
      console.log(`       ${c.evidence.viewerUrl}`);
      console.log(`       ${c.relevance}`);
      for (const p of c.evidence.passages.slice(0, 2)) console.log(`       "${p}"`);
      console.log(`       ref:  ${c.citation.ref}`);
    });
    console.log();
  });

  console.log("Leads, not verdicts: the passage carries the claim's numbers and names, which");
  console.log("is not the same as stating it. Read it — and add |page= — before pasting.");
  console.log("Old sources may be outdated: see WP:AGEMATTERS.");
}

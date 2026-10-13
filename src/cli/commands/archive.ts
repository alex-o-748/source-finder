import { findArticleArchiveSources } from "../../core/archiveSources.js";
import { passageSummary } from "../../core/archiveSources.js";
import type { ArchiveFunnel } from "../../core/archiveSources.js";
import { httpArchiveClient, recordingClient } from "../../core/internetArchive.js";
import { completeFromCitoid } from "../../core/citoid.js";
import {
  DEFAULT_LIBRARIAN_MODELS,
  judgeArchiveBooks,
  workerChatClient,
  type ArchiveVerdict,
} from "../../core/archiveLibrarian.js";

interface ArchiveArgs {
  urlOrTitle: string;
  maxClaims?: number;
  /** Save every raw Archive response here, as fixtures. */
  record?: string;
  /** Read the whole text of open books for a longer passage. */
  fullText?: boolean;
  /** The planner, named books and the search inside every lead (default on). */
  librarian?: boolean;
  /** Check every lead's passages against the claim, one model call per claim. */
  check?: boolean;
  json: boolean;
}

function funnelLine(f: ArchiveFunnel): string {
  const rejected = Object.entries(f.rejected)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
  return (
    `${f.queries.length} quer${f.queries.length === 1 ? "y" : "ies"} → ` +
    `${f.hits} books → ${f.available} readable (${f.borrowable} to borrow)` +
    (rejected ? ` (dropped: ${rejected})` : "") +
    ` → ${f.matched} with a matching passage, ${f.byUnits} by claim phrases` +
    (f.fullText ? ` → ${f.fullText.read} whole text(s) read, ${f.fullText.windows} with a passage` : "") +
    (f.librarian ? ` → ${librarianLine(f)}` : "") +
    ` → ${f.candidates} lead(s)`
  );
}

/** The librarian's part of the funnel: "planner 3 queries, 12 books; named 4 of 6 readable; 3 terms searched inside; +5 lead(s)". */
export function librarianLine(f: ArchiveFunnel): string {
  const l = f.librarian!;
  return (
    `planner ${l.plan ? `${l.plan.queries.length} quer${l.plan.queries.length === 1 ? "y" : "ies"}, ${l.planned} books` : "gave no plan"}; ` +
    `named ${l.namedFound} of ${l.named.length} readable; ` +
    `${l.shelfTerms.length} term(s) searched inside; +${l.added} lead(s)`
  );
}

/**
 * The Internet Archive stage on its own: books — open, or borrowable with a
 * free account — whose text carries each {{cn}} claim. No model, no API key.
 * Prints how many books survive each step of the funnel, which is what says
 * whether the stage is worth wiring into `find`.
 */
export async function archiveCommand(args: ArchiveArgs): Promise<void> {
  const client = args.record
    ? recordingClient(httpArchiveClient, args.record)
    : httpArchiveClient;
  const chat = args.librarian === false && !args.check ? null : workerChatClient();
  const run = await findArticleArchiveSources(args.urlOrTitle, {
    maxClaims: args.maxClaims,
    client,
    fullText: args.fullText,
    ...(args.librarian !== false && chat && { librarian: { client: chat } }),
    onProgress: args.json
      ? undefined
      : (done, total) => process.stderr.write(`\r  searched ${done}/${total}`),
  });
  if (!args.json) process.stderr.write("\r\x1b[K");

  // The check: every lead of a claim in one call, against the restated claim.
  const checks: ((ArchiveVerdict | null)[] | string)[] = [];
  if (args.check && chat && DEFAULT_LIBRARIAN_MODELS.judge) {
    for (const r of run.results) {
      try {
        checks.push(
          await judgeArchiveBooks(
            {
              articleTitle: run.article.title,
              section: r.claim.section,
              paragraph: r.claim.context,
              claim: r.claim.claim,
              fact: r.funnel.librarian?.plan?.fact || null,
            },
            r.candidates.map((c) => ({ title: c.title, year: c.evidence.year, passages: c.evidence.passages })),
            chat,
            DEFAULT_LIBRARIAN_MODELS.judge,
          ),
        );
      } catch (err) {
        checks.push(`check failed: ${(err as Error).message}`);
      }
    }
  }

  // Every field the catalogue has for a lead's ISBN, as ProveIt fills a template.
  for (const r of run.results) {
    for (const c of r.candidates) c.citation = await completeFromCitoid(c.citation, run.article.lang);
  }

  if (args.json) {
    const { wikitext: _omit, ...article } = run.article;
    void _omit;
    const results = run.results.map((r, i) => (args.check ? { ...r, check: checks[i] ?? null } : r));
    process.stdout.write(JSON.stringify({ article, results }, null, 2) + "\n");
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
    if (r.funnel.queries.length === 0 && !r.candidates.length && !r.funnel.librarian?.plan?.queries.length) {
      console.log("    (nothing to search for)");
      console.log();
      return;
    }
    console.log(`    funnel: ${funnelLine(r.funnel)}`);
    console.log(`    passages: ${passageSummary(r.funnel.passages)}`);
    for (const q of r.funnel.queries) console.log(`    query:  ${q}`);
    const plan = r.funnel.librarian?.plan;
    if (plan) {
      console.log(`    restated: ${plan.fact}`);
      for (const q of plan.queries) console.log(`    planner query: ${q}`);
    }
    for (const b of r.funnel.librarian?.named ?? []) {
      console.log(`    named:  ${b.author ?? "?"}, ${b.title}${b.year ? ` (${b.year})` : ""}`);
    }
    for (const e of r.funnel.errors) console.log(`    ! ${e}`);
    const check = checks[i];
    if (typeof check === "string") console.log(`    ! ${check}`);
    r.candidates.forEach((c, j) => {
      const access = c.evidence.access === "borrow" ? ", borrow" : "";
      const whole = c.evidence.fullText ? ", whole text" : "";
      const via = c.evidence.via ? `, ${c.evidence.via === "named" ? "named by the model" : "planner's query"}` : "";
      console.log(`    📚 [${j + 1}] ${c.title}  (match ${c.evidence.score}${access}${whole}${via})`);
      const v = Array.isArray(check) ? check[j] : undefined;
      if (v) console.log(`       check: ${v.verdict}${v.quote ? ` — "${v.quote}"` : ""}${v.reason ? ` (${v.reason})` : ""}`);
      console.log(`       ${c.evidence.viewerUrl}`);
      console.log(`       ${c.relevance}`);
      for (const p of c.evidence.passages.slice(0, 2)) console.log(`       "${p}"`);
      console.log(`       ref:  ${c.citation.ref}`);
    });
    console.log();
  });

  console.log("Leads, not verdicts: the passage carries the claim's numbers and names, which");
  console.log("is not the same as stating it, and a model's check can be wrong too. Read it —");
  console.log("and add |page= — before pasting.");
  console.log("Borrowable books need a free archive.org account to read. Old sources may be");
  console.log("outdated: see WP:AGEMATTERS.");
}

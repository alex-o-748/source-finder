#!/usr/bin/env node
import { Command } from "commander";
import { findCommand } from "./commands/find.js";
import { verifyCommand } from "./commands/verify.js";
import { extractCommand } from "./commands/extract.js";

const program = new Command();

program
  .name("cnfirmed")
  .description(
    "Find and verify sources for Wikipedia {{citation needed}} claims using Claude.",
  )
  .version("0.1.0");

program
  .command("find")
  .argument("<url-or-title>", "Wikipedia URL or bare article title")
  .option("--max-claims <n>", "cap the number of claims processed", parseIntArg)
  .option("--json", "emit machine-readable JSON", false)
  .description(
    "End-to-end: extract {{cn}} claims, find candidate sources, verify, and format citations.",
  )
  .action(async (urlOrTitle: string, opts: { maxClaims?: number; json: boolean }) => {
    await findCommand({
      urlOrTitle,
      maxClaims: opts.maxClaims,
      json: opts.json,
    });
  });

program
  .command("verify")
  .requiredOption("--claim <text>", "the claim text to evaluate")
  .requiredOption("--source <url>", "candidate source URL")
  .option("--json", "emit machine-readable JSON", false)
  .description(
    "Ask Claude whether a specific source substantiates a specific claim.",
  )
  .action(async (opts: { claim: string; source: string; json: boolean }) => {
    await verifyCommand(opts);
  });

program
  .command("extract")
  .argument("<url-or-title>", "Wikipedia URL or bare article title")
  .option("--json", "emit machine-readable JSON", false)
  .description(
    "Debug: fetch an article and list every {{citation needed}} claim found.",
  )
  .action(async (urlOrTitle: string, opts: { json: boolean }) => {
    await extractCommand({ urlOrTitle, json: opts.json });
  });

function parseIntArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`expected a positive integer, got "${raw}"`);
  }
  return n;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`cnfirmed: ${msg}\n`);
  process.exit(1);
});

#!/usr/bin/env node
import { Command } from "commander";
import { findCommand } from "./commands/find.js";
import { verifyCommand } from "./commands/verify.js";
import { extractCommand } from "./commands/extract.js";
import { wikiCommand } from "./commands/wiki.js";

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
  .option(
    "--sister-wikis <n>",
    "language editions to mine for citations (0 disables)",
    parseCountArg,
  )
  .option("--no-wiki", "skip the wiki-local stage and go straight to web search")
  .option("--wiki-only", "never run the web search, whatever the wiki stage finds", false)
  .option(
    "--always-web",
    "run the web search even when a wiki-local source already substantiates",
    false,
  )
  .option("--json", "emit machine-readable JSON", false)
  .description(
    "End-to-end: extract {{cn}} claims, find candidate sources (wiki-local first, then web), verify, and format citations.",
  )
  .action(
    async (
      urlOrTitle: string,
      opts: {
        maxClaims?: number;
        sisterWikis?: number;
        wiki: boolean;
        wikiOnly: boolean;
        alwaysWeb: boolean;
        json: boolean;
      },
    ) => {
      await findCommand({
        urlOrTitle,
        maxClaims: opts.maxClaims,
        sisterWikis: opts.sisterWikis,
        skipWikiSources: !opts.wiki,
        wikiOnly: opts.wikiOnly,
        alwaysWebSearch: opts.alwaysWeb,
        json: opts.json,
      });
    },
  );

program
  .command("wiki")
  .argument("<url-or-title>", "Wikipedia URL or bare article title")
  .option("--max-claims <n>", "cap the number of claims processed", parseIntArg)
  .option(
    "--sister-wikis <n>",
    "language editions to mine for citations (default 4)",
    parseCountArg,
  )
  .option("--json", "emit machine-readable JSON", false)
  .description(
    "Free stage only: look for citations in this article and other language editions. No model, no API key.",
  )
  .action(
    async (
      urlOrTitle: string,
      opts: { maxClaims?: number; sisterWikis?: number; json: boolean },
    ) => {
      await wikiCommand({
        urlOrTitle,
        maxClaims: opts.maxClaims,
        sisterWikis: opts.sisterWikis,
        json: opts.json,
      });
    },
  );

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

/** Like `parseIntArg` but allows 0, which turns a stage off. */
function parseCountArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`expected a non-negative integer, got "${raw}"`);
  }
  return n;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`cnfirmed: ${msg}\n`);
  process.exit(1);
});

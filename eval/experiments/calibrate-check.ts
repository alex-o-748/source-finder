/**
 * The production check (src/core/archiveLibrarian.ts: one call per claim,
 * every book at once, quotes verified) against the hand labels, on the leads
 * today's search proposes for the book-plausible claims. The restated claim is
 * the one gpt-oss-20b wrote in the experiment (results/worker.json), as the
 * planner would in production.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx eval/experiments/calibrate-check.ts [--model zai-org/GLM-5.2] [--no-fact]
 */
import { readFileSync } from "node:fs";
import { judgeArchiveBooks, type ChatClient } from "../../src/core/archiveLibrarian.js";
import { chatVia, pool } from "./lib.js";

const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "zai-org/GLM-5.2";
const useFact = !args.includes("--no-fact");

const claims = JSON.parse(readFileSync("eval/claims.json", "utf8")) as { id: string; title: string; section: string | null; context: string }[];
const gold = JSON.parse(readFileSync("eval/gold.json", "utf8")) as Record<string, { claim: string; bookPlausible: boolean }>;
const labels = JSON.parse(readFileSync("eval/labels.json", "utf8")) as Record<string, Record<string, { verdict: string }>>;
const baseline = JSON.parse(readFileSync("eval/results/baseline.json", "utf8")) as {
  id: string;
  archive: { key: string; title: string; evidence: string[]; where: string }[];
}[];
const plans = new Map(
  (JSON.parse(readFileSync("eval/experiments/results/worker.json", "utf8")) as { id: string; plan: { fact: string } }[]).map((r) => [r.id, r.plan]),
);

const prose = (w: string) =>
  w
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();

const client: ChatClient = {
  chat: (m, system, user, maxTokens) => chatVia("judge", "/hf", m, system, user, maxTokens),
};

const matrix: Record<string, Record<string, number>> = {};
let calls = 0;
await pool(
  claims.filter((c) => gold[c.id]?.bookPlausible),
  3,
  async (c) => {
    const leads = baseline.find((b) => b.id === c.id)?.archive ?? [];
    if (!leads.length) return;
    const books = leads.map((l) => ({ title: l.title, year: null, passages: l.evidence }));
    const fact = useFact ? plans.get(c.id)?.fact || null : null;
    let verdicts;
    try {
      calls++;
      verdicts = await judgeArchiveBooks(
        { articleTitle: c.title, section: c.section, paragraph: prose(c.context), claim: gold[c.id].claim, fact },
        books,
        client,
        model,
      );
    } catch (e) {
      console.log(`  ${c.title}: ${(e as Error).message}`);
      return;
    }
    leads.forEach((l, k) => {
      const label = labels[c.id]?.[l.key]?.verdict ?? "?";
      const v = verdicts[k]?.verdict ?? "none";
      (matrix[label] ??= {})[v] = (matrix[label]?.[v] ?? 0) + 1;
      const good = label === "supports" || label === "partial";
      const kept = v === "supports" || v === "partial";
      if (good !== kept) console.log(`  disagree ${c.title} | ${l.key} | label ${label} | check ${v}: ${verdicts[k]?.reason.slice(0, 150) ?? ""}`);
    });
  },
);
console.log(`\nlabel → ${model} (batched${useFact ? ", restated claim" : ""}), ${calls} calls`);
for (const [label, row] of Object.entries(matrix)) console.log(`  ${label.padEnd(10)} ${JSON.stringify(row)}`);

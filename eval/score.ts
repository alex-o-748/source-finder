/**
 * Scores a run (eval/results/<name>.json) against the hand-made answers:
 *
 *   eval/gold.json    per claim: the sentence the tag is really on, and whether
 *                     a digitised book is a plausible source for it
 *   eval/labels.json  per claim and lead: does the lead's evidence state the
 *                     claim's fact?
 *
 *   npx tsx eval/score.ts                        # results/latest.json
 *   npx tsx eval/score.ts --run baseline         # another run
 *   npx tsx eval/score.ts --against baseline     # and what changed since it
 *   npx tsx eval/score.ts --unlabelled           # list leads nobody has judged yet
 *
 * Verdicts, judged from the evidence the tool shows an editor (the sentence the
 * citation is attached to, or the book passage):
 *   supports   it states the claim's specific fact
 *   partial    it states part of it (one of two facts; the year but not the place)
 *   topic      same subject, different fact
 *   unrelated  not about the claim at all
 *   unknown    cannot be told without reading the source itself
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_DIR } from "./lib/dataset.js";
import type { ClaimResult, Lead } from "./run.js";

export type Verdict = "supports" | "partial" | "topic" | "unrelated" | "unknown";

export interface Gold {
  /** The claim as a careful reader would state it: the tagged sentence, clean. */
  claim: string;
  /** Whether a digitised book is a plausible source (history, not current events). */
  bookPlausible: boolean;
  note?: string;
}

export interface Label {
  verdict: Verdict;
  why: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readJson<T>(file: string, fallback: T): T {
  const path = join(EVAL_DIR, file);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

const ORIGINS: Lead["origin"][] = ["same-article", "sister-wiki", "internet-archive"];
const GOOD = new Set<Verdict>(["supports", "partial"]);

function words(s: string): string[] {
  return s.toLowerCase().replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Token F1 between the claim the tool read and the gold claim. */
export function claimF1(read: string, gold: string): number {
  const a = words(read);
  const b = words(gold);
  if (a.length === 0 || b.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const w of b) pool.set(w, (pool.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of a) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      common++;
      pool.set(w, n - 1);
    }
  }
  if (common === 0) return 0;
  const p = common / a.length;
  const r = common / b.length;
  return (2 * p * r) / (p + r);
}

function pct(n: number, d: number): string {
  return d === 0 ? "   –" : `${String(Math.round((100 * n) / d)).padStart(3)}%`;
}

function main(): void {
  const runName = arg("run") ?? "latest";
  const results = readJson<ClaimResult[]>(join("results", `${runName}.json`), []);
  const gold = readJson<Record<string, Gold>>("gold.json", {});
  const labels = readJson<Record<string, Record<string, Label>>>("labels.json", {});
  const labelOf = (r: ClaimResult, l: Lead): Label | undefined => labels[r.id]?.[l.key];
  const leadsOf = (r: ClaimResult): Lead[] => [...r.wiki, ...r.archive];

  if (process.argv.includes("--unlabelled")) {
    for (const r of results) {
      const todo = leadsOf(r).filter((l) => !labelOf(r, l));
      if (todo.length === 0) continue;
      console.log(`\n## ${r.id}\n   claim: ${gold[r.id]?.claim ?? r.claim}`);
      for (const l of todo) {
        console.log(`   - ${l.key}  [${l.origin} ${l.score}] ${l.title}  (${l.where}; matched ${l.matchedAnchors.join(", ") || "–"})`);
        for (const e of l.evidence.slice(0, 3)) console.log(`       "${e.slice(0, 400)}"`);
      }
    }
    return;
  }

  console.log(`run: ${runName} (${results.length} claims, ${Object.keys(gold).length} with gold)`);

  // Extraction: is the tool reading the right sentence?
  const withGold = results.filter((r) => gold[r.id]);
  const f1s = withGold.map((r) => claimF1(r.claim ?? "", gold[r.id].claim));
  const exact = f1s.filter((f) => f >= 0.9).length;
  const poor = f1s.filter((f) => f < 0.6).length;
  console.log(
    `\nclaim extraction: ${pct(exact, withGold.length)} read right (F1 ≥ 0.9), ` +
      `${pct(poor, withGold.length)} badly (F1 < 0.6); mean F1 ${(
        f1s.reduce((a, b) => a + b, 0) / Math.max(1, f1s.length)
      ).toFixed(2)}`,
  );

  // Per stage: coverage, and precision over judged leads.
  const groups: [string, ClaimResult[]][] = [
    ["all", results],
    ["book-plausible", results.filter((r) => gold[r.id]?.bookPlausible)],
    ["not book-plausible", results.filter((r) => gold[r.id] && !gold[r.id].bookPlausible)],
  ];
  for (const [label, rs] of groups) {
    if (rs.length === 0) continue;
    console.log(`\n${label} (${rs.length} claims)`);
    console.log("  stage             any lead   good lead   top lead good   leads  judged  precision");
    for (const origin of [...ORIGINS, "any" as const]) {
      const pick = (r: ClaimResult) => leadsOf(r).filter((l) => origin === "any" || l.origin === origin);
      const withLead = rs.filter((r) => pick(r).length > 0);
      const withGood = rs.filter((r) => pick(r).some((l) => GOOD.has(labelOf(r, l)?.verdict as Verdict)));
      const topGood = withLead.filter((r) => {
        const top = [...pick(r)].sort((a, b) => b.score - a.score)[0];
        return GOOD.has(labelOf(r, top)?.verdict as Verdict);
      });
      const all = rs.flatMap((r) => pick(r).map((l) => labelOf(r, l)));
      const judged = all.filter((l) => l && l.verdict !== "unknown");
      const good = judged.filter((l) => GOOD.has(l!.verdict));
      console.log(
        `  ${origin.padEnd(16)}  ${pct(withLead.length, rs.length)}      ${pct(withGood.length, rs.length)}` +
          `        ${pct(topGood.length, withLead.length)}      ${String(all.length).padStart(5)}  ${String(judged.length).padStart(6)}` +
          `     ${pct(good.length, judged.length)}`,
      );
    }
  }

  const unlabelled = results.reduce((n, r) => n + leadsOf(r).filter((l) => !labelOf(r, l)).length, 0);
  const errors = results.filter((r) => r.errors.length).length;
  console.log(`\n${unlabelled} lead(s) not yet judged (--unlabelled lists them); ${errors} claim(s) with errors`);

  const against = arg("against");
  if (against) {
    const before = new Map(readJson<ClaimResult[]>(join("results", `${against}.json`), []).map((r) => [r.id, r]));
    console.log(`\nchanges since ${against}:`);
    let changed = 0;
    for (const r of results) {
      const b = before.get(r.id);
      if (!b) continue;
      const was = new Set(leadsOf(b).map((l) => l.key));
      const now = new Set(leadsOf(r).map((l) => l.key));
      const gained = leadsOf(r).filter((l) => !was.has(l.key));
      const lost = leadsOf(b).filter((l) => !now.has(l.key));
      const claimMoved = b.claim !== r.claim;
      if (!gained.length && !lost.length && !claimMoved) continue;
      changed++;
      console.log(`  ${r.id}`);
      if (claimMoved) console.log(`    claim: "${b.claim?.slice(0, 80)}" → "${r.claim?.slice(0, 80)}"`);
      for (const l of gained) console.log(`    + ${l.origin} ${l.key} (${labelOf(r, l)?.verdict ?? "unjudged"})`);
      for (const l of lost) console.log(`    - ${l.origin} ${l.key} (${labelOf(b, l)?.verdict ?? "unjudged"})`);
    }
    if (changed === 0) console.log("  none");
  }
}

main();

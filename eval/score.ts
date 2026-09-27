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

const ORIGINS: Lead["origin"][] = ["same-article", "sister-wiki", "internet-archive", "web"];
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
  const leadsOf = (r: ClaimResult): Lead[] => [...r.wiki, ...r.archive, ...(r.web ?? [])];

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
  // The headline: per method, how often it finds a source for the claim.
  // "Found" = at least one lead whose evidence states the claim's fact;
  // "found or partly" also counts a lead that states part of it.
  // With --check runs, the Archive leads the model kept count as a method of
  // their own: what an editor with a key set is shown.
  const checked = results.some((r) => r.archive.some((l) => l.check !== undefined));
  const methods: { name: string; pick: (r: ClaimResult) => Lead[] }[] = [
    ...ORIGINS.map((origin) => ({ name: origin, pick: (r: ClaimResult) => leadsOf(r).filter((l) => l.origin === origin) })),
    ...(checked
      ? [{
          name: "archive, checked",
          // As the popover shows them: what the model kept, and any lead it gave no verdict.
          pick: (r: ClaimResult) => r.archive.filter((l) => !l.check || GOOD.has(l.check.verdict as Verdict)),
        }]
      : []),
    { name: "any", pick: leadsOf },
  ];

  console.log("\nsource found, per method (share of claims)");
  console.log("  method              all claims            book-plausible        not book-plausible");
  console.log("                      found  or partly      found  or partly      found  or partly");
  for (const { name, pick } of methods) {
    const cells = groups.map(([, rs]) => {
      const has = (ok: Set<Verdict>) =>
        rs.filter((r) => pick(r).some((l) => ok.has(labelOf(r, l)?.verdict as Verdict))).length;
      return `${pct(has(new Set(["supports"])), rs.length)}   ${pct(has(GOOD), rs.length)}     `;
    });
    console.log(`  ${name.padEnd(18)}  ${cells.join("    ")}`);
  }
  console.log(
    `  claims:               ${groups.map(([, rs]) => String(rs.length).padStart(3)).join("                   ")}`,
  );

  for (const [label, rs] of groups) {
    if (rs.length === 0) continue;
    console.log(`\n${label} (${rs.length} claims)`);
    console.log("  stage             any lead   good lead   top lead good   leads  judged  precision");
    for (const { name, pick } of methods) {
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
        `  ${name.padEnd(16)}  ${pct(withLead.length, rs.length)}      ${pct(withGood.length, rs.length)}` +
          `        ${pct(topGood.length, withLead.length)}      ${String(all.length).padStart(5)}  ${String(judged.length).padStart(6)}` +
          `     ${pct(good.length, judged.length)}`,
      );
    }
  }

  if (checked) scoreCheck(results, labelOf);

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

/**
 * How the model's check of the Archive leads agrees with the hand labels: the
 * verdicts side by side, and what keeping only "supports" and "partial" costs
 * and gains.
 */
function scoreCheck(
  results: ClaimResult[],
  labelOf: (r: ClaimResult, l: Lead) => Label | undefined,
): void {
  const verdicts: Verdict[] = ["supports", "partial", "topic", "unrelated", "unknown"];
  const pairs = results.flatMap((r) =>
    r.archive.map((l) => ({ model: l.check?.verdict ?? "none", label: labelOf(r, l)?.verdict ?? "unjudged" })),
  );
  console.log("\nArchive check (model) against the labels (rows: model, columns: label)");
  console.log(`  ${"".padEnd(10)}${[...verdicts, "unjudged"].map((v) => v.padStart(10)).join("")}`);
  for (const m of ["supports", "partial", "topic", "unrelated", "none"]) {
    const row = [...verdicts, "unjudged"].map((v) =>
      String(pairs.filter((p) => p.model === m && p.label === v).length).padStart(10),
    );
    console.log(`  ${m.padEnd(10)}${row.join("")}`);
  }
  const judged = pairs.filter((p) => p.label !== "unjudged" && p.label !== "unknown");
  const kept = judged.filter((p) => GOOD.has(p.model as Verdict));
  const good = judged.filter((p) => GOOD.has(p.label as Verdict));
  const keptGood = kept.filter((p) => GOOD.has(p.label as Verdict));
  console.log(
    `  kept ${kept.length} of ${judged.length} judged leads: precision ${pct(keptGood.length, kept.length).trim()}` +
      ` (all leads: ${pct(good.length, judged.length).trim()}); good leads kept ${keptGood.length} of ${good.length}` +
      `; ${pairs.filter((p) => p.model === "none").length} lead(s) with no verdict`,
  );
}

main();

/**
 * Prints every book a run's judge kept, with the passage it quoted and which
 * strategies found the book, for checking by hand.
 *
 *   npx tsx eval/experiments/review.ts manual [--supports]
 */
import { readFileSync } from "node:fs";

const name = process.argv[2] ?? "latest";
const onlySupports = process.argv.includes("--supports");
const results = JSON.parse(readFileSync(`eval/experiments/results/${name}.json`, "utf8")) as {
  id: string;
  title: string;
  claim: string;
  plan: { fact: string };
  leads: { strategy: string; identifier: string; title: string; year: number | null; access: string }[];
  verdicts: Record<string, { verdict: string; quote: string; why: string }>;
  confirmed: Record<string, { verdict: string; quote: string; why: string }>;
}[];

for (const r of results) {
  const kept = Object.entries(r.verdicts).filter(([, v]) => (onlySupports ? v.verdict === "supports" : v.verdict !== "no"));
  if (!kept.length) continue;
  console.log(`\n## ${r.title}: ${r.claim}\n   (${r.plan.fact})`);
  for (const [id, v] of kept) {
    const ls = r.leads.filter((l) => l.identifier === id && l.strategy !== "baseline");
    const l = ls[0];
    const c = r.confirmed[id];
    console.log(
      `- ${v.verdict.toUpperCase()} / verify: ${c?.verdict ?? "-"} | ${id} | ${l?.title.slice(0, 60)} (${l?.year ?? "n.d."}, ${l?.access}) | by ${[...new Set(ls.map((x) => x.strategy))].join(", ")}`,
    );
    console.log(`    quote: ${v.quote.slice(0, 300)}`);
  }
}

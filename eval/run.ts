/**
 * Runs the free stages — wiki-local and Internet Archive — over every claim in
 * eval/claims.json, from the recorded responses, and writes what each stage
 * proposed to eval/results/<name>.json.
 *
 *   npx tsx eval/run.ts                    # offline replay → results/latest.json
 *   npx tsx eval/run.ts --name baseline    # same, under another name
 *   npx tsx eval/run.ts --engine core      # the Node core (CLI) instead of the user script
 *   npx tsx eval/run.ts --only military    # one stratum, or claims whose id contains the text
 *   NODE_USE_ENV_PROXY=1 npx tsx eval/run.ts --record
 *                                          # fetch and save whatever is missing
 *                                          # (4 claims at a time; --concurrency N)
 *   npx tsx eval/run.ts --web --limit 5    # also the paid web search (Claude), on 5 claims across subjects
 *   npx tsx eval/run.ts --web --model claude-sonnet-4-6 --search-tool web_search_20250305
 *                                          # the web search with another model or search tool
 *   npx tsx eval/run.ts --full-text        # also read open books' whole text (recorded to
 *                                          # eval/cassettes-fulltext/, not committed)
 *   npx tsx eval/run.ts --check --name check
 *                                          # also check the Archive leads' passages with Claude,
 *                                          # as the user script does when a key is set
 *
 * The web search and the check need CNFIRMED_ANTHROPIC_API_KEY only to record:
 * replaying a recorded call needs no key. The key travels in a header, and headers are
 * never written to disk.
 *
 * The default engine is the shipped user script, run over the rendered page as
 * in a browser: that is what an editor sees.
 *
 * Replay is the normal mode: no network, and the same answers every time. A
 * code change that makes a request nobody recorded fails that claim with
 * "not recorded", and `--record` fills the gap (it needs network access).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchArticle } from "../src/core/fetchArticle.js";
import { findWikiCandidates, loadWikiCorpus } from "../src/core/wikiSources.js";
import { findArchiveCandidates } from "../src/core/archiveSources.js";
import type { ArchiveFunnel } from "../src/core/archiveSources.js";
import { installCassette } from "./lib/http.js";
import { indexOfClaim, loadScriptArticle } from "./lib/userscript.js";
import {
  CASSETTE_DIR,
  EVAL_DIR,
  FULLTEXT_CASSETTE_DIR,
  articleRef,
  claimAt,
  loadClaims,
  type EvalClaim,
} from "./lib/dataset.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const record = process.argv.includes("--record");
const name = arg("name") ?? "latest";
const only = arg("only");
const engine = arg("engine") ?? "userscript";
if (engine !== "userscript" && engine !== "core") throw new Error(`unknown engine ${engine}`);

const concurrency = Number(arg("concurrency") ?? (record ? 4 : 1));
const web = process.argv.includes("--web");
/** Check the Archive leads with the model, as the user script does when a key is set. */
const check = process.argv.includes("--check");
/** Read the whole text of open books too (option off in the shipped script until archive.org allows it). */
const fullText = process.argv.includes("--full-text");
const limit = arg("limit") ? Number(arg("limit")) : undefined;
// The user script's own overrides, as an editor would set them in common.js.
const scriptWindow: Record<string, unknown> = {};
if (arg("model")) scriptWindow.cnfirmedModelClaude = arg("model");
if (arg("search-tool")) scriptWindow.cnfirmedSearchToolClaude = arg("search-tool");
// Node has no CORS, so the whole-text switch can be tried here before
// archive.org allows it in a browser.
if (fullText) scriptWindow.cnfirmedArchiveFullText = true;
// Deliberately not ANTHROPIC_API_KEY: Claude Code reads that name itself.
const apiKey = process.env.CNFIRMED_ANTHROPIC_API_KEY ?? "";
if ((web || check) && engine !== "userscript") {
  throw new Error("--web and --check run the user script's model calls only");
}
if ((web || check) && record && !apiKey) {
  throw new Error("recording a model call needs CNFIRMED_ANTHROPIC_API_KEY in the environment");
}

/** Model usage across the run, read off each Claude response (replayed or live). */
const usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0, ms: [] as number[] };
function tallyUsage(key: string, body: string, ms: number | undefined): void {
  if (!key.startsWith("POST api.anthropic.com/v1/messages")) return;
  if (ms !== undefined) usage.ms.push(ms);
  try {
    const u = (JSON.parse(body) as { usage?: Record<string, unknown> }).usage;
    if (!u) return;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    usage.calls++;
    usage.input += n(u.input_tokens);
    usage.output += n(u.output_tokens);
    usage.cacheRead += n(u.cache_read_input_tokens);
    usage.cacheWrite += n(u.cache_creation_input_tokens);
    usage.searches += n((u.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests);
  } catch {
    // An error body: nothing to count.
  }
}

const stats = installCassette({
  dir: CASSETTE_DIR,
  dirFor: (key) => (key.startsWith("GET archive.org/stream/") ? FULLTEXT_CASSETTE_DIR : CASSETTE_DIR),
  mode: record ? "record" : "replay",
  hostConcurrency: { "archive.org": 2, "api.anthropic.com": 4 },
  hostTimeouts: { "api.anthropic.com": { ms: 600_000, retryNetworkErrors: false } },
  recordOnlyOk: ["api.anthropic.com"],
  log: (line) => console.error(line),
  observe: tallyUsage,
});

/** A lead reduced to what judging and comparing runs needs. */
export interface Lead {
  /** Stable identity across runs: URL, or the Archive identifier. */
  key: string;
  origin: "same-article" | "sister-wiki" | "internet-archive" | "web";
  title: string;
  url: string | null;
  score: number;
  matchedAnchors: string[];
  /** What the lead rests on: the sentence it was cited for, or the book passages. */
  evidence: string[];
  /** Where that evidence lives: `de:Eiffelturm`, or the book's year and access. */
  where: string;
  /** Archive leads, with --check: the model's verdict on the passages, labelled like eval/labels.json. */
  check?: { verdict: string; reason: string } | null;
}

export interface ClaimResult {
  id: string;
  stratum: string;
  bookLeaning: boolean;
  title: string;
  /** The claim as the current extractor reads it at the recorded tag. */
  claim: string | null;
  /** True when the extractor's reading differs from the one recorded in claims.json. */
  claimChanged: boolean;
  engine: string;
  /** User script only: how the recorded tag was found among the rendered ones. */
  located?: string;
  wiki: Lead[];
  wikiWarnings: string[];
  archive: Lead[];
  archiveFunnel: Omit<ArchiveFunnel, "passages"> | null;
  /** The paid web search, when run with --web. */
  web?: Lead[];
  errors: string[];
}

function normaliseKey(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
}

function emptyResult(c: EvalClaim): ClaimResult {
  return {
    id: c.id,
    stratum: c.stratum,
    bookLeaning: c.bookLeaning,
    title: c.title,
    claim: null,
    claimChanged: false,
    wiki: [],
    wikiWarnings: [],
    archive: [],
    archiveFunnel: null,
    errors: [],
    engine,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wikiLead(w: any): Lead {
  return {
    key: w.url ? normaliseKey(w.url) : `ref:${w.evidence.lang}:${String(w.evidence.refWikitext ?? w.ref).slice(0, 80)}`,
    origin: w.evidence.origin,
    title: w.title,
    url: w.url,
    score: w.evidence.score,
    matchedAnchors: w.evidence.matchedAnchors ?? [],
    evidence: [w.evidence.sentence],
    where: `${w.evidence.lang}:${w.evidence.article}`,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function archiveLead(a: any): Lead {
  return {
    // A passage from the whole text is different evidence from the search's
    // highlights, so it is judged on its own.
    key: `ia:${a.evidence.identifier}${a.evidence.fullText ? "#text" : ""}`,
    origin: "internet-archive",
    title: a.title,
    url: a.url,
    score: a.evidence.score,
    matchedAnchors: a.evidence.matchedAnchors,
    evidence: a.evidence.passages,
    where: `${a.evidence.year ?? "n.d."}, ${a.evidence.access}${a.evidence.fullText ? ", whole text" : ""}`,
  };
}

async function runScriptClaim(c: EvalClaim): Promise<ClaimResult> {
  const result = emptyResult(c);
  let page;
  try {
    page = await loadScriptArticle(c, scriptWindow);
  } catch (err) {
    result.errors.push(`page: ${(err as Error).message}`);
    return result;
  }
  const { index, how } = indexOfClaim(page, c);
  result.located = how;
  if (index === -1) {
    result.errors.push("recorded tag not found among the rendered ones");
    return result;
  }
  result.claim = page.contexts[index].claim;
  result.claimChanged = result.claim !== c.claim;
  result.wikiWarnings = page.corpus.warnings;
  try {
    result.wiki = page.findWiki(index).map(wikiLead);
  } catch (err) {
    result.errors.push(`wiki: ${(err as Error).message}`);
  }
  try {
    const archive = await page.findArchive(index);
    const { passages: _p, ...funnel } = archive.funnel;
    void _p;
    result.archiveFunnel = funnel;
    result.archive = archive.candidates.map(archiveLead);
    for (const e of archive.funnel.errors) result.errors.push(`archive: ${e}`);
    if (check && archive.candidates.length) {
      try {
        const verdicts = await page.checkArchive(index, archive.candidates, apiKey || "replay-needs-no-key");
        result.archive.forEach((lead, k) => {
          lead.check = verdicts[k] ? { verdict: verdicts[k].verdict, reason: verdicts[k].reason } : null;
        });
      } catch (err) {
        result.errors.push(`check: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    result.errors.push(`archive: ${(err as Error).message}`);
  }
  if (web) {
    try {
      result.web = (await page.findWeb(index, apiKey || "replay-needs-no-key")).map(webLead);
    } catch (err) {
      result.web = [];
      result.errors.push(`web: ${(err as Error).message}`);
    }
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function webLead(s: any): Lead {
  return {
    key: normaliseKey(s.source.url),
    origin: "web",
    title: s.source.title,
    url: s.source.url,
    score: (s.verdict.confidence ?? 0) / 100,
    matchedAnchors: [],
    // The model's own reading of the page: usually a quote plus its reasoning.
    evidence: [s.verdict.comments].filter(Boolean),
    where: `model: ${s.verdict.verdict} ${s.verdict.confidence}, reliability ${s.verdict.reliability}`,
  };
}

async function runCoreClaim(c: EvalClaim): Promise<ClaimResult> {
  const result = emptyResult(c);
  const article = await fetchArticle(articleRef(c)).catch((err: Error) => {
    result.errors.push(`article: ${err.message}`);
    return null;
  });
  if (!article) return result;
  if (article.revid !== c.revid) {
    result.errors.push(`revision moved: recorded ${c.revid}, got ${article.revid}`);
  }
  const claim = claimAt(article.wikitext, c.offset);
  if (!claim) {
    result.errors.push(`no {{cn}} tag at offset ${c.offset} any more`);
    return result;
  }
  result.claim = claim.claim;
  result.claimChanged = claim.claim !== c.claim;

  try {
    const corpus = await loadWikiCorpus(article, [claim]);
    result.wikiWarnings = corpus.warnings;
    result.wiki = findWikiCandidates(corpus, claim).map(wikiLead);
  } catch (err) {
    result.errors.push(`wiki: ${(err as Error).message}`);
  }

  try {
    const archive = await findArchiveCandidates(claim, article.title, { fullText });
    const { passages: _p, ...funnel } = archive.funnel;
    void _p;
    result.archiveFunnel = funnel;
    result.archive = archive.candidates.map(archiveLead);
    for (const e of archive.funnel.errors) result.errors.push(`archive: ${e}`);
  } catch (err) {
    result.errors.push(`archive: ${(err as Error).message}`);
  }
  return result;
}

function pct(n: number, d: number): string {
  return d === 0 ? "–" : `${Math.round((100 * n) / d)}%`;
}

async function main(): Promise<void> {
  const matching = loadClaims().filter((c) => !only || c.id.includes(only) || c.stratum === only);
  // --limit N takes N claims spread evenly over the set (it is ordered by
  // subject), so a cheap probe still covers history, sport, science…
  const step = limit ? Math.max(1, Math.floor(matching.length / limit)) : 1;
  const claims = matching.filter((_, i) => i % step === 0).slice(0, limit);
  // Claims are independent, so when recording several run at once: one waits
  // out Wikipedia's rate limit while another waits on the Archive. Each host
  // still gets its requests one (or two) at a time.
  const results: ClaimResult[] = new Array(claims.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < claims.length) {
      const i = next++;
      const c = claims[i];
      const r = engine === "core" ? await runCoreClaim(c) : await runScriptClaim(c);
      results[i] = r;
      const flag = r.errors.length ? ` ! ${r.errors.join("; ")}` : "";
      console.error(
        `[${++done}/${claims.length}] ${c.title}: wiki ${r.wiki.length}, archive ${r.archive.length}${flag}`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  mkdirSync(join(EVAL_DIR, "results"), { recursive: true });
  const out = join(EVAL_DIR, "results", `${name}${engine === "core" ? ".core" : ""}.json`);
  writeFileSync(out, JSON.stringify(results, null, 2) + "\n");

  // Coverage only: how many claims got any lead. Whether the leads are right
  // is judged separately, against eval/labels.json.
  const rows: [string, ClaimResult[]][] = [
    ["all", results],
    ["book-leaning", results.filter((r) => r.bookLeaning)],
    ["other", results.filter((r) => !r.bookLeaning)],
  ];
  console.log(`\n${results.length} claims → ${out}`);
  console.log("                 claims  same-article  sister-wiki  archive    web  any");
  for (const [label, rs] of rows) {
    const leads = (r: ClaimResult) => [...r.wiki, ...r.archive, ...(r.web ?? [])];
    const has = (o: Lead["origin"]) => rs.filter((r) => leads(r).some((l) => l.origin === o)).length;
    const any = rs.filter((r) => leads(r).length > 0).length;
    console.log(
      `  ${label.padEnd(14)} ${String(rs.length).padStart(6)}  ${pct(has("same-article"), rs.length).padStart(12)}` +
        `  ${pct(has("sister-wiki"), rs.length).padStart(11)}  ${pct(has("internet-archive"), rs.length).padStart(7)}` +
        `  ${web ? pct(has("web"), rs.length).padStart(5) : "    –"}  ${pct(any, rs.length).padStart(3)}`,
    );
  }
  const failed = results.filter((r) => r.errors.length).length;
  console.log(
    `  requests: ${stats.hits} replayed, ${stats.recorded} recorded, ${stats.misses.length} not recorded; ` +
      `${failed} claim(s) with errors`,
  );
  if (usage.calls) {
    console.log(
      `  Claude: ${usage.calls} call(s), ${usage.searches} web searches, ` +
        `${usage.input} input + ${usage.output} output tokens ` +
        `(${usage.cacheRead} cache read, ${usage.cacheWrite} cache write)`,
    );
    if (usage.ms.length) {
      const s = [...usage.ms].sort((a, b) => a - b);
      const sec = (v: number) => `${Math.round(v / 1000)}s`;
      console.log(
        `  Claude call time: median ${sec(s[Math.floor(s.length / 2)])}, slowest ${sec(s[s.length - 1])} ` +
          `(${s.length} timed)`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

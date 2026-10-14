/**
 * The user script's result log: each finished search is posted to the
 * Worker's /cnfirmed/log, which writes it to Neon. No network: `fetch` is
 * stubbed, and what is tested is the row the script sends.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const PROXY = "https://publicai-proxy.alaexis.workers.dev";

const CTX = {
  claim: "The lighthouse was first lit in 1873.",
  context: "The lighthouse was first lit in 1873. It was automated later.",
  section: "History",
  links: [],
};

/**
 * The Worker's CNFIRMED_VERDICTS (alex-o-748/public-ai-proxy, src/index.js),
 * which stores NULL for any verdict not on it. The two lists live in two
 * repositories, so this pins them: a new verdict on either side fails here,
 * which is the reminder to add it to the Worker too.
 */
const WORKER_VERDICTS = [
  "supports", "partial", "unsupported", "topic", "unrelated", "unavailable", "lead", "unchecked",
];

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

type Sent = { url: string; body: Record<string, unknown> };

function stubFetch(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("ok");
  }) as typeof fetch;
  return sent;
}

function scriptWithClaim(window: Record<string, unknown> = {}) {
  const script = loadUserScript({ wgRevisionId: 1302216593, wgCurRevisionId: 1302216593 }, { window });
  script.setClaimContexts([CTX]);
  return script;
}

test("every verdict the script can log is one the Worker stores", () => {
  const script = scriptWithClaim();
  const logged = new Set([
    ...script.logVerdicts.archive,
    ...Object.values(script.logVerdicts.web),
    "lead",
    "unchecked",
  ]);
  assert.deepEqual([...logged].sort(), [...WORKER_VERDICTS].sort());
});

test("a finished search posts one row to /cnfirmed/log", async () => {
  const sent = stubFetch();
  const script = scriptWithClaim();
  script.logSearch(0, "wiki", { status: "done", sources: [] });
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${PROXY}/cnfirmed/log`);
  const row = sent[0].body;
  assert.match(String(row.search_id), /^[0-9a-f]{16}$/);
  assert.equal(row.wiki, "en");
  assert.equal(row.article_title, "Karsten_Point_Lighthouse");
  assert.equal(row.revision_id, 1302216593);
  assert.equal(row.claim_index, 0);
  assert.equal(row.claim_text, CTX.claim);
  assert.equal(row.section, "History");
  assert.equal(row.stage, "wiki");
  assert.equal(row.status, "done");
  assert.deepEqual(row.sources, []);
});

test("each row gets its own id", () => {
  const script = scriptWithClaim();
  const a = script.searchLogPayload(0, "web", { status: "done" });
  const b = script.searchLogPayload(0, "web", { status: "done" });
  assert.notEqual(a.search_id, b.search_id);
});

test("nothing is posted when logging is turned off, or there is no claim", async () => {
  const sent = stubFetch();
  scriptWithClaim({ cnfirmedLogResults: false }).logSearch(0, "wiki", { status: "done" });
  const noClaim = loadUserScript();
  noClaim.setClaimContexts([{ claim: "", context: "", section: null, links: [] }]);
  noClaim.logSearch(0, "wiki", { status: "error", error: "no claim" });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 0);
});

test("a failed post never throws", async () => {
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  const script = scriptWithClaim();
  assert.doesNotThrow(() => script.logSearch(0, "books", { status: "done" }));
  await new Promise((r) => setImmediate(r));
});

test("web sources keep their verdict, confidence and reliability, in the shared vocabulary", () => {
  const script = scriptWithClaim();
  const sources = script.webLogSources([
    {
      source: { url: "https://example.org/a", title: "A" },
      verdict: { verdict: "SUPPORTED", confidence: 90, comments: "First lit in 1873.", reliability: "high" },
    },
    {
      source: { url: "https://example.org/b", title: "B" },
      verdict: { verdict: "NOT SUPPORTED", confidence: 70, comments: "" },
    },
  ]);
  assert.deepEqual(sources, [
    {
      url: "https://example.org/a", title: "A", origin: "web", verdict: "supports",
      quote: "First lit in 1873.", confidence: 90, reliability: "high",
    },
    {
      url: "https://example.org/b", title: "B", origin: "web", verdict: "unsupported",
      quote: null, confidence: 70, reliability: null,
    },
  ]);
});

test("a book without a verdict is logged as unchecked, with its passage", () => {
  const script = scriptWithClaim();
  const sources = script.bookLogSources([
    { url: "https://archive.org/details/x", title: "X", snippet: "lit in 1873", check: { verdict: "partial", quote: "in 1873" } },
    { url: "https://archive.org/details/y", title: "Y", snippet: "a lighthouse" },
  ]);
  assert.deepEqual(sources.map((s: { verdict: string; quote: string }) => [s.verdict, s.quote]), [
    ["partial", "in 1873"],
    ["unchecked", "a lighthouse"],
  ]);
});

test("a Wikipedia citation is logged as a lead, with where it was cited", () => {
  const script = scriptWithClaim();
  const [source] = script.wikiLogSources([
    {
      url: "https://example.org/c", title: "C", snippet: "",
      evidence: { origin: "sister-wiki", lang: "de", sentence: "Der Leuchtturm wurde 1873 in Betrieb genommen." },
    },
  ]);
  assert.equal(source.origin, "sister-wiki");
  assert.equal(source.lang, "de");
  assert.equal(source.verdict, "lead");
  assert.equal(source.quote, "Der Leuchtturm wurde 1873 in Betrieb genommen.");
});

test("long quotes and long source lists are cut to what the Worker keeps", () => {
  const script = scriptWithClaim();
  const many = Array.from({ length: 40 }, (_, k) => ({
    url: `https://archive.org/details/b${k}`, title: `B${k}`, snippet: "x".repeat(5000),
  }));
  const row = script.searchLogPayload(0, "books", { status: "done", sources: script.bookLogSources(many) });
  assert.equal(row.sources.length, 25);
  assert.equal(row.sources[0].quote.length, 1000);
});

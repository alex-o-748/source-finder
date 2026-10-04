/**
 * The user script's free web search: one /v1/search call, then one
 * /v1/verify call per result until enough state the claim. No network:
 * `fetch` is stubbed, and what is tested is what the script sends and keeps.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const script = loadUserScript({ wgTitle: "KCC Malls", wgPageName: "KCC_Malls" });

const CLAIM = "KCC started in 1947 as a textile store in Koronadal.";
const CTX = { claim: CLAIM, context: CLAIM, section: null, links: [] };

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

type Reply = { status: number; body: unknown };

function stubFetch(replies: Reply[]): { url: string; body: Record<string, unknown> }[] {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return sent;
}

function result(url: string, text: string) {
  return { url, title: url.split("/")[2], score: 0.9, text };
}

function verdict(v: string, quote = "") {
  return { status: 200, body: { verdict: v, support_score: 90, comments: "why", verified_text: quote } };
}

test("the query is the article title and the claim, cut to the endpoint's limit", () => {
  assert.equal(script.freeSearchQuery(CTX), `KCC Malls: ${CLAIM}`);
  assert.equal(script.freeSearchQuery({ ...CTX, claim: "x".repeat(500) }).length, 400);
});

test("a page repeating eight of the claim's words in a row is taken for a copy", () => {
  assert.equal(script.looksCopied(CLAIM, `History. ${CLAIM} Today it has five malls.`), true);
  assert.equal(script.looksCopied(CLAIM, "The company began as a fabric shop in Koronadal in 1947."), false);
  assert.equal(script.looksCopied("Born in 1979.", "Born in 1979."), false);
});

test("searches once, then checks results in order and keeps only those that state the claim", async () => {
  const sent = stubFetch([
    {
      status: 200,
      body: {
        results: [
          result("https://blog.example/a", "unrelated"),
          result("https://news.example/b", "It began as a fabric shop in Koronadal in 1947."),
          result("https://mirror.example/c", `About. ${CLAIM}`),
          result("https://www.dailymail.co.uk/d", "blocked by the in-script WP:RSP list"),
          result("https://unavailable.example/e", "x"),
        ],
      },
    },
    verdict("NOT SUPPORTED"),
    verdict("SUPPORTED", "began as a fabric shop in Koronadal in 1947"),
    verdict("SUPPORTED", CLAIM),
    { status: 422, body: { error: "empty" } },
  ]);
  const out = await script.callFreeSearch(CTX);

  assert.equal(sent[0].url, "https://citation-verifier.toolforge.org/v1/search");
  assert.deepEqual(sent[0].body, { query: `KCC Malls: ${CLAIM}` });
  assert.deepEqual(
    sent.slice(1).map((r) => [r.url, r.body.claim, r.body.source_content]),
    [
      ["https://citation-verifier.toolforge.org/v1/verify", CLAIM, "unrelated"],
      ["https://citation-verifier.toolforge.org/v1/verify", CLAIM, "It began as a fabric shop in Koronadal in 1947."],
      ["https://citation-verifier.toolforge.org/v1/verify", CLAIM, `About. ${CLAIM}`],
      ["https://citation-verifier.toolforge.org/v1/verify", CLAIM, "x"],
    ],
  );
  assert.deepEqual(out.map((s: { source: { url: string } }) => s.source.url), [
    "https://news.example/b",
    "https://mirror.example/c",
  ]);
  assert.equal(out[0].verdict.verdict, "SUPPORTED");
  assert.equal(out[0].verdict.reliability, "n/a");
  assert.match(out[0].verdict.comments, /^“began as a fabric shop/);
  assert.match(out[0].citation.ref, /^<ref>\{\{cite/);
  assert.equal(out[1].verdict.reliability, "low");
});

test("stops checking once three results that are not copies state the claim", async () => {
  const results = Array.from({ length: 6 }, (_, k) => result(`https://s${k}.example/`, `text ${k}`));
  const sent = stubFetch([
    { status: 200, body: { results } },
    verdict("SUPPORTED"),
    verdict("PARTIALLY SUPPORTED"),
    verdict("SUPPORTED"),
    verdict("SUPPORTED"),
  ]);
  const out = await script.callFreeSearch(CTX);
  assert.equal(sent.length, 5);
  assert.equal(out.length, 4);
});

test("a failed search is an error the panel can show", async () => {
  stubFetch([{ status: 429, body: { error: "Daily search budget exhausted; try again tomorrow" } }]);
  await assert.rejects(script.callFreeSearch(CTX), /Search 429: Daily search budget exhausted/);
});

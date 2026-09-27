import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySource, verifyBaseUrl } from "../src/core/verifySource.js";

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = responses.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const OK = {
  verdict: "SUPPORTED",
  support_score: 92,
  comments: "States the completion year.",
  reason_type: null,
  source_quote: "completed in March 1889.",
  quote_status: "normalized",
  verified_text: "completed in March 1889",
};

test("posts the claim and source_url to /v1/verify and maps the result", async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: OK }]);
  const v = await verifySource("Completed in 1889.", "https://example.org/a", {
    baseUrl: "https://verify.example/",
    fetch: fn,
  });
  assert.equal(calls[0].url, "https://verify.example/v1/verify");
  assert.deepEqual(calls[0].body, { claim: "Completed in 1889.", source_url: "https://example.org/a" });
  assert.deepEqual(v, {
    verdict: "SUPPORTED",
    confidence: 92,
    comments: "States the completion year.",
    reliability: "n/a",
    reliabilityReason: "not assessed by the Verify API",
    quote: "completed in March 1889",
  });
});

test("sends pre-fetched text as source_content instead of the URL", async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: { ...OK, verified_text: null } }]);
  const v = await verifySource("c", "https://example.org/a", {
    sourceText: "x".repeat(60_000),
    baseUrl: "https://verify.example",
    fetch: fn,
  });
  assert.equal(calls[0].body.source_url, undefined);
  assert.equal((calls[0].body.source_content as string).length, 50_000);
  assert.equal(v.quote, undefined);
});

test("an unfetchable source (422) is a SOURCE UNAVAILABLE verdict", async () => {
  const { fn } = fakeFetch([{ status: 422, body: { error: "Source returned 404", stage: "source" } }]);
  const v = await verifySource("c", "https://example.org/dead", { baseUrl: "https://v", fetch: fn });
  assert.equal(v.verdict, "SOURCE UNAVAILABLE");
  assert.equal(v.confidence, 0);
  assert.equal(v.comments, "Source returned 404");
});

test("waits out a 429 using Retry-After, then succeeds", async () => {
  const waits: number[] = [];
  const { fn, calls } = fakeFetch([
    { status: 429, body: { error: "Rate limit exceeded" }, headers: { "retry-after": "7" } },
    { status: 200, body: OK },
  ]);
  const v = await verifySource("c", "https://example.org/a", {
    baseUrl: "https://v",
    fetch: fn,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [7000]);
  assert.equal(v.verdict, "SUPPORTED");
});

test("gives up after repeated 429s, and throws on provider failures", async () => {
  const limited = Array.from({ length: 4 }, () => ({ status: 429, body: { error: "Rate limit exceeded" } }));
  await assert.rejects(
    verifySource("c", "u", { baseUrl: "https://v", fetch: fakeFetch(limited).fn, sleep: async () => {} }),
    /Verify API 429: Rate limit exceeded/,
  );
  const provider = fakeFetch([{ status: 502, body: { error: "upstream down", stage: "provider" } }]);
  await assert.rejects(
    verifySource("c", "u", { baseUrl: "https://v", fetch: provider.fn }),
    /Verify API 502: upstream down/,
  );
});

test("base URL: explicit, then CNFIRMED_VERIFY_URL, then the public host", () => {
  const saved = process.env.CNFIRMED_VERIFY_URL;
  try {
    delete process.env.CNFIRMED_VERIFY_URL;
    assert.equal(verifyBaseUrl(), "https://citation-verifier.toolforge.org");
    process.env.CNFIRMED_VERIFY_URL = "http://localhost:8080/";
    assert.equal(verifyBaseUrl(), "http://localhost:8080");
    assert.equal(verifyBaseUrl("https://x"), "https://x");
  } finally {
    if (saved === undefined) delete process.env.CNFIRMED_VERIFY_URL;
    else process.env.CNFIRMED_VERIFY_URL = saved;
  }
});

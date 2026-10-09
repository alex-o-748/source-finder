/**
 * The user script's Tavily + GPT-OSS provider: Tavily searches, a model on the
 * Hugging Face router judges what came back. No network: `fetch` is stubbed,
 * and what is tested is the requests the script sends and how it reads the
 * replies.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const script = loadUserScript({ wgPageName: "Elizabeth_Báthory" });

const CTX = {
  claim: "In 1578, three years into their marriage, Nádasdy became the chief commander of Hungarian troops.",
  context: "Nádasdy fought the Ottomans.",
  section: "Marriage",
  links: [],
};
const KEYS = { tavily: "tvly-test", hf: "hf_test" };

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

type Sent = { url: string; auth: string | null; body: Record<string, unknown> };

function stubFetch(replies: { status: number; body: unknown }[]): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sent.push({ url, auth: headers.get("authorization"), body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return sent;
}

const TAVILY_OK = {
  status: 200,
  body: {
    results: [
      {
        url: "https://www.britannica.com/biography/Elizabeth-Bathory",
        title: "Elizabeth Báthory | Britannica",
        content: "In 1578 Nádasdy became chief commander of Hungarian troops.",
        raw_content: "Full page text.",
      },
      { url: "https://en.wikipedia.org/wiki/Ferenc_N%C3%A1dasdy", title: "Wikipedia", content: "Circular." },
    ],
  },
};

function hfReply(suggestions: unknown[]) {
  return {
    status: 200,
    body: { choices: [{ message: { role: "assistant", content: JSON.stringify({ suggestions }) } }] },
  };
}

test("searches Tavily, then asks the Hugging Face model about only what was found", async () => {
  const sent = stubFetch([
    TAVILY_OK,
    hfReply([
      {
        url: "https://www.britannica.com/biography/Elizabeth-Bathory/",
        title: "Britannica",
        verdict: "SUPPORTED",
        confidence: 90,
        comments: "States it.",
        reliability: "high",
        reliability_reason: "Tertiary encyclopedia.",
      },
      { url: "https://made-up.example/page", verdict: "SUPPORTED", confidence: 95 },
    ]),
  ]);

  const out = await script.callTavilyGptOss(CTX, KEYS);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, "https://api.tavily.com/search");
  assert.equal(sent[0].auth, "Bearer tvly-test");
  assert.match(String(sent[0].body.query), /^Elizabeth Báthory: In 1578/);
  assert.ok(String(sent[0].body.query).length <= 400);

  assert.equal(sent[1].url, "https://router.huggingface.co/v1/chat/completions");
  assert.equal(sent[1].auth, "Bearer hf_test");
  assert.equal(sent[1].body.model, "openai/gpt-oss-120b");
  const user = String((sent[1].body.messages as { content: string }[])[1].content);
  assert.match(user, /britannica\.com/);
  assert.match(user, /chief commander/);
  // Wikipedia is filtered out before the model sees it.
  assert.doesNotMatch(user, /wikipedia\.org/);

  // The invented URL is dropped; the trailing-slash copy of a real one is kept.
  assert.equal(out.length, 1);
  assert.equal(out[0].verdict.verdict, "SUPPORTED");
  assert.match(out[0].source.url, /britannica\.com/);
});

test("no search results means no model call", async () => {
  const sent = stubFetch([{ status: 200, body: { results: [] } }]);
  const out = await script.callTavilyGptOss(CTX, KEYS);
  assert.deepEqual(out, []);
  assert.equal(sent.length, 1);
});

test("errors name the service that failed", async () => {
  stubFetch([{ status: 401, body: { detail: { error: "Unauthorized: missing or invalid API key." } } }]);
  await assert.rejects(script.callTavilyGptOss(CTX, KEYS), /^Error: Tavily API 401/);

  stubFetch([TAVILY_OK, { status: 402, body: { error: "You have exceeded your monthly included credits." } }]);
  await assert.rejects(
    script.callTavilyGptOss(CTX, KEYS),
    /Hugging Face API 402: You have exceeded your monthly included credits/,
  );
});

/**
 * The user script's Tavily + open-weight model provider: Tavily searches
 * through the proxy Worker (Wikipedia's CSP blocks Tavily itself), and the
 * model chosen in Settings judges what came back: GPT-OSS on Hugging Face,
 * through the Worker, or Qwen 3.8 on Lift Wing, through llm-router. No network: `fetch` is stubbed,
 * and what is tested is the requests the script sends and how it reads the
 * replies.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const script = loadUserScript({ wgPageName: "Elizabeth_Báthory" }, { storage: { "cnfirmed-open-model": "hf" } });

const CTX = {
  claim: "In 1578, three years into their marriage, Nádasdy became the chief commander of Hungarian troops.",
  context: "Nádasdy fought the Ottomans.",
  section: "Marriage",
  links: [],
};
const KEY = "tvly-test";
const PROXY = "https://publicai-proxy.alaexis.workers.dev";

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

test("searches Tavily, then asks the model about only what was found, both via the proxy", async () => {
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

  const out = await script.callTavilyGptOss(CTX, KEY);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, `${PROXY}/tavily`);
  assert.equal(sent[0].auth, "Bearer tvly-test");
  assert.match(String(sent[0].body.query), /^Elizabeth Báthory: In 1578/);
  assert.ok(String(sent[0].body.query).length <= 400);

  assert.equal(sent[1].url, `${PROXY}/hf`);
  // The proxy pays for the model; the Tavily key never goes there.
  assert.equal(sent[1].auth, null);
  assert.equal(sent[1].body.model, "openai/gpt-oss-20b");
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

test("by default the reader is GPT-OSS on Hugging Face, through the Worker", async () => {
  const def = loadUserScript({ wgPageName: "Elizabeth_Báthory" });
  const sentDef = stubFetch([TAVILY_OK, hfReply([{ url: "https://www.britannica.com/biography/Elizabeth-Bathory", verdict: "SUPPORTED" }])]);
  await def.callTavilyGptOss(CTX, KEY);
  assert.equal(sentDef[1].url, `${PROXY}/hf`);
  assert.equal(sentDef[1].body.model, "openai/gpt-oss-20b");
});

test("with Lift Wing chosen, the model is Qwen 3.8, through llm-router", async () => {
  const lw = loadUserScript({ wgPageName: "Elizabeth_Báthory" }, { storage: { "cnfirmed-open-model": "liftwing" } });
  const sent = stubFetch([TAVILY_OK, hfReply([{ url: "https://www.britannica.com/biography/Elizabeth-Bathory", verdict: "SUPPORTED" }])]);
  const out = await lw.callTavilyGptOss(CTX, KEY);
  assert.equal(sent[0].url, `${PROXY}/tavily`);
  assert.equal(sent[1].url, "https://llm-router.toolforge.org/liftwing");
  assert.equal(sent[1].auth, null);
  assert.equal(sent[1].body.model, "llm-qwen38-27b");
  assert.equal(out.length, 1);

  stubFetch([TAVILY_OK, { status: 503, body: { error: { message: "busy" } } }]);
  await assert.rejects(lw.callTavilyGptOss(CTX, KEY), /Lift Wing \(via proxy\) 503: busy/);
});

test("no search results means no model call", async () => {
  const sent = stubFetch([{ status: 200, body: { results: [] } }]);
  const out = await script.callTavilyGptOss(CTX, KEY);
  assert.deepEqual(out, []);
  assert.equal(sent.length, 1);
});

test("errors name the service that failed", async () => {
  stubFetch([{ status: 401, body: { detail: { error: "Unauthorized: missing or invalid API key." } } }]);
  await assert.rejects(script.callTavilyGptOss(CTX, KEY), /^Error: Tavily API 401/);

  stubFetch([TAVILY_OK, { status: 402, body: { error: "You have exceeded your monthly included credits." } }]);
  await assert.rejects(
    script.callTavilyGptOss(CTX, KEY),
    /Hugging Face \(via proxy\) 402: You have exceeded your monthly included credits/,
  );
});

test("without a key of the user's own, the search goes to the Worker's free credits", async () => {
  script.storage.setItem("cnfirmed-free-searches-spent", "1"); // long ago: stale
  const sent = stubFetch([{ status: 200, body: { results: [] } }]);
  await script.callTavilyGptOss(CTX, "");
  assert.equal(sent[0].url, `${PROXY}/tavily`);
  assert.equal(sent[0].auth, null);
  // A search that went through clears what was remembered.
  assert.equal(script.storage.getItem("cnfirmed-free-searches-spent"), null);
});

test("free credits running out is told apart, and remembered", async () => {
  stubFetch([
    { status: 402, body: { error: { code: "free_credits_exhausted", message: "No free web searches left" } } },
  ]);
  await assert.rejects(script.callTavilyGptOss(CTX, ""), (err: Error & { noFreeSearches?: boolean }) => {
    assert.equal(err.noFreeSearches, true);
    assert.match(err.message, /^No free web searches left\. Add your own Tavily key/);
    assert.match(err.message, /Claude, Gemini or OpenAI/);
    return true;
  });
  assert.equal(script.canSearchWeb("tavilyhf"), false);

  // The user's own key still searches, and its errors are Tavily's own.
  script.storage.setItem("cnfirmed-key-tavily", KEY);
  assert.equal(script.canSearchWeb("tavilyhf"), true);
  stubFetch([{ status: 432, body: { detail: { error: "This request exceeds your plan's set usage limit." } } }]);
  await assert.rejects(script.callTavilyGptOss(CTX, KEY), /^Error: Tavily API 432/);
  script.storage.removeItem("cnfirmed-key-tavily");
  script.storage.removeItem("cnfirmed-free-searches-spent");
});

test("the default provider is the free one, unless a Claude key was saved", () => {
  const fresh = loadUserScript({ wgPageName: "Elizabeth_Báthory" });
  assert.equal(fresh.getProvider(), "tavilyhf");
  assert.equal(fresh.canSearchWeb("tavilyhf"), true);
  assert.equal(fresh.canSearchWeb("claude"), false);
  fresh.storage.setItem("cnfirmed-key-claude", "sk-ant-test");
  assert.equal(fresh.getProvider(), "claude");
  fresh.storage.setItem("cnfirmed-provider", "gemini");
  assert.equal(fresh.getProvider(), "gemini");
});

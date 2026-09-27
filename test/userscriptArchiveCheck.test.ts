/**
 * The user script's check of Internet Archive leads: one Verify API call per
 * book, sending its passages as the source. No network: `fetch` is stubbed,
 * and what is tested is the requests the script sends and how it reads the
 * replies.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const script = loadUserScript({ wgTitle: "Gothic Revival architecture", wgPageName: "Gothic_Revival_architecture" });

const CLAIM =
  "Gothic details even began to appear in working-class housing schemes subsidised by philanthropy, " +
  "though given the expense, less frequently than in the design of upper and middle-class housing.";
const CTX = { claim: CLAIM, context: `The style spread widely. ${CLAIM}`, section: null, links: [] };

function lead(title: string, year: number | null, passages: string[]) {
  return { title, evidence: { year, passages } };
}

const LEADS = [
  lead("The history of working-class housing", null, [
    "phenomenal price in 144 Working-class Housing in Nottingham those days. Middle-class housing also began to be",
  ]),
  lead("The movement for housing reform in Germany and France, 1840-1914", 1985, [
    "design of working-class housing The early development of the design",
    "of working-class housing in England",
  ]),
  lead("The Gothic revival", 1928, ["Gothic details appeared even in working-class housing paid for by philanthropists"]),
];

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** Replaces `fetch` with one that answers from `replies` in order, and records what was sent. */
function stubFetch(replies: Reply[]): { url: string; body: Record<string, unknown> }[] {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return sent;
}

function api(verdict: string, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      verdict,
      support_score: 50,
      comments: `${verdict} because.`,
      reason_type: null,
      source_quote: null,
      quote_status: "empty",
      verified_text: null,
      ...extra,
    },
  };
}

test("a book's passages, one per line, are the source; the title and year are not", () => {
  assert.equal(
    script.archiveSourceContent(LEADS[1]),
    "design of working-class housing The early development of the design\nof working-class housing in England",
  );
});

test("one Verify API call per book, with the claim and passages, and verdicts that line up", async () => {
  const sent = stubFetch([
    api("NOT SUPPORTED"),
    api("PARTIALLY SUPPORTED"),
    api("SUPPORTED", {
      source_quote: "Gothic details appeared even in working-class housing!",
      verified_text: "Gothic details appeared even in working-class housing",
    }),
  ]);
  const verdicts = await script.checkArchiveCandidates(CTX, LEADS);
  assert.equal(sent.length, 3);
  for (const [k, s] of sent.entries()) {
    assert.equal(s.url, "https://citation-verifier.toolforge.org/v1/verify");
    assert.deepEqual(s.body, { claim: CLAIM, source_content: script.archiveSourceContent(LEADS[k]) });
  }
  assert.deepEqual(
    verdicts.map((v: { verdict: string } | null) => v && v.verdict),
    ["unsupported", "partial", "supports"],
  );
  assert.equal(verdicts[2].quote, "Gothic details appeared even in working-class housing", "verified_text, not source_quote");
  assert.equal(verdicts[2].reason, "SUPPORTED because.");
});

test("an unusable source (422) or an unknown verdict leaves that book unchecked", async () => {
  stubFetch([
    { status: 422, body: { error: "Source content is empty", stage: "source" } },
    api("SOURCE UNAVAILABLE"),
    api("MAYBE"),
  ]);
  assert.deepEqual(await script.checkArchiveCandidates(CTX, LEADS), [null, null, null]);
});

test("a provider failure fails the check, rather than a silent 'none state it'", async () => {
  stubFetch([api("SUPPORTED"), { status: 502, body: { error: "upstream down", stage: "provider" } }]);
  await assert.rejects(script.checkArchiveCandidates(CTX, LEADS), /Verify API 502: upstream down/);
});

test("a 429 is waited out for Retry-After, then retried", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const waits: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    waits.push(ms);
    return realSetTimeout(fn, 0);
  }) as typeof setTimeout;
  try {
    const sent = stubFetch([
      { status: 429, body: { error: "Rate limit exceeded" }, headers: { "Retry-After": "4" } },
      api("SUPPORTED"),
    ]);
    const verdicts = await script.checkArchiveCandidates(CTX, LEADS.slice(0, 1));
    assert.equal(sent.length, 2);
    assert.deepEqual(waits, [4000]);
    assert.equal(verdicts[0].verdict, "supports");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("window.cnfirmedVerifyUrl points the check at another host", async () => {
  const local = loadUserScript(
    { wgTitle: "X", wgPageName: "X" },
    { window: { cnfirmedVerifyUrl: "http://localhost:8080/" } },
  );
  const sent = stubFetch([api("SUPPORTED")]);
  await local.checkArchiveCandidates(CTX, LEADS.slice(0, 1));
  assert.equal(sent[0].url, "http://localhost:8080/v1/verify");
});

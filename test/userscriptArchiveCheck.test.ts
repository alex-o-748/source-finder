/**
 * The user script's check of Internet Archive leads: one short model call that
 * reads each book's passages and says whether they state the claim. No network:
 * `fetch` is stubbed, and what is tested is the request the script sends and how
 * it reads the reply.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const script = loadUserScript({ wgTitle: "Gothic Revival architecture", wgPageName: "Gothic_Revival_architecture" });

const CLAIM =
  "Gothic details even began to appear in working-class housing schemes subsidised by philanthropy, " +
  "though given the expense, less frequently than in the design of upper and middle-class housing.";
const CTX = { claim: CLAIM, context: `The style spread widely. ${CLAIM} ${"More text. ".repeat(100)}`, section: null, links: [] };

function lead(title: string, year: number | null, passages: string[]) {
  return { title, evidence: { year, passages } };
}

const LEADS = [
  lead("The history of working-class housing", null, [
    "phenomenal price in 144 Working-class Housing in Nottingham those days. Middle-class housing also began to be",
  ]),
  lead("The movement for housing reform in Germany and France, 1840-1914", 1985, [
    "design of working-class housing The early development of the design of working-class housing in England",
  ]),
  lead("The Gothic revival", 1928, ["Gothic details appeared even in working-class housing paid for by philanthropists"]),
];

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Replaces `fetch` for one call, and hands back what was sent. */
function stubFetch(reply: string, status = 200): { body: () => Record<string, unknown>; url: () => string } {
  let sent: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(reply, { status });
  }) as typeof fetch;
  return {
    body: () => JSON.parse(String(sent!.init.body)),
    url: () => sent!.url,
  };
}

function claudeReply(text: string): string {
  return JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" });
}

test("the check message names the article, the claim, a bounded context, and every book's passages", () => {
  const message: string = script.archiveCheckMessage(CTX, LEADS);
  assert.ok(message.startsWith(`Article: Gothic Revival architecture\nClaim: ${CLAIM}\nContext: `));
  const context = message.split("\n").find((l: string) => l.startsWith("Context: "))!;
  assert.equal(context.length, "Context: ".length + 800, "the paragraph is cut to 800 characters");
  assert.ok(message.includes("\n\nBook 1: The history of working-class housing\n- phenomenal price"));
  assert.ok(message.includes("\n\nBook 2: The movement for housing reform in Germany and France, 1840-1914 (1985)\n"));
  assert.ok(message.includes("\n\nBook 3: The Gothic revival (1928)\n- Gothic details appeared"));
});

test("the check is one plain Claude call with the user's model, and its verdicts line up with the books", async () => {
  const sent = stubFetch(
    claudeReply(
      "```json\n" +
        JSON.stringify({
          books: [
            { n: 1, verdict: "unrelated", quote: "", reason: "Nottingham housing prices; nothing on Gothic details." },
            { n: 2, verdict: "Topic", quote: "", reason: "Working-class housing design; no Gothic." },
            { n: 3, verdict: "supports", quote: "Gothic details appeared even in working-class housing", reason: "States it." },
          ],
        }) +
        "\n```",
    ),
  );
  const verdicts = await script.checkArchiveCandidates(CTX, LEADS, "claude", "sk-test");
  assert.equal(sent.url(), "https://api.anthropic.com/v1/messages");
  const body = sent.body();
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.tools, undefined, "no web search: the passages are all it reads");
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.match(String(body.system), /Judge only what the passages say/);
  assert.deepEqual(
    verdicts.map((v: { verdict: string } | null) => v && v.verdict),
    ["unrelated", "topic", "supports"],
  );
  assert.equal(verdicts[2].quote, "Gothic details appeared even in working-class housing");
});

test("a book the model skipped, numbered wrongly or gave an unknown verdict stays unchecked", () => {
  const verdicts = script.parseArchiveVerdicts(
    JSON.stringify({
      books: [
        { n: 1, verdict: "partial", quote: "x", reason: "y" },
        { n: 1, verdict: "unrelated", quote: "", reason: "a second answer for book 1 is ignored" },
        { n: 7, verdict: "supports", quote: "", reason: "no book 7" },
        { n: 3, verdict: "maybe", quote: "", reason: "not a verdict" },
      ],
    }),
    3,
  );
  assert.deepEqual(verdicts, [{ verdict: "partial", quote: "x", reason: "y" }, null, null]);
});

test("a reply that is not the JSON asked for is an error, not a silent 'all unrelated'", async () => {
  assert.throws(() => script.parseArchiveVerdicts("I could not read these passages.", 2), /not the JSON asked for/);
  stubFetch(JSON.stringify({ type: "error", error: { message: "credit balance is too low" } }), 400);
  await assert.rejects(script.checkArchiveCandidates(CTX, LEADS, "claude", "sk-test"), /Claude API 400/);
});

test("Gemini and OpenAI get the same prompt, without tools", async () => {
  const reply = JSON.stringify({ books: [{ n: 1, verdict: "unrelated", quote: "", reason: "r" }] });
  let sent = stubFetch(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] }));
  let verdicts = await script.checkArchiveCandidates(CTX, LEADS.slice(0, 1), "gemini", "g-key");
  assert.match(sent.url(), /models\/gemini-flash-latest:generateContent\?key=g-key$/);
  assert.equal(sent.body().tools, undefined);
  assert.equal(verdicts[0].verdict, "unrelated");

  sent = stubFetch(JSON.stringify({ output_text: reply }));
  verdicts = await script.checkArchiveCandidates(CTX, LEADS.slice(0, 1), "openai", "o-key");
  assert.equal(sent.url(), "https://api.openai.com/v1/responses");
  assert.equal(sent.body().tools, undefined);
  assert.equal(verdicts[0].verdict, "unrelated");
});

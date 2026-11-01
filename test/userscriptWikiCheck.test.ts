/**
 * The user script's check of other-language leads: does the sentence another
 * wiki cited a source for state the same fact as the claim? One judge-model
 * call per claim, or the Verify API with each sentence as the source. No
 * network: `fetch` is stubbed.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const CLAIM =
  "The electron capture reactions lead to the formation of element 22 (titanium) isotopes, " +
  "while beta decay leads to element 24 (chromium) isotopes.";
const CTX = { claim: CLAIM, context: `Electron capture is the main decay mode. ${CLAIM}`, section: "Isotopes", links: [] };

function sisterLead(url: string, sentence: string) {
  return {
    url,
    title: url,
    ref: `<ref>{{cite web |url=${url} |title=x}}</ref>`,
    evidence: { origin: "sister-wiki", lang: "de", article: "Vanadium", section: "Gewinnung", sentence, score: 1 },
  };
}

// The first is what de:Vanadium really offered (October 2026); the second is synthetic.
const LEADS = [
  sisterLead(
    "https://pubs.usgs.gov/periodicals/mcs2022/mcs2022-vanadium.pdf",
    "Bei bekannten Reserven von insgesamt 24 Millionen Tonnen (Stand 2022) ist ein Lieferengpass bei Vanadium auf absehbare Zeit nicht zu erwarten.",
  ),
  sisterLead(
    "https://example.org/nubase",
    "Beim Elektroneneinfang entstehen Isotope des Titans (22), beim Betazerfall Isotope des Chroms (24).",
  ),
];

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

function model(content: unknown): Reply {
  return { status: 200, body: { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] } };
}

function verify(verdict: string): Reply {
  return { status: 200, body: { verdict, comments: `${verdict} because.`, verified_text: null } };
}

test("the prompt gives the claim and each lead's cited sentence, numbered", () => {
  const script = loadUserScript({ wgTitle: "Vanadium" });
  const prompt = script.wikiSamePrompt({ articleTitle: "Vanadium", paragraph: CTX.context, claim: CLAIM }, LEADS);
  assert.match(prompt, /^Article: Vanadium\nClaim: The electron capture/);
  assert.match(prompt, /S1\. de\.wikipedia, Vanadium, section "Gewinnung":\nBei bekannten Reserven/);
  assert.match(prompt, /S2\. de\.wikipedia.*\nBeim Elektroneneinfang/);
  assert.match(script.prompts.wikiSame, /shared numbers and names are not the same fact/i);
});

test("one judge call for all of a claim's leads, and verdicts that line up", async () => {
  const script = loadUserScript({ wgTitle: "Vanadium" });
  const sent = stubFetch([
    model({ sentences: [
      { id: "S1", verdict: "no", why: "Reserves, not decay products." },
      { id: "S2", verdict: "same", why: "States both decay products." },
    ] }),
  ]);
  const r = await script.checkSisterLeads(CTX, LEADS);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/hf$/);
  assert.equal(sent[0].body.model, script.models.judge);
  assert.equal(r.by, script.models.judge);
  assert.deepEqual(r.verdicts, [
    { verdict: "no", reason: "Reserves, not decay products." },
    { verdict: "same", reason: "States both decay products." },
  ]);
});

test("a reply missing a lead, or with an unknown verdict, leaves that lead unchecked", () => {
  const script = loadUserScript();
  const text = 'Thinking done. {"sentences": [{"id": "S2", "verdict": "maybe"}]}';
  assert.deepEqual(script.wikiParseSame(text, LEADS), [null, null]);
  assert.throws(() => script.wikiParseSame("no json here", LEADS), /no verdicts/);
});

test("with no judge model, each sentence goes to the Verify API as the source", async () => {
  const script = loadUserScript({ wgTitle: "Vanadium" }, { window: { cnfirmedArchiveJudgeModel: false } });
  const sent = stubFetch([verify("NOT SUPPORTED"), verify("PARTIALLY SUPPORTED")]);
  const r = await script.checkSisterLeads(CTX, LEADS);
  assert.equal(r.by, "verify-api");
  assert.deepEqual(sent.map((s) => s.url), [
    "https://citation-verifier.toolforge.org/v1/verify",
    "https://citation-verifier.toolforge.org/v1/verify",
  ]);
  assert.deepEqual(sent[0].body, { claim: CLAIM, source_content: LEADS[0].evidence.sentence });
  assert.deepEqual(r.verdicts.map((v: { verdict: string } | null) => v && v.verdict), ["no", "partial"]);
});

test("when the judge model fails, the Verify API checks instead", async () => {
  const script = loadUserScript({ wgTitle: "Vanadium" });
  const sent = stubFetch([
    { status: 400, body: { error: "bad request" } },
    verify("NOT SUPPORTED"),
    verify("SUPPORTED"),
  ]);
  const r = await script.checkSisterLeads(CTX, LEADS);
  assert.equal(sent.length, 3);
  assert.equal(r.by, "verify-api");
  assert.deepEqual(r.verdicts.map((v: { verdict: string } | null) => v && v.verdict), ["no", "same"]);
});

test("a lead's label says what was checked: the other wiki's sentence, not the source", () => {
  const script = loadUserScript();
  const lead = { ...LEADS[1], check: { verdict: "same", reason: "States both decay products." } };
  const same = script.wikiItem(lead, "wiki0", "same", true);
  assert.equal(same.tier, "lead");
  assert.equal(same.verdictText, "Cited for this fact on de.wikipedia, source not checked");
  assert.equal(same.note, "States both decay products.");
  assert.equal(script.wikiItem(lead, "wiki0", "partial", true).verdictText,
    "Cited for part of this fact on de.wikipedia, source not checked");
  assert.equal(script.wikiItem(LEADS[0], "wiki0", null, true).verdictText, "Lead, the check gave no verdict");
  assert.equal(script.wikiItem(LEADS[0], "wiki0", null, false).verdictText, "Lead, not checked");
});

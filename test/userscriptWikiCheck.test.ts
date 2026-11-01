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
    sent.push({ url, body: init && init.body ? JSON.parse(String(init.body)) : {} });
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

const PAGE = "Vanadium. Isotopes. Electron capture is the main decay mode below 51V; it leads to titanium (element 22) isotopes. " +
  "Beta decay, the main mode above it, leads to chromium (element 24) isotopes. ".repeat(3);

test("a lead's label says what was checked", () => {
  const script = loadUserScript();
  const same = { ...LEADS[1], check: { verdict: "same", reason: "States both decay products." } };
  assert.equal(script.wikiItem(same, "wiki0", true, CLAIM).verdictText,
    "Cited for this fact on de.wikipedia, source not checked");
  assert.equal(script.wikiItem(same, "wiki0", true, CLAIM).note, "States both decay products.");
  assert.equal(script.wikiItem({ ...same, check: { verdict: "partial", reason: "" } }, "wiki0", true, CLAIM).verdictText,
    "Cited for part of this fact on de.wikipedia, source not checked");
  assert.equal(script.wikiItem({ ...LEADS[0], check: null }, "wiki0", true, CLAIM).verdictText, "Lead, the check gave no verdict");
  assert.equal(script.wikiItem(LEADS[0], "wiki0", false, CLAIM).verdictText, "Lead, not checked");

  const read = { ...same, source: { from: "page", truncated: false, by: "m", verdict: { verdict: "supports", quote: "leads to chromium (element 24) isotopes", reason: "States it." } } };
  const item = script.wikiItem(read, "wiki0", true, CLAIM);
  assert.equal(item.tier, "supports");
  assert.equal(item.verdictText, "Supports the claim");
  assert.equal(item.quoteLabel, "From the source:");
  assert.equal(item.quote, "leads to chromium (element 24) isotopes");

  const unread = { ...same, source: { unavailable: "Source returned 403" } };
  assert.equal(script.wikiItem(unread, "wiki0", true, CLAIM).tier, "lead");
  assert.match(script.wikiItem(unread, "wiki0", true, CLAIM).note, /Could not read the source: Source returned 403\./);

  const copied = { ...read, source: { ...read.source, verdict: { verdict: "supports", quote: CLAIM, reason: "" } } };
  assert.equal(script.wikiItem(copied, "wiki0", true, CLAIM).tier, "flag");
});

test("a source read in full that does not state the claim is hidden; one cut short is not", () => {
  const script = loadUserScript();
  const same = { ...LEADS[1], check: { verdict: "same", reason: "" } };
  const no = { verdict: "unsupported", quote: "", reason: "" };
  assert.equal(script.sisterOutcome({ ...same, source: { from: "page", truncated: false, verdict: no } }, true), "unsupported");
  assert.equal(script.sisterOutcome({ ...same, source: { from: "page", truncated: true, verdict: no } }, true), "same");
  assert.equal(script.sisterOutcome({ ...same, source: { from: "quote", truncated: true, verdict: no } }, true), "same");
  assert.equal(script.sisterOutcome({ ...LEADS[0], check: { verdict: "no", reason: "" } }, true), "other");
  assert.equal(script.sisterOutcome(same, false), "unchecked");
});

test("a source's text comes from the Worker's fetch route, and a quote= stands in when the page cannot be read", async () => {
  const script = loadUserScript();
  const sent = stubFetch([
    { status: 200, body: { content: PAGE } },
    { status: 200, body: { error: "Source returned 403" } },
    { status: 200, body: { error: "Source returned 403" } },
  ]);
  const page = await script.wikiSourceText(LEADS[1]);
  assert.equal(sent[0].url, "https://publicai-proxy.alaexis.workers.dev/?fetch=" + encodeURIComponent(LEADS[1].url));
  assert.deepEqual(page, { text: PAGE.trim(), from: "page", truncated: false });

  const quoted = { ...LEADS[1], evidence: { ...LEADS[1].evidence, quote: "Beim Betazerfall entstehen Isotope des Chroms." } };
  assert.deepEqual(await script.wikiSourceText(quoted), { text: "Beim Betazerfall entstehen Isotope des Chroms.", from: "quote", truncated: true });
  assert.deepEqual(await script.wikiSourceText(LEADS[1]), { error: "Source returned 403" });
});

test("a long page is cut at 50,000 characters and marked as cut", async () => {
  const script = loadUserScript();
  stubFetch([{ status: 200, body: { content: "x ".repeat(40000) } }]);
  const r = await script.wikiSourceText(LEADS[1]);
  assert.equal(r.text.length, 50000);
  assert.equal(r.truncated, true);
});

test("the judge's verdict on a source counts only when its quote is in the text", () => {
  const script = loadUserScript();
  const source = { text: PAGE, from: "page", truncated: false };
  assert.deepEqual(
    script.wikiParseSource('{"verdict": "supports", "quote": "leads to chromium (element 24) isotopes", "why": "ok"}', source),
    { verdict: "supports", quote: "leads to chromium (element 24) isotopes", reason: "ok" },
  );
  assert.equal(script.wikiParseSource('{"verdict": "supports", "quote": "produces vanadium carbide", "why": ""}', source).verdict, "unsupported");
  assert.equal(script.wikiParseSource('{"verdict": "maybe"}', source), null);
});

test("one judge call per source, with the whole page; the Verify API reads the same text when the judge fails", async () => {
  const script = loadUserScript({ wgTitle: "Vanadium" });
  const sent = stubFetch([
    { status: 200, body: { content: PAGE } },
    model({ verdict: "supports", quote: "leads to chromium (element 24) isotopes", why: "States it." }),
  ]);
  const r = await script.checkSisterSource(CTX, LEADS[1]);
  assert.equal(sent.length, 2);
  assert.match(String((sent[1].body.messages as { content: string }[])[1].content), /Text:\nVanadium\. Isotopes\./);
  assert.deepEqual(r, { from: "page", truncated: false, by: script.models.judge,
    verdict: { verdict: "supports", quote: "leads to chromium (element 24) isotopes", reason: "States it." } });

  const sent2 = stubFetch([
    { status: 200, body: { content: PAGE } },
    { status: 400, body: { error: "bad request" } },
    verify("PARTIALLY SUPPORTED"),
  ]);
  const r2 = await script.checkSisterSource(CTX, LEADS[1]);
  assert.deepEqual(sent2[2].body, { claim: CLAIM, source_content: PAGE.trim() });
  assert.equal(r2.by, "verify-api");
  assert.equal(r2.verdict.verdict, "partial");
});

test("only the leads that state the same fact have their sources read", async () => {
  const script = loadUserScript({ wgTitle: "Vanadium" });
  const leads = [
    { ...LEADS[0], check: { verdict: "no", reason: "" } },
    { ...LEADS[1], check: { verdict: "same", reason: "" } },
  ];
  const sent = stubFetch([
    { status: 200, body: { error: "Source returned 404" } },
  ]);
  await script.checkSisterSources(CTX, leads);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /example\.org%2Fnubase/);
  assert.equal("source" in leads[0], false);
  assert.deepEqual(leads[1].source, { unavailable: "Source returned 404" });
});

/**
 * Parity test for the user script's copy of the librarian
 * (src/core/archiveLibrarian.ts and its steps in archiveSources.ts): the same
 * prompts and defaults, the same reading of the same replies, and the same
 * candidates and funnel from the same stubbed world.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../src/core/archiveLibrarian.js";
import { catalogueUrl, insideUrl } from "../src/core/internetArchive.js";
import type { InsideResponse } from "../src/core/internetArchive.js";
import {
  bestStretch,
  citationWithPage,
  claimTerms,
  findArchiveCandidates,
  formatArchiveCitation,
  pagePassages,
  parseCatalogueHits,
  quotePage,
  rankPlannedHits,
  viewerUrl,
} from "../src/core/archiveSources.js";
import { librarianLine } from "../src/cli/commands/archive.js";
import { loadUserScript } from "./userscriptLoader.js";
import { BOOKS, CLAIM, PAGE_P1, PARAGRAPH, PLAN, worldFetch, type Sent } from "./librarianWorld.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const script = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" });

test("the user script sends the same prompts, and defaults to the same models", () => {
  assert.equal(script.prompts.plan, lib.PLAN_SYSTEM);
  assert.equal(script.prompts.books, lib.BOOKS_SYSTEM);
  assert.equal(script.prompts.judge, lib.JUDGE_SYSTEM);
  assert.deepEqual(script.models, lib.DEFAULT_LIBRARIAN_MODELS);
  const off = loadUserScript({}, { window: { cnfirmedArchiveBooksModel: false, cnfirmedArchiveJudgeModel: "openai/gpt-oss-20b" } });
  assert.deepEqual(off.models, { planner: "zai-org/GLM-5.2", books: null, judge: "openai/gpt-oss-20b" });
});

test("the user script reads the models' replies as the core does", () => {
  const c = { articleTitle: "Princess_Feodora_of_Leiningen", section: null, paragraph: `  ${"word ".repeat(600)}`, claim: "Feodora's father died in 1814." };
  assert.equal(script.libPlanPrompt(c), lib.planPrompt(c));
  assert.equal(script.libBooksPrompt(c), lib.booksPrompt(c));
  const replies = [
    `ok ${JSON.stringify(PLAN)}`,
    '{"fact": "x", "queries": [["a", "b"], "  c   d ", 7, null], "terms": [[["1814"]], "Leiningen", [], [" "]]}',
    '{"queries": [{"q": "Leiningen 1814"}, [["nested", "query"]], "a/b \\"c"], "terms": [["1814"], ["Leiningen"]]}',
    '{"queries": []}',
    "nothing",
    JSON.stringify(BOOKS),
    '{"books": [{"title": "Long title of a book", "author": "  ", "year": "c. 1900"}, null, {"title": "ab"}]}',
  ];
  for (const r of replies) {
    assert.deepEqual(script.libParsePlan(r), lib.parsePlan(r), r);
    assert.deepEqual(script.libParseBooks(r), lib.parseBooks(r), r);
    assert.deepEqual(script.libJsonObjectIn(r), lib.jsonObjectIn(r), r);
  }
  for (const b of [
    ...BOOKS.books,
    { title: "Of It", author: null, year: null },
    { title: "Utah Place Names", author: "J. W. Van Cott", year: 1990 },
    { title: "Roman Art", author: "Eugénie Strong", year: 1928 },
    { title: "The Great Melody", author: "Conor Cruise O\u2019Brien", year: 1992 },
    { title: "Die Welt der Art", author: "'Quoted'", year: null },
  ]) {
    assert.equal(script.libCatalogueQuery(b), lib.catalogueQuery(b));
  }
  assert.equal(script.iaCatalogueUrl("title:(Utah) AND creator:(Cott)", 5), catalogueUrl("title:(Utah) AND creator:(Cott)", 5));
  const docs = { response: { docs: [{ identifier: "a", title: ["T"], creator: "C", date: "1901-01-01", collection: ["inlibrary"] }, { title: "no id" }, null] } };
  assert.deepEqual(script.parseCatalogueHits(docs, "q"), parseCatalogueHits(docs, "q"));
  for (const [status, body] of [[200, '{"choices":[{"message":{"content":"hi"}}]}'], [400, '{"error":{"message":"Model not allowed: x"}}'], [429, "Too many requests"], [200, "{}"]] as const) {
    let a: unknown, b: unknown;
    try { a = script.workerReplyText(status, body); } catch (e) { a = (e as Error).message; }
    try { b = lib.workerReplyText(status, body); } catch (e) { b = (e as Error).message; }
    assert.equal(a, b, body);
  }
});

test("the user script calls the Worker as the core does: body, caps, effort and retries", async () => {
  assert.deepEqual(script.limits, { plan: lib.PLAN_MAX_TOKENS, books: lib.BOOKS_MAX_TOKENS, judge: lib.JUDGE_MAX_TOKENS, booksEffort: lib.BOOKS_EFFORT });
  for (const effort of [undefined, "low"]) {
    assert.equal(script.workerRequestBody("m", "s", "u", 10, effort), lib.workerRequestBody("m", "s", "u", 10, effort));
  }
  const empty = '{"choices":[{"message":{"content":null},"finish_reason":"length"}]}';
  for (const [status, text] of [[200, empty], [200, '{"choices":[{"message":{"content":"x"}}]}'], [200, "{}"], [429, "x"], [500, "x"], [504, ""], [400, "x"]] as const) {
    for (const attempt of [0, 1, 2, 3]) {
      assert.equal(script.workerShouldRetry(status, text, attempt), lib.workerShouldRetry(status, text, attempt), `${status} ${text} ${attempt}`);
    }
    assert.equal(script.workerReplyContent(text), lib.replyContent(text));
  }
  // The script's own call: an answerless reply is tried once more, then fails.
  const sent: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(String(init.body));
    return new Response(empty, { status: 200 });
  }) as typeof fetch;
  const realTimeout = globalThis.setTimeout;
  const waits: number[] = [];
  globalThis.setTimeout = ((f: () => void, ms: number) => {
    waits.push(ms);
    f();
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    await assert.rejects(script.callWorkerModel("m", "s", "u", 10, "low"), /Worker: empty reply/);
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  assert.deepEqual(waits, [10_000]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], lib.workerRequestBody("m", "s", "u", 10, "low"));
});

test("the user script makes model queries and phrases safe as the core does", () => {
  for (const q of ['"Bet Yerah/Philoteria" 1814', '"Leiningen 1814 died', "Hood~2 [1900 TO 1910] title:(x)", 'Saxe-Coburg -death "" 1814', '"Gustave Eiffel" "300 metres"', '"Eiffel" ""  " 1889 " tower', "", 'a\\b "c"']) {
    assert.equal(script.libSafeQuery(q), lib.safeQuery(q), q);
    assert.equal(script.libSafeTerm(q), lib.safeTerm(q), q);
  }
  assert.equal(script.iaPhrase("1/2 of the land"), '"1 2 of the land"');
});

test("the user script builds the same terms, shelf queries and planner ranking", () => {
  for (const plan of [PLAN, null, { fact: "", queries: [], terms: [['say "xy"'], ["Say xy"], ["x"], ["xy"]] }]) {
    for (const [claim, title] of [[CLAIM, "Eiffel_Tower"], ["The population of 616,093 was recorded in 1921 by Anna Berg.", "Oslo"]]) {
      assert.deepEqual(script.libTellingTerms(plan, script.iaClaimTerms(claim, title)), lib.tellingTerms(plan, claimTerms(claim, title)));
    }
  }
  const ids = ["a1", "in.ernet.dli.2015.1", ...Array.from({ length: 23 }, (_, i) => `b${i}`)];
  assert.deepEqual(script.libShelfQueries("1814", ids), lib.shelfQueries("1814", ids));
  const odd = [["23"], ["Carl"], ["Saxe-Coburg"], ["completed", "metre"]];
  for (const text of [
    "The Eiffel tower, completed in 1889", "nothing", "EIFFEL 984 feet", "Eiffel's tower, 300 metres",
    "sold in 1923 at Carlisle", "Saxe-Coburg-Gotha, com- pleted, two metres", "23 Carl", "",
  ]) {
    for (const terms of [PLAN.terms, odd]) {
      assert.equal(script.libPlanCoverage(text, terms), lib.planCoverage(text, terms), text);
      assert.deepEqual(script.libPlanMatched(text, terms), lib.planMatched(text, terms), text);
    }
  }
  assert.deepEqual(script.libNameConcepts(PLAN.terms), lib.nameConcepts(PLAN.terms));
  const hit = (identifier: string, highlights: string[], collections = ["americana"]) => ({
    identifier, title: identifier, creator: null, year: null, mediatype: "texts", collections, file: null, highlights, rank: 0, query: "q",
  });
  const lists = () => [
    [hit("two", ["Eiffel finished it in 1889."]), hit("none", ["Price list for 1889: completed orders."]), hit("dup", ["Eiffel 1889"])],
    [hit("all", ["The Eiffel tower, completed in 1889, rose 300 metres."]), hit("dup", ["Eiffel 1889 again"]), hit("closed", ["Eiffel 1889"], ["printdisabled"])],
    // Each passage with one concept; together they pass.
    [hit("split", ["the Eiffel tower"]), hit("two", ["Eiffel completed it"])],
    [hit("split", ["in 1889 the tower", "the Eiffel tower, completed"])],
  ];
  for (const terms of [PLAN.terms, [], [["1889"]]]) {
    assert.deepEqual(script.rankPlannedHits(lists(), terms), rankPlannedHits(lists(), terms));
  }
});

test("the user script checks quotes and reads verdicts as the core does", () => {
  const passages = ["the Prince of Leiningen, who died in 18-", "14, left her a widow; In July 1814, how- ever, Prince Charles died"];
  passages.push("the Duke of Saxe- Coburg died");
  for (const q of [
    "In July 1814, however, Prince Charles died", "Prince of Leiningen … In July 1814", "Emich Karl died in 1814", "1814", "",
    "[...] who died in 1814", "the Duke of Saxe-Coburg died", "Duke of Saxe Coburg", "Saxe-Weimar died",
  ]) {
    assert.equal(script.libQuoteInPassages(q, passages), lib.quoteInPassages(q, passages), q);
    assert.equal(script.libQuoteKey(q), lib.quoteKey(q), q);
  }
  const books = [
    { title: "A", year: null, passages: ["When her first husband, Emich Charles, Prince of Leiningen, died in 1814"] },
    { title: "B ".repeat(100), year: 1990, passages: ["Leiningen castle", "x".repeat(900), "y"] },
    { title: "C", year: null, passages: [] },
  ];
  const c = { articleTitle: "Princess_Feodora", section: "Life", paragraph: "p ".repeat(800), claim: "Feodora's father died in 1814." };
  for (const fact of [null, "Emich Karl died in 1814.", c.claim]) {
    assert.equal(script.libJudgePrompt({ ...c, fact }, books), lib.judgePrompt({ ...c, fact }, books));
  }
  const replies = [
    JSON.stringify({ books: [{ id: "B1", verdict: "Supports", quote: "Emich Charles, Prince of Leiningen, died in 1814", why: "Yes." }, { id: "b2", verdict: "no" }, { verdict: "partial", quote: "invented words here" }] }),
    JSON.stringify({ books: [{ verdict: "maybe" }, null, { id: "B3", verdict: "unsupported", why: 3 }] }),
  ];
  for (const r of replies) assert.deepEqual(script.libParseJudgement(r, books), lib.parseJudgement(r, books), r);
  assert.throws(() => script.libParseJudgement("no", books), /no verdicts/);
});

test("the user script's librarian finds what the core's does", async () => {
  const page = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" });
  page.setClaimContexts([{ claim: CLAIM, context: PARAGRAPH, section: null, links: [] }]);
  const scriptSent: Sent[] = [];
  globalThis.fetch = worldFetch(scriptSent);
  const fromScript = await page.findArchiveCandidates(0);
  const coreSent: Sent[] = [];
  globalThis.fetch = worldFetch(coreSent);
  const fromCore = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { librarian: { client: lib.workerChatClient() } },
  );
  assert.deepEqual(fromScript.candidates, fromCore.candidates);
  assert.deepEqual(fromScript.funnel, fromCore.funnel);
  assert.equal(fromScript.funnel.librarian.added, 4);
  // The same model calls, word for word.
  const calls = (sent: Sent[]) => sent.filter((s) => s.url.endsWith("/hf")).map((s) => JSON.stringify(s.body));
  assert.deepEqual(calls(scriptSent).sort(), calls(coreSent).sort());
  assert.equal(calls(scriptSent).length, 2);
  // The same searches inside the shortlist.
  const inside = (sent: Sent[]) =>
    sent.map((s) => new URL(s.url).searchParams.get("user_query") ?? "").filter((q) => q.includes("identifier:(")).sort();
  assert.deepEqual(inside(scriptSent), inside(coreSent));
  assert.equal(inside(scriptSent).length, 3);
});

test("the user script runs the librarian for a claim with no word to search on", () => {
  const page = loadUserScript({ wgTitle: "Princess Feodora of Leiningen", wgPageName: "Princess_Feodora_of_Leiningen" });
  page.setClaimContexts([{ claim: "This was later confirmed.", context: "Her father died in 1814. This was later confirmed.", section: null, links: [] }]);
  assert.equal(page.archiveQueriesFor(0).length, 0);
  assert.equal(page.archiveNothingToSearch(0), false);
  const off = loadUserScript({ wgTitle: "Princess Feodora of Leiningen" }, { window: { cnfirmedArchiveLibrarian: false } });
  off.setClaimContexts([{ claim: "This was later confirmed.", context: "x", section: null, links: [] }]);
  assert.equal(off.archiveNothingToSearch(0), true);
});

test("the user script's librarian adds the planner's passages to a book the search already shows", async () => {
  const page = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" });
  page.setClaimContexts([{ claim: CLAIM, context: PARAGRAPH, section: null, links: [] }]);
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent);
  const r = await page.findArchiveCandidates(0);
  const shown = new Set(r.candidates.map((c: { evidence: { identifier: string } }) => c.evidence.identifier));
  const tiss = r.candidates.find((c: { evidence: { identifier: string } }) => c.evidence.identifier === "eiffeltowerdescr00tiss");
  assert.ok(tiss.evidence.passages.includes("Eiffel completed the tower in 1889."), "the planner's passage joins the shown book");
  assert.ok(shown.has("tourdetroiscents00eiff"));
});

test("the user script checks every lead in one call, and falls back to the Verify API with the restated claim", async () => {
  const page = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" });
  const ctx = { claim: CLAIM, context: PARAGRAPH, section: null, links: [] };
  const leads = [
    { title: "La tour", evidence: { year: 1900, passages: ["The Eiffel tower, completed in 1889, rose 300 metres above the Champ de Mars."] } },
    { title: "Guide", evidence: { year: null, passages: ["Paris has many towers."] } },
  ];
  const judge = { books: [{ id: "B1", verdict: "supports", quote: "completed in 1889, rose 300 metres", why: "States it." }, { id: "B2", verdict: "no", why: "Topic." }] };
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent, { judge });
  const r = await page.checkArchiveLeads(ctx, PLAN, leads);
  assert.equal(r.by, "zai-org/GLM-5.2");
  assert.equal(sent.length, 1, "one call for every lead");
  const books = leads.map((l) => ({ title: l.title, year: l.evidence.year, passages: l.evidence.passages }));
  const core = await lib.judgeArchiveBooks({ articleTitle: "Eiffel Tower", section: null, paragraph: PARAGRAPH, claim: CLAIM, fact: PLAN.fact }, books, lib.workerChatClient(), "zai-org/GLM-5.2");
  assert.deepEqual(r.verdicts, core);

  // The judge down: each lead to the Verify API, with the restated claim.
  const verifySent: Sent[] = [];
  const world = worldFetch(verifySent, { judgeStatus: 400 });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/verify")) {
      verifySent.push({ url, body: JSON.parse(String(init!.body)) });
      return Response.json({ verdict: "PARTIALLY SUPPORTED", comments: "Part.", verified_text: "completed in 1889" });
    }
    return world(url, init);
  }) as typeof fetch;
  const r2 = await page.checkArchiveLeads(ctx, PLAN, leads);
  assert.equal(r2.by, "verify-api");
  assert.deepEqual(r2.verdicts.map((v: { verdict: string }) => v.verdict), ["partial", "partial"]);
  const asked = verifySent.filter((s) => s.url.includes("/v1/verify"));
  assert.equal(asked.length, 2);
  assert.equal(asked[0].body!.claim, PLAN.fact);

  // No judge model: straight to the Verify API, with the claim as written when there is no plan.
  const noJudge = loadUserScript({ wgTitle: "Eiffel Tower" }, { window: { cnfirmedArchiveJudgeModel: false } });
  verifySent.length = 0;
  const r3 = await noJudge.checkArchiveLeads(ctx, null, leads.slice(0, 1));
  assert.equal(r3.by, "verify-api");
  assert.equal(verifySent.length, 1);
  assert.equal(verifySent[0].body!.claim, CLAIM);
});

test("with the librarian off, the user script makes no model call", async () => {
  const page = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" }, { window: { cnfirmedArchiveLibrarian: false } });
  page.setClaimContexts([{ claim: CLAIM, context: PARAGRAPH, section: null, links: [] }]);
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent);
  const r = await page.findArchiveCandidates(0);
  assert.equal(r.funnel.librarian, undefined);
  assert.ok(!sent.some((s) => s.url.endsWith("/hf")));
  assert.ok(!sent.some((s) => (new URL(s.url).searchParams.get("user_query") ?? "").includes("identifier:(")));
});

test("the user script searches inside page by page as the core does: terms, request, passages, pages", () => {
  for (const t of ["Prince Charles", "1814", 'a/b "c"', "Saxe-Coburg"]) assert.equal(script.libInsideTerm(t), lib.insideTerm(t), t);
  for (const r of [
    { identifier: "magazines", doc: "2004/Issue 10 & 11", terms: ["1889", '"300 metres"'] },
    { identifier: "in.ernet.dli.2015.1", doc: null, terms: ["x"] },
  ]) {
    assert.equal(script.iaInsideUrl("https://w.example/", r), insideUrl("https://w.example/", r));
  }
  const matched = (t: string) => lib.planMatched(t, PLAN.terms);
  const long = `${"filler ".repeat(200)}The tower was completed in 1889 by Eiffel, 300 metres tall. ${"more ".repeat(200)}`;
  for (const chars of [100, 600, 5000]) assert.equal(script.iaBestStretch(long, matched, chars), bestStretch(long, matched, chars));
  const reply: InsideResponse = {
    id: "b", doc: "b", q: ["1889"], counts: [5], pageConfidence: 70,
    matches: [
      { text: "Paris, 1889.", terms: [0], leaf: 3, page: "iv" },
      { text: "Nothing to do with it.", terms: [0], leaf: 4, page: "v" },
      { text: long, terms: [0], leaf: 9, page: "3", leafEnd: 10, pageEnd: "4" },
      { text: PAGE_P1, terms: [0], leaf: 57, page: "41" },
      { text: "Eiffel in 1889.", terms: [0], leaf: null, page: null },
    ],
  };
  for (const confidence of [70, 10, null]) {
    const r = { ...reply, pageConfidence: confidence };
    assert.deepEqual(script.iaPagePassages(r, matched), pagePassages(r, matched), String(confidence));
  }
  for (const terms of [PLAN.terms, [["Philoteria"], ["sister"], ["named"]], [["x"]]]) {
    assert.deepEqual(script.libSpecificConcepts(terms), lib.specificConcepts(terms));
    const m = (t: string) => lib.planMatched(t, terms);
    const r = { ...reply, matches: [...reply.matches, { text: "Ada, the sister of Mausolus, was named queen.", terms: [0], leaf: 7, page: "9" }] };
    assert.deepEqual(script.iaPagePassages(r, m, lib.specificConcepts(terms)), pagePassages(r, m, lib.specificConcepts(terms)));
  }
});

test("the user script gives a checked quote's page to the citation and the viewer as the core does", () => {
  const cite = formatArchiveCitation({ identifier: "tour", title: "La tour", creator: "Eiffel", year: 1900 }, "borrow", { publisher: "P", isbn: null });
  for (const at of [{ leaf: 57, page: "41" }, { leaf: 57, page: "41", leafEnd: 58, pageEnd: "42" }, { leaf: 57, page: null }, { leaf: 3, page: "xii" }]) {
    assert.deepEqual(script.iaCitationWithPage(cite, at), citationWithPage(cite, at), JSON.stringify(at));
  }
  const odd = { template: "{{Cite book |title=T |url= |page=}}", ref: "", kind: "cite book" as const };
  assert.deepEqual(script.iaCitationWithPage(odd, { leaf: 1, page: "2" }), citationWithPage(odd, { leaf: 1, page: "2" }));
  const evidence = { passages: ["Eiffel completed it in 1889.", PAGE_P1], pages: [null, { leaf: 57, page: "41" }] };
  for (const q of ["the tower was completed, and Eiffel climbed to its summit", "Eiffel completed it in 1889", ""]) {
    assert.deepEqual(script.iaQuotePage(evidence, q), quotePage(evidence, q), q);
  }
  const terms = claimTerms(CLAIM, "Eiffel Tower");
  assert.equal(script.iaViewerUrl("https://archive.org/details/tour", PAGE_P1, script.iaClaimTerms(CLAIM, "Eiffel Tower"), { leaf: 57, page: "41" }),
    viewerUrl("https://archive.org/details/tour", PAGE_P1, terms, { leaf: 57, page: "41" }));

  // The panel: the link opens on the quote's page, and the note gives the page.
  const c = {
    url: "https://archive.org/details/tour", title: "La tour", snippet: PAGE_P1, citation: citationWithPage(cite, { leaf: 57, page: "41" }),
    evidence: { ...evidence, year: 1900, access: "open", viewerUrl: "https://archive.org/details/tour?q=x" },
    check: { verdict: "supports", quote: "the tower was completed, and Eiffel climbed to its summit", reason: "States it." },
  };
  const item = script.archiveItem(c, "supports", true, "k", script.iaClaimTerms(CLAIM, "Eiffel Tower"));
  assert.match(item.url, /^https:\/\/archive\.org\/details\/tour\/page\/leaf57\?q=/);
  assert.match(item.note, /p\. 41: check it against the scan/);
  assert.match(item.ref, /\|page=41 \|url=https:\/\/archive\.org\/details\/tour\/page\/41 \|/);
  const unpaged = script.archiveItem({ ...c, check: { ...c.check, quote: "Eiffel completed it in 1889" } }, "supports", true, "k", script.iaClaimTerms(CLAIM, "Eiffel Tower"));
  assert.match(unpaged.note, /Find the page in the book and add \|page=/);
  const leafOnly = { ...c, evidence: { ...c.evidence, pages: [null, { leaf: 57, page: null }] } };
  const unnumbered = script.archiveItem(leafOnly, "supports", true, "k", script.iaClaimTerms(CLAIM, "Eiffel Tower"));
  assert.match(unnumbered.note, /opens the book on the passage: add its page number/);
  assert.match(unnumbered.url, /\/page\/leaf57\?q=/);
});

test("the user script asks the Worker for the same pages as the core, and none with page search off", async () => {
  const page = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" });
  page.setClaimContexts([{ claim: CLAIM, context: PARAGRAPH, section: null, links: [] }]);
  const scriptSent: Sent[] = [];
  globalThis.fetch = worldFetch(scriptSent, { insideStatus: { undatedpamphlet: 502 } });
  const fromScript = await page.findArchiveCandidates(0);
  const coreSent: Sent[] = [];
  globalThis.fetch = worldFetch(coreSent, { insideStatus: { undatedpamphlet: 502 } });
  const fromCore = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { librarian: { client: lib.workerChatClient() } },
  );
  const pages = (sent: Sent[]) => sent.map((s) => s.url).filter((u) => u.includes("/archive/inside?")).sort();
  assert.deepEqual(pages(scriptSent), pages(coreSent));
  assert.equal(pages(scriptSent).length, 7, "five leads, and two books no lead came from");
  assert.deepEqual(fromScript.funnel, fromCore.funnel);
  assert.deepEqual(fromScript.candidates, fromCore.candidates);
  assert.equal(page.archiveLibrarianLine(fromScript.funnel.librarian), librarianLine(fromCore.funnel));
  assert.match(librarianLine(fromCore.funnel), /7 open book\(s\) page by page \(2 beyond the leads\), 4 with a passage/);

  const off = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" }, { window: { cnfirmedArchivePageSearch: false } });
  off.setClaimContexts([{ claim: CLAIM, context: PARAGRAPH, section: null, links: [] }]);
  const offSent: Sent[] = [];
  globalThis.fetch = worldFetch(offSent);
  const r = await off.findArchiveCandidates(0);
  assert.equal(pages(offSent).length, 0);
  assert.deepEqual(r.funnel.librarian.pages, { books: 0, beyond: 0, found: 0 });
});

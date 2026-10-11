/**
 * The librarian (src/core/archiveLibrarian.ts) and its place in the Archive
 * stage: parsing the models' replies, the terms and queries built from them,
 * the quote check, and the whole flow on a stubbed world.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIBRARIAN_MODELS,
  catalogueQuery,
  judgeArchiveBooks,
  judgePrompt,
  parseBooks,
  parseJudgement,
  parsePlan,
  quoteInPassages,
  safeQuery,
  safeTerm,
  shelfQueries,
  shelfSearchable,
  tellingTerms,
  workerChatClient,
  workerReplyText,
  workerShouldRetry,
} from "../src/core/archiveLibrarian.js";
import { catalogueUrl } from "../src/core/internetArchive.js";
import { claimTerms, findArchiveCandidates, rankPlannedHits } from "../src/core/archiveSources.js";
import type { ArchiveHit } from "../src/core/archiveSources.js";
import { CLAIM, PARAGRAPH, PLAN, worldFetch, type Sent } from "./librarianWorld.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

test("parsePlan: reads the plan out of surrounding text, and forgives a small model's shapes", () => {
  const plan = parsePlan(
    'Sure.\n{"fact": " Emich Karl,  Prince of Leiningen, died in 1814. ", "queries": ["\\"Emich Karl\\" 1814", ["Leiningen", "1814"], "x", "\\"Emich Karl\\" 1814", "a", "b c d", "e f g"], ' +
      '"terms": [[["1814"]], ["Leiningen", "Leiningen", "Prince Charles"], "father", [], [""]]}\nDone.',
  );
  assert.deepEqual(plan, {
    fact: "Emich Karl, Prince of Leiningen, died in 1814.",
    // Arrays joined, the short and repeated ones dropped, three at most.
    queries: ['"Emich Karl" 1814', "Leiningen 1814", "b c d"],
    // Nested one level too deep, a bare string, empty groups: all read.
    terms: [["1814"], ["Leiningen", "Prince Charles"], ["father"]],
  });
  assert.equal(parsePlan("no json here"), null);
  assert.equal(parsePlan('{"fact": "only a fact"}'), null, "nothing to search with");
});

test("tellingTerms: numbers, then names, then the rest; the claim's own terms without a plan", () => {
  assert.deepEqual(tellingTerms(PLAN, claimTerms(CLAIM, "Eiffel Tower")), ["1889", "300 metres", "Eiffel"]);
  assert.deepEqual(
    tellingTerms(null, claimTerms("The population of 616,093 was recorded in 1921 by Anna Berg.", "Oslo")),
    ["1921", "616,093", "anna berg"],
  );
  // A name first; quotes cannot go inside a quoted term; a repeat or a single letter adds nothing.
  assert.deepEqual(
    tellingTerms({ fact: "", queries: [], terms: [['say "xy"'], ["Say xy"], ["x"], ["xy"]] }, claimTerms(CLAIM, "Eiffel Tower")),
    ["Say xy", "xy"],
  );
});

test("catalogueQuery: the title's longer words and the author's surname", () => {
  assert.equal(
    catalogueQuery({ title: "Queen Victoria: A Personal History", author: "Christopher Hibbert", year: 2000 }),
    "title:(Queen AND Victoria AND Personal AND History) AND creator:(Hibbert)",
  );
  assert.equal(catalogueQuery({ title: "Utah Place Names", author: null, year: null }), "title:(Utah AND Place AND Names)");
  assert.equal(catalogueQuery({ title: "Of It", author: "Al", year: null }), null);
  assert.equal(
    catalogueUrl("title:(Utah)", 5),
    "https://archive.org/advancedsearch.php?q=(title%3A(Utah))%20AND%20mediatype%3Atexts" +
      "&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=date&fl[]=collection&fl[]=mediatype&rows=5&output=json",
  );
});

test("parseBooks: title, surname and year, six at most", () => {
  const books = parseBooks(
    JSON.stringify({ books: [{ title: "Utah Place Names", author: "Van Cott", year: "1990" }, { title: "x" }, ...Array(8).fill({ title: "Book" })] }),
  );
  assert.deepEqual(books[0], { title: "Utah Place Names", author: "Van Cott", year: 1990 });
  assert.equal(books.length, 6);
  assert.deepEqual(parseBooks('{"books": []}'), []);
  assert.deepEqual(parseBooks("I am not sure any book exists."), []);
});

test("shelfQueries: every identifier quoted, dotted ones left out, twenty to a query", () => {
  assert.equal(shelfSearchable("in.ernet.dli.2015.226985"), false);
  assert.equal(shelfSearchable("bwb_Y0-BNE-527"), true);
  const ids = ["a1", "in.ernet.dli.2015.1", ...Array.from({ length: 21 }, (_, i) => `b${i}`)];
  const qs = shelfQueries("1814", ids);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].size, 20);
  assert.ok(qs[0].query.startsWith('"1814" identifier:("a1" OR "b0" OR'));
  assert.ok(!qs[0].query.includes("dli"));
  assert.deepEqual(qs[1], { query: '"1814" identifier:("b19" OR "b20")', size: 2 });
});

test("quoteInPassages: the words must be there, OCR line breaks and ellipses allowed", () => {
  const passages = ["the Prince of Leiningen, who died in 18-", "14, left her a widow; In July 1814, how- ever, Prince Charles died"];
  assert.ok(quoteInPassages("In July 1814, however, Prince Charles died", passages));
  assert.ok(quoteInPassages("Prince of Leiningen … In July 1814", passages));
  assert.ok(!quoteInPassages("Emich Karl died in 1814", passages), "not in the passages");
  assert.ok(!quoteInPassages("1814", passages), "too short to show anything");
  assert.ok(!quoteInPassages("", passages));
});

test("parseJudgement: a verdict per book in order; an unverifiable quote does not count", () => {
  const books = [
    { title: "A", year: null, passages: ["When her first husband, Emich Charles, Prince of Leiningen, died in 1814"] },
    { title: "B", year: 1990, passages: ["Leiningen castle was rebuilt"] },
    { title: "C", year: null, passages: ["In 1814 the prince died"] },
    { title: "D", year: null, passages: ["nothing"] },
  ];
  const v = parseJudgement(
    JSON.stringify({
      books: [
        { id: "B1", verdict: "Supports", quote: "Emich Charles, Prince of Leiningen, died in 1814", why: "States it." },
        { id: "b2", verdict: "no", quote: "", why: "Topic only." },
        { id: "B3", verdict: "partial", quote: "the prince died in 1814 at Amorbach", why: "Invented." },
      ],
    }),
    books,
  );
  assert.deepEqual(v[0], { verdict: "supports", quote: "Emich Charles, Prince of Leiningen, died in 1814", reason: "States it." });
  assert.deepEqual(v[1], { verdict: "unsupported", quote: "", reason: "Topic only." });
  assert.equal(v[2]!.verdict, "unsupported");
  assert.match(v[2]!.reason, /^Not counted: its quote is not in the passages\./);
  assert.equal(v[3], null, "no verdict for that book");
  assert.throws(() => parseJudgement("I cannot tell.", books), /no verdicts/);
});

test("judgePrompt: the restated claim only when it adds something, and each book's passages capped", () => {
  const c = { articleTitle: "Princess_Feodora_of_Leiningen", section: "Life", paragraph: "p", claim: "Feodora's father died in 1814." };
  const books = [{ title: "Long", year: 1900, passages: Array(10).fill("x".repeat(500)) }, { title: "Empty", year: null, passages: [] }];
  const withFact = judgePrompt({ ...c, fact: "Emich Karl, Prince of Leiningen, died in 1814." }, books);
  assert.match(withFact, /^Article: Princess Feodora of Leiningen\n/);
  assert.match(withFact, /What the claim says, with the names its paragraph gives: Emich Karl/);
  assert.match(withFact, /B1\. Long \(1900\)\n/);
  assert.equal((withFact.match(/^- x+$/gm) ?? []).length, 3, "1,600 characters a book");
  assert.match(withFact, /B2\. Empty\n- \(no passage\)/);
  assert.doesNotMatch(judgePrompt({ ...c, fact: c.claim }, books), /What the claim says/);
});

test("workerReplyText: the reply's content, or an error saying why there is none", () => {
  assert.equal(workerReplyText(200, JSON.stringify({ choices: [{ message: { content: "hi" } }] })), "hi");
  assert.throws(() => workerReplyText(400, '{"error":{"message":"Model not allowed: x"}}'), /Worker 400: Model not allowed: x/);
  assert.throws(() => workerReplyText(429, "Too many requests"), /Worker 429: Too many requests/);
  assert.throws(() => workerReplyText(200, '{"choices":[{"message":{"content":""}}]}'), /empty reply/);
});

test("workerChatClient: the Worker's /hf route; a 429 is waited out, then retried", async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const replies = [new Response("Too many requests", { status: 429 }), Response.json({ choices: [{ message: { content: "ok" } }] })];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return replies.shift()!;
  }) as typeof fetch;
  const waits: number[] = [];
  const client = workerChatClient("https://worker.example/", async (ms) => void waits.push(ms));
  assert.equal(await client.chat("zai-org/GLM-5.2", "sys", "user", 100), "ok");
  assert.deepEqual(waits, [10_000]);
  assert.equal(sent[1].url, "https://worker.example/hf");
  assert.deepEqual(sent[1].body, {
    model: "zai-org/GLM-5.2",
    max_tokens: 100,
    temperature: 0,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ],
  });
});

test("workerChatClient: an answerless reply or a 5xx is tried once more, with reasoning_effort sent when given", async () => {
  const empty = JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "length" }] });
  const ok = JSON.stringify({ choices: [{ message: { content: "ok" } }] });
  const run = async (statuses: [number, string][], effort?: string) => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      const [status, body] = statuses.shift()!;
      return new Response(body, { status });
    }) as typeof fetch;
    const waits: number[] = [];
    const client = workerChatClient("https://worker.example", async (ms) => void waits.push(ms));
    let out: string;
    try { out = await client.chat("m", "s", "u", 10, effort); } catch (e) { out = (e as Error).message; }
    return { out, waits, sent };
  };
  assert.deepEqual((await run([[200, empty], [200, ok]])).out, "ok");
  assert.equal((await run([[200, empty], [200, empty]])).out, "Worker: empty reply");
  assert.equal((await run([[504, "Gateway Timeout"], [200, ok]])).out, "ok");
  const twice504 = await run([[504, "Gateway Timeout"], [504, "Gateway Timeout"]]);
  assert.equal(twice504.out, "Worker 504: Gateway Timeout");
  assert.deepEqual(twice504.waits, [10_000]);
  const limited = await run([[429, "x"], [429, "x"], [429, "x"], [429, "x"]]);
  assert.equal(limited.out, "Worker 429: x");
  assert.deepEqual(limited.waits, [10_000, 20_000, 40_000]);
  assert.equal((await run([[400, "bad"]])).sent.length, 1);
  const low = await run([[200, ok]], "low");
  assert.equal(low.sent[0].reasoning_effort, "low");
  assert.equal("reasoning_effort" in (await run([[200, ok]])).sent[0], false);
  assert.equal(workerShouldRetry(200, ok, 0), false);
});

test("safeQuery and safeTerm: what the full-text search's parser rejects is taken out", () => {
  assert.equal(safeQuery('"Bet Yerah/Philoteria" 1814'), '"Bet Yerah Philoteria" 1814');
  assert.equal(safeQuery('"Leiningen 1814 died'), "Leiningen 1814 died");
  assert.equal(safeQuery('Hood~2 [1900 TO 1910] title:(x)'), "Hood 2 1900 TO 1910 title x");
  assert.equal(safeQuery('Saxe-Coburg -death "" 1814'), "Saxe-Coburg death 1814");
  assert.equal(safeQuery('"Gustave Eiffel" "300 metres"'), '"Gustave Eiffel" "300 metres"');
  assert.equal(safeQuery('"Eiffel" ""  " 1889 " tower'), '"Eiffel" "1889" tower');
  assert.equal(safeTerm('say "xy" / 1/2'), "say xy 1 2");
  assert.deepEqual(parsePlan('{"queries": ["a/b c", "\\"x"], "terms": [["1/2"]]}')?.queries, ["a b c"]);
  assert.deepEqual(tellingTerms({ fact: "", queries: [], terms: [["Bet Yerah/Philoteria"]] }, claimTerms("x", "Y")), ["Bet Yerah Philoteria"]);
});

test("rankPlannedHits: best covered first, and only books about the claim", () => {
  const h = (identifier: string, highlights: string[], collections = ["americana"]): ArchiveHit => ({
    identifier, title: identifier, creator: null, year: null, mediatype: "texts", collections, file: null, highlights, rank: 0, query: "q",
  });
  const ranked = rankPlannedHits(
    [
      [h("two", ["Eiffel finished it in 1889."]), h("none", ["Price list for 1889: completed orders of 300 metres of cable."])],
      [h("all", ["The Eiffel tower, completed in 1889, rose 300 metres."]), h("one", ["Eiffel"]), h("closed", ["Eiffel completed it in 1889"], ["printdisabled"])],
    ],
    PLAN.terms,
  );
  assert.deepEqual(ranked.map((s) => s.hit.identifier), ["all", "two"]);
  assert.equal(ranked[0].score, 1);
  assert.deepEqual(ranked[0].passages[0].matched, ["1889", "eiffel", "300 metres", "completed"]);
});

test("findArchiveCandidates with the librarian: planner leads, named books, a search inside every lead", async () => {
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent);
  const r = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { librarian: { client: workerChatClient() } },
  );
  const lib = r.funnel.librarian!;
  assert.deepEqual(lib.plan, PLAN);
  assert.equal(lib.planned, 3, "the cable catalogue names nothing, the print-disabled book is closed");
  assert.equal(lib.named.length, 3);
  assert.equal(lib.namedFound, 2, "Eiffel's and Loyrette's; nobody's book is not there");
  assert.deepEqual(lib.shelfTerms, ["1889", "300 metres", "Eiffel"]);
  assert.equal(lib.shelfQueries, 3);
  assert.deepEqual(r.funnel.errors, []);

  const via = r.candidates.map((c) => [c.evidence.identifier, c.evidence.via ?? "search"]);
  assert.deepEqual(via.filter(([, v]) => v !== "search"), [
    ["tourdetroiscents00eiff", "planner"],
    ["in.ernet.dli.2015.1234", "planner"],
    // The second scan: the first has nothing in the full-text index.
    ["eiffeltowertour0000loyr_b2c3", "named"],
  ]);
  assert.equal(lib.added, 3);
  const loyrette = r.candidates.find((c) => c.evidence.via === "named")!;
  assert.equal(loyrette.evidence.access, "borrow");
  assert.match(loyrette.snippet, /completed in 1889 the tower stood 300 metres/);
  assert.match(loyrette.citation.ref, /url-access=registration/);
  // The search's own leads gained passages from the search inside.
  const pezz = r.candidates.find((c) => c.evidence.identifier === "eiffeltower0000pezz")!;
  assert.ok(pezz.evidence.passages.includes("The tower is 300 metres tall without its antennas."));
  // Models through the Worker: the planner and the librarian's list of books.
  const models = sent.filter((s) => s.url.endsWith("/hf")).map((s) => s.body!.model);
  assert.deepEqual(models, [DEFAULT_LIBRARIAN_MODELS.planner, DEFAULT_LIBRARIAN_MODELS.books]);
});

test("findArchiveCandidates: a failed planner is noted, and the search inside uses the claim's own terms", async () => {
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent, { plannerStatus: 400 });
  const r = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { librarian: { client: workerChatClient(), models: { books: null } } },
  );
  assert.deepEqual(r.funnel.errors, ["planner: Worker 400: no provider"]);
  assert.equal(r.funnel.librarian!.plan, null);
  assert.deepEqual(r.funnel.librarian!.shelfTerms, ["1889", "300", "gustave eiffel"]);
  assert.equal(r.funnel.librarian!.added, 0);
  assert.ok(!sent.some((s) => s.body && (s.body.messages as { content: string }[])[0].content.includes("reference librarian")));
});

test("judgeArchiveBooks: one call for every book, with the restated claim", async () => {
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent, {
    judge: { books: [{ id: "B1", verdict: "supports", quote: "completed in 1889, rose 300 metres", why: "States it." }, { id: "B2", verdict: "no", why: "Topic." }] },
  });
  const v = await judgeArchiveBooks(
    { articleTitle: "Eiffel Tower", section: null, paragraph: PARAGRAPH, claim: CLAIM, fact: PLAN.fact },
    [
      { title: "La tour", year: 1900, passages: ["The Eiffel tower, completed in 1889, rose 300 metres above the Champ de Mars."] },
      { title: "Guide", year: null, passages: ["Paris has many towers."] },
    ],
    workerChatClient(),
    "zai-org/GLM-5.2",
  );
  assert.deepEqual(v.map((x) => x?.verdict), ["supports", "unsupported"]);
  assert.equal(sent.length, 1);
  assert.match(String((sent[0].body!.messages as { content: string }[])[1].content), /What the claim says, with the names its paragraph gives: The Eiffel Tower was 300 metres/);
});

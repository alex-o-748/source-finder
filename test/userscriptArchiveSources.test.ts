/**
 * Parity test for the user script's inlined copy of the Internet Archive
 * stage: the same recorded search response through both implementations must
 * give the same queries, the same books, the same scores and the same `<ref>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  bestWindow,
  buildArchiveQueries,
  collapseCopies,
  parseItemDetails,
  searchPhrase,
  buildPhraseQueries,
  claimTerms,
  keyPhrases,
  mergeRankings,
  parseSearchHits,
  rankArchiveHits,
  rankByUnits,
  streamText,
  toArchiveCandidate,
} from "../src/core/archiveSources.js";
import { SEARCH_RETRY_WAITS_MS, SEARCH_URL, httpArchiveClient, searchParams, searchWithRetry } from "../src/core/internetArchive.js";
import { loadUserScript } from "./userscriptLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEARCH = JSON.parse(
  readFileSync(join(__dirname, "fixtures/archive/search_eiffel_1889.json"), "utf8"),
);

const script = loadUserScript();
const DETAILS = { publisher: "Paris : Masson", isbn: "9781590367254" };
const TITLE = "Eiffel_Tower";

const CLAIMS = [
  "The tower opened to visitors in 1889 and drew visitors from across Europe.",
  "On its completion in 1889 the tower was 300 metres tall, designed under Gustave Eiffel.",
  "The tower opened to visitors in 1889.",
  "The population of 616,093 was recorded in 1921 by Anna Berg.",
  "It was very popular with visitors.",
  "Feodora's father died in 1814, while the otter civet's webbed feet suit its aquatic habitat.",
  "The Greek name was chosen by Ptolemy II Philadelphus, who named it for his sister.",
];

test("the user script builds the same queries as the core", () => {
  for (const claim of CLAIMS) {
    for (const title of [TITLE, "Princess_Feodora_of_Leiningen", "Siege of Ganja (1804)"]) {
      const scriptTerms = script.iaClaimTerms(claim, title);
      const coreTerms = claimTerms(claim, title);
      assert.deepEqual(scriptTerms, coreTerms, claim);
      assert.deepEqual(script.iaKeyPhrases(claim, title), keyPhrases(claim, title), claim);
      assert.deepEqual(script.buildArchiveQueries(scriptTerms), buildArchiveQueries(coreTerms), claim);
      assert.deepEqual(script.buildPhraseQueries(scriptTerms), buildPhraseQueries(coreTerms), claim);
    }
  }
});

test("the user script ranks by claim units, merges, and reads a whole text as the core does", () => {
  const hits = () => parseSearchHits(SEARCH, "q");
  const scriptHits = () => script.parseArchiveHits(SEARCH, "q");
  for (const claim of CLAIMS) {
    const fromScript = script.rankArchiveByUnits(scriptHits(), claim, TITLE);
    const fromCore = rankByUnits(hits(), claim, TITLE);
    assert.deepEqual(fromScript, fromCore, claim);
    assert.deepEqual(
      script.mergeArchiveRankings(script.rankArchiveHits(scriptHits(), claim, TITLE, 0.3).ranked, fromScript),
      mergeRankings(rankArchiveHits(hits(), claim, TITLE, 0.3).ranked, fromCore),
      claim,
    );
  }
  const page =
    `<pre>${"filler words ".repeat(120)}The tower was com-\nplete in 1889, rising 300 metres, the work of ` +
    `Gustave Eiffel &amp; his men. ${"more ".repeat(120)}</pre>`;
  assert.equal(script.iaStreamText(page), streamText(page));
  const text = streamText(page)!;
  for (const claim of CLAIMS) {
    assert.deepEqual(script.iaBestWindow(text, claim, TITLE), bestWindow(text, claim, TITLE), claim);
  }
});

test("the user script asks archive.org for the same search", () => {
  const query = '"Eiffel Tower" "1889"';
  assert.equal(
    script.iaSearchUrl(query),
    `${SEARCH_URL}?${searchParams({ query, size: 50 })}`
      // URLSearchParams encodes spaces as "+", encodeURIComponent as "%20".
      .replace(/\+/g, "%20"),
  );
});

test("both ask a failed full-text search once more, for one more hit", async () => {
  const realFetch = globalThis.fetch;
  const run = async (statuses: number[], search: () => Promise<unknown>) => {
    const sizes: string[] = [];
    globalThis.fetch = (async (url: string) => {
      sizes.push(new URL(url).searchParams.get("hits_per_page")!);
      const status = statuses.shift()!;
      return status === 200 ? Response.json({ response: { body: { hits: { total: 0, hits: [] } } } }) : new Response("{}", { status });
    }) as typeof fetch;
    let out: string;
    try { await search(); out = "ok"; } catch (e) { out = (e as Error).message; }
    return { out, sizes };
  };
  try {
    const noWait = loadUserScript({}, { window: { cnfirmedArchiveRetryWait: 0 } });
    process.env.CNFIRMED_ARCHIVE_RETRY_WAIT = "0";
    for (const [statuses, want] of [
      [[200], { out: "ok", sizes: ["9"] }],
      // The backend's failure is served again for the same URL; one more hit is a fresh search.
      [[400, 200], { out: "ok", sizes: ["9", "10"] }],
      [[400, 400, 200], { out: "ok", sizes: ["9", "10", "11"] }],
      [[400, 400, 400], { out: "Internet Archive: HTTP 400", sizes: ["9", "10", "11"] }],
      [[404], { out: "Internet Archive: HTTP 404", sizes: ["9"] }],
    ] as const) {
      assert.deepEqual(await run([...statuses], () => noWait.iaSearch('"1938"', 9)), want);
      assert.deepEqual(await run([...statuses], () => httpArchiveClient.fullTextSearch({ query: '"1938"', size: 9 })), want);
    }
    // Live, the second and third tries wait 5 and 15 seconds.
    assert.deepEqual(SEARCH_RETRY_WAITS_MS, [5_000, 15_000]);
    const tries: number[] = [];
    await assert.rejects(
      searchWithRetry({ query: "q", size: 9 }, async (r) => { tries.push(r.size); throw Object.assign(new Error("x"), { status: 400 }); }, [1, 2]),
      /x/,
    );
    assert.deepEqual(tries, [9, 10, 11]);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.CNFIRMED_ARCHIVE_RETRY_WAIT;
  }
});

test("the user script parses the recorded response the same way", () => {
  assert.deepEqual(script.parseArchiveHits(SEARCH, "q"), parseSearchHits(SEARCH, "q"));
});

test("both implementations keep, score and cite the same books", () => {
  for (const claim of CLAIMS) {
    const fromScript = script.rankArchiveHits(script.parseArchiveHits(SEARCH, "q"), claim, TITLE, 0.3);
    const fromCore = rankArchiveHits(parseSearchHits(SEARCH, "q"), claim, TITLE, 0.3);
    assert.deepEqual(fromScript, fromCore, claim);

    const scriptTerms = script.iaClaimTerms(claim, TITLE);
    const coreTerms = claimTerms(claim, TITLE);
    fromCore.ranked.forEach((s, i) => {
      assert.deepEqual(
        script.toArchiveCandidate(fromScript.ranked[i], DETAILS, scriptTerms),
        toArchiveCandidate(s, DETAILS, coreTerms),
        `${claim} → ${s.hit.identifier}`,
      );
    });
  }
});

test("both search a book for the same words, and tell a bundled book apart the same way", () => {
  const ike = "He was promoted to lieutenant general on July 7.";
  const passages = [
    "CCS. Eisenhower, who had been promoted to lieutenant-general on July 7, 1942, prior to being dispatched",
    "effective June 24, 1942. He was promoted to lieutenant general on July 7. Unlike most commanders",
    "…the tower was com- pleted in 1889, rising 300 metres under Gustave Eiffel…",
    "Agreement on an initial Allied course of action came in July 1942.",
    "because the strength of the structure lies in the concrete core and not in the facing … the whole structure",
    "the facing of … masonry over the",
    "",
  ];
  for (const [claim, title] of [[ike, "Dwight_D._Eisenhower"], [CLAIMS[1], TITLE]]) {
    for (const text of passages) {
      assert.equal(script.iaSearchPhrase(text, script.iaClaimTerms(claim, title)), searchPhrase(text, claimTerms(claim, title)), text);
    }
  }

  const metadata = {
    metadata: { publisher: "Osprey" },
    files: ["009 - Bernard Montgomery", "018 - Eisenhower"].flatMap((b) => [{ name: `${b}.pdf` }, { name: `${b}_djvu.txt` }]),
  };
  assert.deepEqual(script.archiveDetailsOf(metadata), parseItemDetails(metadata));
  const response = (identifier: string, file: string) => ({
    response: { body: { hits: { hits: [{
      fields: { identifier, title: identifier, mediatype: "texts", collection: ["opensource"], file_basename: file },
      highlight: { text: [passages[0]] },
    }] } } },
  });
  const shown = (parse: (r: unknown, q: string) => ArchiveHitLike[], details: (m: unknown) => unknown) =>
    [response("009-bernard-montgomery", "018 - Eisenhower"), response("zaloga", "zaloga")].map((r, i) => {
      const hit = parse(r, "q")[0];
      return {
        s: { hit, access: "open", passages: [{ text: hit.highlights[0], score: 1, matched: [] }], score: 1 },
        details: details(i === 0 ? metadata : { metadata: {} }),
      };
    });
  const fromScript = shown(script.parseArchiveHits, script.archiveDetailsOf);
  const fromCore = shown(parseSearchHits as never, parseItemDetails as never);
  const funnels = [{ rejected: {} }, { rejected: {} }];
  assert.deepEqual(script.iaCollapseCopies(fromScript, funnels[0]), collapseCopies(fromCore as never, funnels[1]));
  assert.deepEqual(funnels[0], funnels[1]);
  const terms = claimTerms(ike, "Dwight_D._Eisenhower");
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(
      script.toArchiveCandidate(fromScript[i].s, fromScript[i].details, script.iaClaimTerms(ike, "Dwight_D._Eisenhower")),
      toArchiveCandidate(fromCore[i].s as never, fromCore[i].details as never, terms),
    );
  }
  assert.equal(script.toArchiveCandidate(fromScript[0].s, fromScript[0].details, terms).title, "018 - Eisenhower");
});

type ArchiveHitLike = { highlights: string[] };

test("the user script's live flow matches the core's", async () => {
  const { findArchiveCandidates } = await import("../src/core/archiveSources.js");
  // The word search alone; the librarian has its own test below.
  const eiffel = loadUserScript(
    { wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" },
    { window: { cnfirmedArchiveLibrarian: false } },
  );
  const claim = CLAIMS[1];
  eiffel.setClaimContexts([{ claim, context: claim, section: null, links: [] }]);

  const metadata: Record<string, unknown> = {
    eiffeltowerdescr00tiss: { metadata: { publisher: "Paris : Masson" } },
    guidetoparis1925: { metadata: { "access-restricted-item": "true" } },
    eiffeltower0000pezz: { metadata: { isbn: "9781590367254", "access-restricted-item": "true" } },
  };
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url));
    const id = decodeURIComponent(String(url).split("/metadata/")[1] ?? "");
    if (id) return metadata[id] ? Response.json(metadata[id]) : new Response("", { status: 404 });
    // The first search fails outright; the looser ones succeed.
    return searches++ === 0 ? new Response("", { status: 503 }) : Response.json(SEARCH);
  }) as typeof fetch;

  try {
    const fromScript = await eiffel.findArchiveCandidates(0);
    searches = 0;
    const fromCore = await findArchiveCandidates(
      { claim, context: claim, section: null, offset: 0, tag: "{{cn}}" },
      "Eiffel Tower",
    );
    assert.deepEqual(fromScript.candidates, fromCore.candidates);
    assert.deepEqual(fromScript.funnel, fromCore.funnel);
    assert.equal(fromScript.funnel.errors[0], "search failed: Internet Archive: HTTP 503");
    assert.deepEqual(
      fromScript.candidates.map((c: { evidence: { identifier: string } }) => c.evidence.identifier),
      ["eiffeltowerdescr00tiss", "undatedpamphlet", "eiffeltower0000pezz"],
    );
    const userQuery = (url: string) => new URL(url).searchParams.get("user_query") ?? "";
    assert.equal(userQuery(requested[0]), '"Eiffel Tower" "1889" "300" "gustave eiffel"');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("both drop an item of Wikipedia printouts that holds the article, as the core does", async () => {
  const { findArchiveCandidates } = await import("../src/core/archiveSources.js");
  const eiffel = loadUserScript(
    { wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" },
    { window: { cnfirmedArchiveLibrarian: false } },
  );
  const claim = CLAIMS[1];
  eiffel.setClaimContexts([{ claim, context: claim, section: null, links: [] }]);
  // The pamphlet's hit is in the printout itself, so it needs no lookup; the
  // Tissandier item is told by its other files.
  const search = structuredClone(SEARCH);
  for (const h of search.response.body.hits.hits) {
    if (h.fields.identifier === "undatedpamphlet") h.fields.file_basename = "Eiffel_Tower";
  }
  const printouts = {
    metadata: {},
    files: ["Paris", "Eiffel_Tower"].flatMap((b) => [{ name: `${b}.pdf` }, { name: `${b}_djvu.txt` }]),
  };
  const metadata = (id: string) => (id === "eiffeltowerdescr00tiss" ? printouts : { metadata: {} });
  const looked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const id = decodeURIComponent(String(url).split("/metadata/")[1] ?? "");
    if (id) {
      looked.push(id);
      return Response.json(metadata(id));
    }
    return Response.json(search);
  }) as typeof fetch;
  try {
    const fromScript = await eiffel.findArchiveCandidates(0);
    const fromCore = await findArchiveCandidates(
      { claim, context: claim, section: null, offset: 0, tag: "{{cn}}" },
      "Eiffel Tower",
      { client: { fullTextSearch: async () => search, metadata: async (id) => metadata(id) } },
    );
    assert.deepEqual(fromScript.candidates, fromCore.candidates);
    assert.deepEqual(fromScript.funnel, fromCore.funnel);
    assert.equal(fromScript.funnel.rejected["a printout of this Wikipedia article"], 2);
    const ids = fromScript.candidates.map((c: { evidence: { identifier: string } }) => c.evidence.identifier);
    assert.ok(!ids.includes("undatedpamphlet") && !ids.includes("eiffeltowerdescr00tiss"), ids.join());
    assert.ok(!looked.includes("undatedpamphlet"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("with the switch on, the user script reads whole texts as the core does", async () => {
  const { findArchiveCandidates } = await import("../src/core/archiveSources.js");
  const eiffel = loadUserScript(
    { wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" },
    { window: { cnfirmedArchiveFullText: true, cnfirmedArchiveLibrarian: false } },
  );
  const claim = CLAIMS[1];
  eiffel.setClaimContexts([{ claim, context: claim, section: null, links: [] }]);
  const page = (id: string) =>
    id === "annuaire1912"
      ? `<pre>${"autres choses ".repeat(80)}In 1889 the tower rose 300 metres, built by Gustave Eiffel. ${"suite ".repeat(80)}</pre>`
      : "<pre>rien</pre>";
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url));
    if (String(url).includes("/metadata/")) return Response.json({ metadata: {} });
    if (String(url).includes("/stream/")) {
      return new Response(page(decodeURIComponent(String(url).split("/stream/")[1].split("/")[0])));
    }
    return Response.json(SEARCH);
  }) as typeof fetch;
  try {
    const fromScript = await eiffel.findArchiveCandidates(0);
    const scriptRequests = requested.splice(0);
    const fromCore = await findArchiveCandidates(
      { claim, context: claim, section: null, offset: 0, tag: "{{cn}}" },
      "Eiffel Tower",
      {
        fullText: true,
        client: {
          fullTextSearch: async () => SEARCH,
          metadata: async () => ({ metadata: {} }),
          streamPage: async (id) => page(id),
        },
      },
    );
    assert.deepEqual(fromScript.candidates, fromCore.candidates);
    assert.deepEqual(fromScript.funnel, fromCore.funnel);
    assert.ok(fromScript.funnel.fullText.windows >= 1);
    assert.ok(
      scriptRequests.some((u) => u === "https://archive.org/stream/annuaire1912/annuaire1912_djvu.txt"),
      "the book's own text file, on archive.org",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

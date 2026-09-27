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
import { SEARCH_URL, searchParams } from "../src/core/internetArchive.js";
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

test("the user script's live flow matches the core's", async () => {
  const { findArchiveCandidates } = await import("../src/core/archiveSources.js");
  const eiffel = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" });
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

test("with the switch on, the user script reads whole texts as the core does", async () => {
  const { findArchiveCandidates } = await import("../src/core/archiveSources.js");
  const eiffel = loadUserScript(
    { wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" },
    { window: { cnfirmedArchiveFullText: true } },
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

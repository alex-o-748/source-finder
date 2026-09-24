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
  buildArchiveQueries,
  claimTerms,
  parseSearchHits,
  rankArchiveHits,
  toArchiveCandidate,
  withPublicDomainFilter,
} from "../src/core/archiveSources.js";
import { SEARCH_URL, searchParams } from "../src/core/internetArchive.js";
import { loadUserScript } from "./userscriptLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEARCH = JSON.parse(
  readFileSync(join(__dirname, "fixtures/archive/search_eiffel_1889.json"), "utf8"),
);

const script = loadUserScript();
const TITLE = "Eiffel_Tower";

const CLAIMS = [
  "The tower opened to visitors in 1889 and drew visitors from across Europe.",
  "On its completion in 1889 the tower was 300 metres tall, designed under Gustave Eiffel.",
  "The tower opened to visitors in 1889.",
  "The population of 616,093 was recorded in 1921 by Anna Berg.",
  "It was very popular with visitors.",
];

test("the user script builds the same queries as the core", () => {
  for (const claim of CLAIMS) {
    const fromScript = script.buildArchiveQueries(script.iaClaimTerms(claim, TITLE));
    const fromCore = buildArchiveQueries(claimTerms(claim, TITLE));
    assert.deepEqual(fromScript, fromCore, claim);
  }
});

test("the user script asks archive.org for the same search", () => {
  const query = withPublicDomainFilter('"Eiffel Tower" AND "1889"', 1930);
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
    const fromScript = script.rankArchiveHits(script.parseArchiveHits(SEARCH, "q"), claim, TITLE, 1930, 0.3);
    const fromCore = rankArchiveHits(parseSearchHits(SEARCH, "q"), claim, TITLE, 1930, 0.3);
    assert.deepEqual(fromScript, fromCore, claim);

    const scriptTerms = script.iaClaimTerms(claim, TITLE);
    const coreTerms = claimTerms(claim, TITLE);
    fromCore.ranked.forEach((s, i) => {
      assert.deepEqual(
        script.toArchiveCandidate(fromScript.ranked[i], "Paris : Masson", scriptTerms),
        toArchiveCandidate(s, "Paris : Masson", coreTerms),
        `${claim} → ${s.hit.identifier}`,
      );
    });
  }
});

test("the user script's live flow matches the core's, filter fallback included", async () => {
  const { findArchiveCandidates } = await import("../src/core/archiveSources.js");
  const eiffel = loadUserScript({ wgTitle: "Eiffel Tower", wgPageName: "Eiffel_Tower" });
  const claim = CLAIMS[1];
  eiffel.setClaimContexts([{ claim, context: claim, section: null, links: [] }]);

  const metadata: Record<string, unknown> = {
    eiffeltowerdescr00tiss: { metadata: { publisher: "Paris : Masson" } },
    guidetoparis1925: { metadata: { "access-restricted-item": "true" } },
  };
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  let first = true;
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url));
    // The first search rejects the filter, as an undocumented parameter might.
    if (first) {
      first = false;
      return new Response("", { status: 400 });
    }
    const id = decodeURIComponent(String(url).split("/metadata/")[1] ?? "");
    const body = id ? metadata[id] : SEARCH;
    return body ? Response.json(body) : new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const fromScript = await eiffel.findArchiveCandidates(0);
    const cutoff = new Date().getUTCFullYear() - 96;
    first = true;
    const fromCore = await findArchiveCandidates(
      { claim, context: claim, section: null, offset: 0, tag: "{{cn}}" },
      "Eiffel Tower",
      { cutoffYear: cutoff },
    );
    assert.deepEqual(fromScript.candidates, fromCore.candidates);
    assert.deepEqual(fromScript.funnel, fromCore.funnel);
    assert.equal(fromScript.funnel.filter, "gate only");
    assert.equal(fromScript.candidates.length, 1);
    const userQuery = (url: string) => new URL(url).searchParams.get("user_query") ?? "";
    assert.ok(userQuery(requested[0]).endsWith(" AND year:[1450 TO " + cutoff + "]"));
    assert.ok(!userQuery(requested[1]).includes("year:["));
  } finally {
    globalThis.fetch = realFetch;
  }
});

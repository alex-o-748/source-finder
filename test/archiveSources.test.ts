import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildArchiveQueries,
  claimTerms,
  editionKey,
  findArchiveCandidates,
  formatArchiveCitation,
  parseSearchHits,
  publicDomainCutoff,
  publicDomainGate,
  rankArchiveHits,
  scorePassage,
  scoringContext,
  viewerUrl,
  withPublicDomainFilter,
} from "../src/core/archiveSources.js";
import { searchParams } from "../src/core/internetArchive.js";
import type {
  ArchiveClient,
  MetadataResponse,
  SearchRequest,
  SearchResponse,
} from "../src/core/internetArchive.js";
import type { Claim } from "../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEARCH: SearchResponse = JSON.parse(
  readFileSync(join(__dirname, "fixtures/archive/search_eiffel_1889.json"), "utf8"),
);

const TITLE = "Eiffel Tower";
const CLAIM_TEXT =
  "On its completion in 1889 the tower was 300 metres tall, designed under Gustave Eiffel.";

function claimOf(text: string): Claim {
  return { claim: text, context: text, section: "History", offset: 0, tag: "{{cn}}" };
}

test("publicDomainCutoff: published in Y, public domain from 1 January of Y + 96", () => {
  assert.equal(publicDomainCutoff(new Date("2026-09-24")), 1930);
  assert.equal(publicDomainCutoff(new Date("2027-01-01")), 1931);
});

test("claimTerms: numbers as written with years first, names beyond the subject", () => {
  const t = claimTerms(
    "The population of 616,093 was recorded in 1921 by Anna Berg in Eiffel Tower",
    "Eiffel_Tower_(Paris)",
  );
  assert.equal(t.subject, "Eiffel Tower");
  assert.deepEqual(t.numbers, ["1921", "616,093"]);
  assert.deepEqual(t.names, ["anna berg"]);
});

test("buildArchiveQueries: strictest first, and nothing for a claim with no anchors", () => {
  assert.deepEqual(buildArchiveQueries(claimTerms(CLAIM_TEXT, TITLE)), [
    '"Eiffel Tower" AND "1889" AND "300" AND "gustave eiffel"',
    '"Eiffel Tower" AND "1889" AND "300"',
    '"Eiffel Tower" AND "1889"',
  ]);
  assert.deepEqual(buildArchiveQueries(claimTerms("It was very tall and quite famous", TITLE)), []);
});

test("the public-domain filter is a year range in the query, as checked live", () => {
  assert.equal(
    withPublicDomainFilter('"Eiffel Tower" AND "1889"', 1930),
    '"Eiffel Tower" AND "1889" AND year:[1450 TO 1930]',
  );
  const p = searchParams({ query: "q", size: 50 });
  assert.equal(p.get("service_backend"), "fts");
  assert.equal(p.get("user_query"), "q");
  assert.equal(p.get("hits_per_page"), "50");
});

test("parseSearchHits reads the recorded shape and strips highlight markers", () => {
  const hits = parseSearchHits(SEARCH, "q");
  assert.equal(hits.length, 9);
  const [pezzi] = hits;
  assert.equal(pezzi.identifier, "eiffeltower0000pezz");
  assert.equal(pezzi.year, 2008);
  assert.equal(pezzi.creator, "Pezzi, Bryan");
  assert.deepEqual(pezzi.collections, ["internetarchivebooks", "inlibrary"]);
  assert.equal(
    pezzi.highlights[2],
    "889: The Eiffel Tower is completed, almost two months ahead of schedule. _ May 6, 1889: The",
  );
  assert.deepEqual(hits[1].highlights, [], "a hit without highlights is still a hit");
  assert.equal(hits[4].year, 1925, "year falls back to date");
});

test("publicDomainGate: open, old texts only", () => {
  const gate = (year: number | null, collections: string[] = [], mediatype = "texts") =>
    publicDomainGate({ year, collections, mediatype }, 1930);
  assert.deepEqual(gate(1889), { ok: true });
  assert.deepEqual(gate(1930), { ok: true });
  assert.deepEqual(gate(1931), { ok: false, reason: "published after 1930" });
  assert.deepEqual(gate(null), { ok: false, reason: "no publication year" });
  assert.deepEqual(gate(1889, ["americana", "inlibrary"]), { ok: false, reason: "lending library" });
  assert.deepEqual(gate(1889, [], "movies"), { ok: false, reason: "not a text" });
});

const PASSAGE =
  "The Eiffel Tower, finished in 1889 for the Exposition, rises 300 metres above the " +
  "Champ de Mars; Gustave Eiffel directed its construction throughout.";

test("scorePassage: a passage with the claim's numbers scores well", () => {
  const ctx = scoringContext(CLAIM_TEXT, TITLE);
  const s = scorePassage(PASSAGE, ctx, false);
  assert.ok(s && s.score > 0.6, `expected a strong match, got ${s?.score}`);
  assert.ok(s!.matched.includes("1889") && s!.matched.includes("300"));
});

test("scorePassage gates: no number, no subject, or a fragment scores nothing", () => {
  const ctx = scoringContext(CLAIM_TEXT, TITLE);
  const noNumbers = PASSAGE.replace("1889", "that year").replace("300", "three hundred");
  assert.equal(scorePassage(noNumbers, ctx, false), null);

  const noSubject = "Finished in 1889 for the Exposition, it rises 300 metres above the Champ de Mars.";
  assert.equal(scorePassage(noSubject, ctx, false), null);
  // ... but a book titled for the subject need not repeat it in every passage.
  assert.ok(scorePassage(noSubject, ctx, true));

  assert.equal(scorePassage("the Eiffel Tower 1889 300", ctx, true), null);
});

test("editionKey collapses scans of the same work, subtitle or not", () => {
  assert.equal(
    editionKey("The Eiffel tower : a description of the monument"),
    editionKey("The Eiffel Tower."),
  );
  assert.notEqual(editionKey("The Eiffel Tower"), editionKey("Guide to Paris"));
});

test("rankArchiveHits: gate, per-passage scoring, one book per work", () => {
  const r = rankArchiveHits(parseSearchHits(SEARCH, "q"), CLAIM_TEXT, TITLE, 1930, 0.3);
  assert.deepEqual(r.rejected, { "lending library": 2, "no publication year": 1 });
  assert.equal(r.publicDomain, 6);
  // The statistical annual mentions 1889 but neither the tower nor, in its
  // title, anything about it.
  assert.ok(!r.ranked.some((s) => s.hit.identifier === "annuaire1912"));
  // Two scans of Tissandier collapse into the better one.
  assert.deepEqual(
    r.ranked.map((s) => s.hit.identifier).sort(),
    ["eiffeltowerdescr00tiss", "guidetoparis1925"],
  );
  const guide = r.ranked.find((s) => s.hit.identifier === "guidetoparis1925")!;
  assert.equal(guide.passages.length, 1, "the 15-character fragment is not a passage");
});

test("a periodical's own year is its masthead, not evidence", () => {
  const hits = parseSearchHits(SEARCH, "q");
  const periodicals = hits.filter((h) => h.collections.includes("periodicals"));
  assert.equal(periodicals.length, 2);
  // "JULY 19, 1889 ... Electricity on the Eiffel Tower, 702, 703" — an index
  // line under a dateline — scored 0.85 for this claim before the rule.
  const r = rankArchiveHits(hits, "The tower opened to visitors in 1889.", TITLE, 1930, 0.3);
  assert.ok(!r.ranked.some((s) => s.hit.collections.includes("periodicals")));

  const ctx = scoringContext("The tower opened to visitors in 1889.", TITLE);
  const line = periodicals[0].highlights[0];
  assert.ok(scorePassage(line, ctx, false)!.score > 0.8, "without the rule it would lead");
  assert.equal(scorePassage(line, ctx, false, "1889"), null);
  // A different year in an 1889 issue still counts.
  assert.ok(scorePassage("The Eiffel Tower will be finished in 1890, its engineers say.", 
    scoringContext("The tower was finished in 1890.", TITLE), false, "1889"));
});

test("formatArchiveCitation: cite book, life dates stripped, pipes escaped", () => {
  assert.equal(
    formatArchiveCitation(
      { identifier: "towerbook", title: "The Tower | A History", creator: "Smith, John, 1850-1920", year: 1889 },
      "Hachette",
    ).template,
    "{{cite book |title=The Tower {{!}} A History |author=Smith, John |publisher=Hachette " +
      "|year=1889 |url=https://archive.org/details/towerbook |via=Internet Archive}}",
  );
});

test("viewerUrl opens the book on the claim's strongest anchor", () => {
  assert.equal(
    viewerUrl("towerbook", claimTerms(CLAIM_TEXT, TITLE)),
    "https://archive.org/details/towerbook?q=1889",
  );
});

// --- the funnel, end to end ---------------------------------------------------

function fakeClient(
  responses: (SearchResponse | Error)[],
  metadata: Record<string, MetadataResponse> = {},
) {
  const searches: SearchRequest[] = [];
  const lookups: string[] = [];
  let n = 0;
  const client: ArchiveClient = {
    async fullTextSearch(request) {
      searches.push(request);
      const r = responses[n++] ?? { response: { body: { hits: { hits: [] } } } };
      if (r instanceof Error) throw r;
      return r;
    },
    async metadata(id) {
      lookups.push(id);
      if (!metadata[id]) throw new Error("404");
      return metadata[id];
    },
  };
  return { client, searches, lookups };
}

test("findArchiveCandidates: the whole funnel, with counts", async () => {
  const { client, searches, lookups } = fakeClient([SEARCH], {
    eiffeltowerdescr00tiss: { metadata: { publisher: "Paris : Masson" } },
    guidetoparis1925: { metadata: { "access-restricted-item": "true" } },
  });
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, {
    client,
    cutoffYear: 1930,
    enoughHits: 5,
  });

  assert.equal(r.funnel.queries.length, 1, "nine books was enough");
  assert.ok(searches[0].query.endsWith(" AND year:[1450 TO 1930]"));
  assert.equal(r.funnel.queries[0], '"Eiffel Tower" AND "1889" AND "300" AND "gustave eiffel"');
  assert.equal(r.funnel.filter, "search");
  assert.equal(r.funnel.hits, 9);
  assert.equal(r.funnel.publicDomain, 6);
  // Metadata only for the shortlist, not for every hit.
  assert.deepEqual(lookups.sort(), ["eiffeltowerdescr00tiss", "guidetoparis1925"]);
  assert.equal(r.funnel.rejected["access restricted"], 1);

  assert.equal(r.candidates.length, 1);
  const [c] = r.candidates;
  assert.equal(c.evidence.identifier, "eiffeltowerdescr00tiss");
  assert.equal(c.url, "https://archive.org/details/eiffeltowerdescr00tiss");
  assert.equal(c.evidence.viewerUrl, "https://archive.org/details/eiffeltowerdescr00tiss?q=1889");
  assert.ok(c.evidence.passages[0].includes("rises 300 metres"));
  assert.equal(
    c.relevance,
    "Internet Archive, 1889, Tissandier, Gaston — matched 1889, 300, gustave eiffel",
    "a matched name is listed once, not also as its parts",
  );
  assert.ok(c.citation.ref.includes("|publisher=Paris : Masson"));
  assert.ok(c.citation.ref.includes("|author=Tissandier, Gaston |"));
});

test("findArchiveCandidates drops the filter if the search rejects it, and loosens the query", async () => {
  const { client, searches } = fakeClient([new Error("400 Bad Request")]);
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client, cutoffYear: 1930 });
  assert.equal(r.funnel.filter, "gate only");
  assert.deepEqual(
    searches.map((s) => s.query.includes("year:[")),
    [true, false, false, false],
    "retried unfiltered, then kept loosening while short of books",
  );
  assert.equal(r.funnel.queries.length, 3);
});

test("findArchiveCandidates keeps a lead whose metadata lookup fails, without a publisher", async () => {
  const { client } = fakeClient([SEARCH]);
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client, cutoffYear: 1930, enoughHits: 5 });
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every((c) => !c.citation.ref.includes("publisher=")));
  assert.equal(r.funnel.errors.length, 2);
});

test("findArchiveCandidates makes no request for a claim with nothing to search for", async () => {
  const { client, searches } = fakeClient([]);
  const r = await findArchiveCandidates(claimOf("It was very popular with visitors."), TITLE, { client });
  assert.equal(r.candidates.length, 0);
  assert.equal(searches.length, 0);
});

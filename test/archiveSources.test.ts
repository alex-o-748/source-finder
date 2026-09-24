import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  accessGate,
  buildArchiveQueries,
  claimTerms,
  detailsGate,
  editionKey,
  findArchiveCandidates,
  formatArchiveCitation,
  parseSearchHits,
  rankArchiveHits,
  sameWork,
  scorePassage,
  scoringContext,
  viewerUrl,
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

test("searchParams: the full-text backend on archive.org", () => {
  const p = searchParams({ query: "q", size: 50 });
  assert.equal(p.get("service_backend"), "fts");
  assert.equal(p.get("user_query"), "q");
  assert.equal(p.get("hits_per_page"), "50");
});

test("parseSearchHits reads the recorded shape and strips highlight markers", () => {
  const hits = parseSearchHits(SEARCH, "q");
  assert.equal(hits.length, 10);
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

test("accessGate: open books and lending-library books, not print-disabled-only ones", () => {
  const gate = (collections: string[], mediatype = "texts") => accessGate({ collections, mediatype });
  assert.deepEqual(gate(["americana"]), { ok: true, access: "open" });
  assert.deepEqual(gate([]), { ok: true, access: "open" });
  assert.deepEqual(gate(["internetarchivebooks", "inlibrary"]), { ok: true, access: "borrow" });
  // Lending-library books are usually in printdisabled as well.
  assert.deepEqual(gate(["printdisabled", "inlibrary"]), { ok: true, access: "borrow" });
  assert.deepEqual(gate(["printdisabled", "internetarchivebooks"]), {
    ok: false,
    reason: "print-disabled readers only",
  });
  assert.deepEqual(gate(["americana"], "movies"), { ok: false, reason: "not a text" });
});

test("detailsGate: every lending book is flagged restricted; only other restricted ones are unreadable", () => {
  const details = (restricted: boolean, dark = false) =>
    ({ publisher: null, isbn: null, restricted, dark });
  assert.deepEqual(detailsGate(details(true), "borrow"), { ok: true });
  assert.deepEqual(detailsGate(details(true), "open"), { ok: false, reason: "access restricted" });
  assert.deepEqual(detailsGate(details(false, true), "open"), { ok: false, reason: "withdrawn" });
  assert.deepEqual(detailsGate(details(false), "open"), { ok: true });
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

test("sameWork: same title and a shared creator name — a different author is a different work", () => {
  const tiss1889 = { title: "The Eiffel tower : a description", creator: "Tissandier, Gaston, 1843-1899" };
  assert.ok(sameWork(tiss1889, { title: "The Eiffel Tower.", creator: "Tissandier, Gaston" }));
  assert.ok(sameWork(tiss1889, { title: "The Eiffel Tower.", creator: null }));
  assert.ok(!sameWork(tiss1889, { title: "Eiffel Tower", creator: "Pezzi, Bryan" }));
  assert.ok(!sameWork(tiss1889, { title: "Guide to Paris", creator: "Tissandier, Gaston" }));
});

test("rankArchiveHits: gate, per-passage scoring, one book per work", () => {
  const r = rankArchiveHits(parseSearchHits(SEARCH, "q"), CLAIM_TEXT, TITLE, 0.3);
  assert.deepEqual(r.rejected, { "print-disabled readers only": 1 });
  assert.equal(r.available, 9);
  assert.equal(r.borrowable, 2);
  assert.equal(r.matched, 5);
  // The statistical annual mentions 1889 but neither the tower nor, in its
  // title, anything about it.
  assert.ok(!r.ranked.some((s) => s.hit.identifier === "annuaire1912"));
  // Best first; the 1890 Tissandier scan collapses into the 1889 one, but
  // Pezzi's book of the same title is a different work.
  assert.deepEqual(
    r.ranked.map((s) => [s.hit.identifier, s.access]),
    [
      ["eiffeltowerdescr00tiss", "open"],
      ["guidetoparis1925", "open"],
      ["undatedpamphlet", "open"],
      ["eiffeltower0000pezz", "borrow"],
    ],
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
  const r = rankArchiveHits(hits, "The tower opened to visitors in 1889.", TITLE, 0.3);
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
      "open",
      { publisher: "Hachette", isbn: null },
    ).template,
    "{{cite book |title=The Tower {{!}} A History |author=Smith, John |publisher=Hachette " +
      "|year=1889 |url=https://archive.org/details/towerbook |via=Internet Archive}}",
  );
});

test("formatArchiveCitation: a borrowable book gets its ISBN and url-access=registration", () => {
  assert.equal(
    formatArchiveCitation(
      { identifier: "eiffeltower0000pezz", title: "Eiffel Tower", creator: "Pezzi, Bryan", year: 2008 },
      "borrow",
      { publisher: "Weigl", isbn: "9781590367254" },
    ).template,
    "{{cite book |title=Eiffel Tower |author=Pezzi, Bryan |publisher=Weigl |year=2008 " +
      "|isbn=9781590367254 |url=https://archive.org/details/eiffeltower0000pezz " +
      "|url-access=registration |via=Internet Archive}}",
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
    // Restricted, and not a lending-library book: nobody can read it.
    guidetoparis1925: { metadata: { "access-restricted-item": "true" } },
    // Restricted like every lending-library book, and borrowable.
    eiffeltower0000pezz: {
      metadata: { publisher: "Weigl", isbn: ["9781590367254"], "access-restricted-item": "true" },
    },
  });
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client, enoughHits: 5 });

  assert.equal(r.funnel.queries.length, 1, "ten books was enough");
  assert.equal(searches[0].query, '"Eiffel Tower" AND "1889" AND "300" AND "gustave eiffel"');
  assert.equal(r.funnel.hits, 10);
  assert.equal(r.funnel.available, 9);
  assert.equal(r.funnel.borrowable, 2);
  assert.equal(r.funnel.matched, 5);
  // Metadata only for the shortlist, not for every hit.
  assert.deepEqual(lookups, [
    "eiffeltowerdescr00tiss",
    "guidetoparis1925",
    "undatedpamphlet",
    "eiffeltower0000pezz",
  ]);
  assert.equal(r.funnel.rejected["access restricted"], 1);
  assert.equal(r.funnel.errors.length, 1, "the pamphlet's metadata is missing");

  assert.deepEqual(
    r.candidates.map((c) => [c.evidence.identifier, c.evidence.access]),
    [
      ["eiffeltowerdescr00tiss", "open"],
      ["undatedpamphlet", "open"],
      ["eiffeltower0000pezz", "borrow"],
    ],
  );
  const pezzi = r.candidates[2];
  assert.ok(pezzi.relevance.startsWith("Internet Archive (borrow), 2008, Pezzi, Bryan — matched"));
  assert.ok(pezzi.citation.ref.includes("|isbn=9781590367254 |"));
  assert.ok(pezzi.citation.ref.includes("|url-access=registration |"));
  assert.equal(r.candidates[1].evidence.year, null, "an undated book is still a lead");

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

test("findArchiveCandidates reports a failed search and keeps loosening the query", async () => {
  const { client, searches } = fakeClient([new Error("HTTP 503")]);
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client });
  assert.equal(searches.length, 3, "kept loosening while short of books");
  assert.deepEqual(r.funnel.errors, ["search failed: HTTP 503"]);
  assert.equal(r.candidates.length, 0);
});

test("findArchiveCandidates keeps a lead whose metadata lookup fails, without a publisher", async () => {
  const { client } = fakeClient([SEARCH]);
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client, enoughHits: 5 });
  assert.equal(r.candidates.length, 3);
  assert.ok(r.candidates.every((c) => !c.citation.ref.includes("publisher=")));
  assert.equal(r.funnel.errors.length, 3);
});

test("findArchiveCandidates makes no request for a claim with nothing to search for", async () => {
  const { client, searches } = fakeClient([]);
  const r = await findArchiveCandidates(claimOf("It was very popular with visitors."), TITLE, { client });
  assert.equal(r.candidates.length, 0);
  assert.equal(searches.length, 0);
});

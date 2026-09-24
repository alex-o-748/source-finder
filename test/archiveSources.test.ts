import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bestWindows,
  buildArchiveQueries,
  claimTerms,
  editionKey,
  findArchiveCandidates,
  formatArchiveCitation,
  parseFtsHits,
  parseInsideMatches,
  parseMetadata,
  publicDomainCutoff,
  publicDomainFilter,
  publicDomainGate,
  scorePassage,
  scoringContext,
} from "../src/core/archiveSources.js";
import type {
  ArchiveClient,
  FtsResponse,
  InsideResponse,
  MetadataResponse,
} from "../src/core/internetArchive.js";
import type { Claim } from "../src/core/types.js";

// Response shapes here are synthetic: modelled on what the `internetarchive`
// package and BookReader read (`hits.hits[].fields.identifier`, `matches[].text`
// with `{{{…}}}` markers, `par[].page`). Replace with recorded ones from
// `cnfirmed archive --record` once the live endpoints have been checked.

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
    "Eiffel Tower (Paris)",
  );
  assert.equal(t.subject, "Eiffel Tower");
  assert.deepEqual(t.numbers, ["1921", "616,093"]);
  assert.deepEqual(t.names, ["anna berg"]);
});

test("buildArchiveQueries: strictest first, and nothing for a claim with no anchors", () => {
  const t = claimTerms(CLAIM_TEXT, TITLE);
  const qs = buildArchiveQueries(t, null);
  assert.deepEqual(qs, [
    '"Eiffel Tower" AND "1889" AND "300" AND "gustave eiffel"',
    '"Eiffel Tower" AND "1889" AND "300"',
    '"Eiffel Tower" AND "1889"',
  ]);
  const filtered = buildArchiveQueries(t, publicDomainFilter(1930));
  assert.ok(filtered[0].startsWith('("Eiffel Tower" AND'));
  assert.ok(filtered[0].includes("year:[* TO 1930]"));
  assert.ok(filtered[0].includes("NOT collection:(inlibrary"));

  assert.deepEqual(
    buildArchiveQueries(claimTerms("it was very tall and quite famous", TITLE), null),
    [],
  );
});

test("parseFtsHits reads fields arrays, _source and _id, and strips highlight markup", () => {
  const hits = parseFtsHits(
    {
      hits: {
        hits: [
          {
            fields: { identifier: ["towerbook"], title: ["The Tower"], year: ["1889"] },
            highlight: { text: ["the <em>tower</em> of 300 metres"] },
          },
          { _source: { identifier: "other", date: "1901-05-01" } },
          { _id: "bare" },
          { nothing: true },
        ],
      },
    },
    "q",
  );
  assert.deepEqual(
    hits.map((h) => [h.identifier, h.title, h.year]),
    [
      ["towerbook", "The Tower", 1889],
      ["other", null, 1901],
      ["bare", null, null],
    ],
  );
  assert.deepEqual(hits[0].highlights, ["the tower of 300 metres"]);
});

test("parseInsideMatches strips markers and keeps the page", () => {
  const ps = parseInsideMatches({
    matches: [{ text: "rose to {{{300}}} metres", par: [{ page: 42 }] }, { text: "" }],
  });
  assert.deepEqual(ps, [{ text: "rose to 300 metres", leaf: 42, from: "search-inside" }]);
});

function meta(md: Record<string, unknown>, extra: Partial<MetadataResponse> = {}): MetadataResponse {
  return { metadata: { mediatype: "texts", ...md }, ...extra };
}

test("publicDomainGate: open, old texts only", () => {
  const gate = (md: Record<string, unknown>, extra?: Partial<MetadataResponse>) =>
    publicDomainGate(parseMetadata("x", meta(md, extra)), 1930);
  assert.deepEqual(gate({ year: "1889" }), { ok: true });
  assert.deepEqual(gate({ date: "1930" }), { ok: true });
  assert.deepEqual(gate({ year: "1889", "possible-copyright-status": "NOT_IN_COPYRIGHT" }), { ok: true });
  assert.deepEqual(gate({ year: "1931" }), { ok: false, reason: "published after 1930" });
  assert.deepEqual(gate({}), { ok: false, reason: "no publication year" });
  assert.deepEqual(gate({ year: "1889", "access-restricted-item": "true" }), {
    ok: false,
    reason: "access restricted",
  });
  assert.deepEqual(gate({ year: "1889", collection: ["americana", "inlibrary"] }), {
    ok: false,
    reason: "lending library",
  });
  assert.deepEqual(gate({ year: "1889", mediatype: "movies" }), { ok: false, reason: "not a text" });
  assert.deepEqual(gate({ year: "1889" }, { is_dark: true }), { ok: false, reason: "access restricted" });
});

test("parseMetadata prefers the item's own _djvu.txt", () => {
  const item = parseMetadata("book", {
    metadata: { title: ["Book"], creator: "Smith, John, 1850-1920" },
    files: [{ name: "extra_djvu.txt" }, { name: "book_djvu.txt" }, { name: "book.pdf" }],
    server: "ia800.us.archive.org",
    dir: "/1/items/book",
  });
  assert.equal(item.textFile, "book_djvu.txt");
  assert.equal(item.server, "ia800.us.archive.org");
  assert.equal(item.title, "Book");
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

  const noSubject =
    "Finished in 1889 for the Exposition, it rises 300 metres above the Champ de Mars, " +
    "the work directed throughout by its engineer.";
  assert.equal(scorePassage(noSubject, ctx, false), null);
  // ... but a book titled for the subject need not repeat it on every page.
  assert.ok(scorePassage(noSubject, ctx, true));

  assert.equal(scorePassage("Eiffel Tower 1889 300", ctx, true), null);
});

test("bestWindows finds the passage in a long OCR text, grouped figures included", () => {
  const filler = "Nothing of note happened in this chapter at all. ".repeat(400);
  const claim = "In 1921 the city of Fyrland had 616,093 inhabitants.";
  const text =
    filler +
    "By the census of 1921 the population of Fyrland stood at 616,093 souls, a record. " +
    filler;
  const terms = claimTerms(claim, "Fyrland");
  const ctx = scoringContext(claim, terms.subject);
  const [best] = bestWindows(text, terms, ctx, false);
  assert.ok(best, "expected a window");
  assert.ok(best.text.includes("616,093"));
  assert.equal(best.from, "plain-text");
});

test("editionKey collapses scans of the same work", () => {
  assert.equal(editionKey("The Eiffel Tower."), editionKey("Eiffel tower"));
  assert.notEqual(editionKey("The Eiffel Tower"), editionKey("Paris guide"));
});

test("formatArchiveCitation: cite book, life dates stripped, page link", () => {
  const item = parseMetadata("towerbook", {
    metadata: {
      title: "The Tower | A History",
      creator: "Smith, John, 1850-1920",
      publisher: "Hachette",
      year: "1889",
    },
  });
  assert.equal(
    formatArchiveCitation(item, 42).template,
    "{{cite book |title=The Tower {{!}} A History |author=Smith, John |publisher=Hachette " +
      "|year=1889 |url=https://archive.org/details/towerbook/page/n42 |via=Internet Archive}}",
  );
  assert.ok(!formatArchiveCitation(item, null).template.includes("/page/"));
});

// --- the funnel, end to end ---------------------------------------------------

interface FakeBook {
  meta: MetadataResponse;
  inside?: InsideResponse;
  text?: string;
}

function fakeClient(hits: FtsResponse[], books: Record<string, FakeBook>) {
  const calls: string[] = [];
  let search = 0;
  const client: ArchiveClient = {
    async fullTextSearch(query) {
      calls.push(`fts ${query}`);
      return hits[search++] ?? { hits: { hits: [] } };
    },
    async metadata(id) {
      calls.push(`metadata ${id}`);
      if (!books[id]) throw new Error("404");
      return books[id].meta;
    },
    async searchInside(id) {
      calls.push(`inside ${id}`);
      return books[id].inside ?? { matches: [] };
    },
    async plainText(id) {
      calls.push(`text ${id}`);
      return books[id].text ?? "";
    },
  };
  return { client, calls };
}

function hit(id: string, title: string, highlight?: string): unknown {
  return {
    fields: { identifier: [id], title: [title] },
    ...(highlight ? { highlight: { text: [highlight] } } : {}),
  };
}

test("findArchiveCandidates: the whole funnel, with counts", async () => {
  const { client, calls } = fakeClient(
    [
      {
        hits: {
          hits: [
            hit("guide1925", "Guide to Paris", undefined),
            hit("tower1889", "The Eiffel Tower", PASSAGE),
            hit("tower1890", "Eiffel tower.", PASSAGE.replace("Gustave Eiffel", "its engineer")),
            hit("modern", "The Eiffel Tower Today"),
            hit("lent", "Eiffel's Paris"),
            hit("gone", "Missing"),
          ],
        },
      },
    ],
    {
      guide1925: {
        meta: meta(
          { title: "Guide to Paris", year: "1925" },
          { server: "ia1.us.archive.org", dir: "/1/items/guide1925", files: [{ name: "guide1925_djvu.txt" }] },
        ),
        inside: {
          matches: [
            {
              text:
                "Of the monuments of the city the Eiffel Tower, erected in {{{1889}}}, is " +
                "the highest at 300 metres, the work of Gustave Eiffel and his engineers.",
              par: [{ page: 117 }],
            },
          ],
        },
      },
      tower1889: { meta: meta({ title: "The Eiffel Tower", year: "1889", creator: "Tissandier, Gaston" }) },
      tower1890: { meta: meta({ title: "Eiffel tower.", year: "1890" }) },
      modern: { meta: meta({ title: "The Eiffel Tower Today", year: "1985" }) },
      lent: { meta: meta({ title: "Eiffel's Paris", year: "1910", collection: "inlibrary" }) },
    },
  );

  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, {
    client,
    cutoffYear: 1930,
    enoughHits: 5,
  });

  // One query was enough: six books came back.
  assert.equal(r.funnel.queries.length, 1);
  assert.equal(r.funnel.hits, 6);
  assert.equal(r.funnel.lookedUp, 6);
  assert.equal(r.funnel.publicDomain, 3);
  assert.deepEqual(r.funnel.rejected, { "published after 1930": 1, "lending library": 1 });
  assert.equal(r.funnel.errors.length, 1, "the missing item is an error, not a crash");
  assert.equal(r.funnel.matched, 3);

  // Two scans of "The Eiffel Tower" collapse to the better one.
  assert.equal(r.funnel.candidates, 2);
  assert.deepEqual(
    r.candidates.map((c) => c.evidence.identifier).sort(),
    ["guide1925", "tower1889"],
  );

  const guide = r.candidates.find((c) => c.evidence.identifier === "guide1925")!;
  assert.equal(guide.evidence.passageFrom, "search-inside");
  assert.equal(guide.url, "https://archive.org/details/guide1925/page/n117");
  assert.equal(guide.evidence.year, 1925);

  const tower = r.candidates.find((c) => c.evidence.identifier === "tower1889")!;
  assert.equal(tower.evidence.passageFrom, "search-hit");
  assert.ok(tower.relevance.startsWith("Internet Archive, 1889, Tissandier, Gaston — matched"));
  assert.ok(tower.citation.ref.startsWith("<ref>{{cite book |title=The Eiffel Tower"));

  // A book whose search hit already carried a good passage costs no more calls.
  assert.ok(!calls.includes("inside tower1889"));
  assert.ok(!calls.some((c) => c.startsWith("text ")));
});

test("findArchiveCandidates falls back to the OCR text, and loosens the query", async () => {
  const filler = "Nothing of note happened here. ".repeat(300);
  const { client, calls } = fakeClient(
    [{ hits: { hits: [] } }, { hits: { hits: [hit("tower1889", "The Eiffel Tower")] } }],
    {
      tower1889: {
        meta: meta(
          { title: "The Eiffel Tower", year: "1889" },
          { files: [{ name: "tower1889_djvu.txt" }] },
        ),
        text: filler + PASSAGE + filler,
      },
    },
  );
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client, cutoffYear: 1930 });
  assert.equal(r.funnel.queries.length, 3, "kept loosening while short of books");
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].evidence.passageFrom, "plain-text");
  assert.ok(r.candidates[0].evidence.passage.includes("300 metres"));
  assert.ok(calls.includes("text tower1889"));
});

test("findArchiveCandidates: a failed search is reported, not thrown", async () => {
  const client: ArchiveClient = {
    fullTextSearch: async () => {
      throw new Error("503");
    },
    metadata: async () => ({}),
    searchInside: async () => ({}),
    plainText: async () => "",
  };
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.funnel.errors.length, 3);
});

test("findArchiveCandidates makes no request for a claim with nothing to search for", async () => {
  const { client, calls } = fakeClient([], {});
  const r = await findArchiveCandidates(claimOf("It was very popular with visitors."), TITLE, { client });
  assert.equal(r.candidates.length, 0);
  assert.deepEqual(calls, []);
});

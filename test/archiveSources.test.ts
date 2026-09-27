import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  accessGate,
  bestWindow,
  buildArchiveQueries,
  buildPhraseQueries,
  keyPhrases,
  mergeRankings,
  rankByUnits,
  streamText,
  claimTerms,
  detailsGate,
  editionKey,
  findArchiveCandidates,
  passageSummary,
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
    '"Eiffel Tower" "1889" "300" "gustave eiffel"',
    '"Eiffel Tower" "1889" "300"',
    '"Eiffel Tower" "1889"',
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

test("rankArchiveHits counts why passages were dropped", () => {
  const claim = "In 1861, the number of inhabitants surpassed 100,000 and by 1927, had doubled.";
  const hit = {
    identifier: "citybook",
    title: "Travels in Italy",
    creator: null,
    year: 1900,
    mediatype: "texts",
    collections: ["americana"],
    highlights: [
      "Bologna 1861",
      "Finished in 1861, it was the largest hall in the whole province of Emilia.",
      "Bologna had a garrison of 45,000 men quartered in the old convents.",
      "The census of 1861 gave Bologna a population of 109,395 souls, all told.",
      "Bologna in 1861 already had over 100,000 inhabitants within its walls.",
    ],
    rank: 0,
    query: "q",
  };
  // With one year and the subject, the census passage scores 0.3 — a pass at
  // the default threshold, so a stricter one here to see it fall short.
  assert.equal(rankArchiveHits([hit], claim, "Bologna", 0.3).ranked[0].passages.length, 2);
  const r = rankArchiveHits([hit], claim, "Bologna", 0.5);
  assert.equal(r.matched, 1);
  assert.equal(r.passages.seen, 5);
  assert.deepEqual(r.passages.dropped, {
    "too short": 1,
    "no subject": 1,
    "no claim number": 1,
    "below threshold": 1,
  });
  assert.equal(r.passages.bestBelow?.identifier, "citybook");
  assert.match(r.passages.bestBelow!.text, /109,395/);
  assert.match(passageSummary(r.passages), /^5 passage\(s\) → dropped: 1 too short, .* \(best below: 0\.\d+ in citybook: "The census/);
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

/** The number-and-name queries alone, as the stage ran before key phrases. */
const ANCHORS_ONLY = (client: ArchiveClient) => ({ client, enoughHits: 5, maxPhraseQueries: 0, maxCandidates: 3 });

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
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, ANCHORS_ONLY(client));

  assert.equal(r.funnel.queries.length, 1, "ten books was enough");
  assert.equal(searches[0].query, '"Eiffel Tower" "1889" "300" "gustave eiffel"');
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
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, { client, maxPhraseQueries: 0 });
  assert.equal(searches.length, 3, "kept loosening while short of books");
  assert.deepEqual(r.funnel.errors, ["search failed: HTTP 503"]);
  assert.equal(r.candidates.length, 0);
});

test("findArchiveCandidates keeps a lead whose metadata lookup fails, without a publisher", async () => {
  const { client } = fakeClient([SEARCH]);
  const r = await findArchiveCandidates(claimOf(CLAIM_TEXT), TITLE, ANCHORS_ONLY(client));
  assert.equal(r.candidates.length, 3);
  assert.ok(r.candidates.every((c) => !c.citation.ref.includes("publisher=")));
  assert.equal(r.funnel.errors.length, 3);
});

test("findArchiveCandidates makes no request for a claim with nothing to search for", async () => {
  const { client, searches } = fakeClient([]);
  const r = await findArchiveCandidates(claimOf("It was one of them."), TITLE, { client });
  assert.equal(r.candidates.length, 0);
  assert.equal(searches.length, 0);
});

// --- key phrases, the unit ranking, and whole texts ---------------------------

test("keyPhrases: noun groups, a possessive ends its run, verbs break it", () => {
  assert.deepEqual(keyPhrases("Feodora's father died in 1814.", "Princess Feodora of Leiningen"), [
    "1814",
    "father died",
  ]);
  assert.deepEqual(
    keyPhrases(
      "The otter civet possesses webbed feet, which is an adaptation to its aquatic habitat.",
      "Otter civet",
    ),
    ["aquatic habitat", "webbed feet", "adaptation"],
    "'otter civet' is only the subject; 'possesses' breaks the run",
  );
  assert.equal(
    keyPhrases("The Greek name was chosen by Ptolemy II Philadelphus, who named it.", "Khirbet Kerak")[0],
    "Ptolemy II Philadelphus",
    "a run of capitalised words is a name, kept whole",
  );
  assert.deepEqual(keyPhrases("It was one of them.", TITLE), []);
});

test("buildPhraseQueries: the subject's words with phrases, strictest first, then phrases alone", () => {
  assert.deepEqual(buildPhraseQueries(claimTerms("The acini secrete digestive enzymes.", "Endocrine system")), [
    '"Endocrine" "system" "secrete digestive" "digestive enzymes" "acini secrete"',
    '"Endocrine" "system" "secrete digestive" "digestive enzymes"',
    '"Endocrine" "system" "secrete digestive"',
    '"secrete digestive" "digestive enzymes"',
  ]);
  assert.deepEqual(buildArchiveQueries(claimTerms("The acini secrete digestive enzymes.", "Endocrine system")), [],
    "no number or name: only the phrase queries");
});

test("rankByUnits: two claim units in a passage, one strong, and a mention of the subject", () => {
  const hit = (identifier: string, highlights: string[], title = identifier) => ({
    identifier, title, creator: null, year: null, mediatype: "texts",
    collections: [], file: null, highlights, rank: 0, query: "q",
  });
  const claim = "Feodora's father died in 1814.";
  const title = "Princess Feodora of Leiningen";
  const ranked = rankByUnits(
    [
      hit("almanac", ["Princess Marie Antonia (b 19 Dec 1814; m 7 June 1833)"]),
      hit("prince", ["her mother was left a widow when the Prince of Leiningen, her father, died in 1814"]),
      hit("words", ["his father died young"]),
      // The same two units, in a book that is not about her and a passage that does not name her.
      hit("stranger", ["the young girl, whose father died in 1814, lived with her brother"]),
      // …and in a book whose title is about her.
      hit("memoir", ["the young girl, whose father died in 1814, lived with her brother"],
        "Feodora, Princess of Leiningen: a memoir"),
    ],
    claim,
    title,
  );
  assert.deepEqual(ranked.map((s) => s.hit.identifier), ["prince", "memoir"]);
  assert.deepEqual(ranked[0].passages[0].matched, ["1814", "father"]);
  assert.deepEqual(ranked[1].passages[0].matched, ["father died", "1814"]);
});

test("rankByUnits: two phrases of the claim in a book that never names its subject are not a lead", () => {
  const hit = (identifier: string, title: string, highlights: string[]) => ({
    identifier, title, creator: null, year: null, mediatype: "texts",
    collections: [], file: null, highlights, rank: 0, query: "q",
  });
  // The claim and the two books behind the leads in the user's screenshot.
  const claim =
    "Gothic details even began to appear in working-class housing schemes subsidised by philanthropy, " +
    "though given the expense, less frequently than in the design of upper and middle-class housing.";
  const ranked = rankByUnits(
    [
      hit("history", "The history of working-class housing", [
        "phenomenal price in 144 Working-class Housing in Nottingham those days. Middle-class housing also began to be",
      ]),
      hit("reform", "The movement for housing reform in Germany and France, 1840-1914", [
        "design of working-class housing The early development of the design of working-class housing in England",
      ]),
      hit("revival", "The Gothic revival", [
        "Gothic details appeared even in working-class housing, where philanthropy paid for them",
      ]),
    ],
    claim,
    "Gothic Revival architecture",
  );
  assert.deepEqual(ranked.map((s) => s.hit.identifier), ["revival"]);
});

test("mergeRankings takes the two rankings in turn, one book per work", () => {
  const s = (identifier: string) => ({
    hit: { identifier, title: identifier, creator: null, year: null, mediatype: "texts", collections: [], file: null, highlights: [], rank: 0, query: "q" },
    access: "open" as const, passages: [], score: 1,
  });
  assert.deepEqual(
    mergeRankings([s("a"), s("b"), s("c")], [s("x"), s("a"), s("y")]).map((r) => r.hit.identifier),
    ["a", "x", "b", "c", "y"],
  );
});

test("streamText and bestWindow: the passage from a whole book, centred, cut at words", () => {
  const filler = (w: string, n: number) => `${w} `.repeat(n);
  const text = streamText(
    `<html><pre>${filler("filler", 150)}The tower was com-\nplete in 1889, rising 300 metres, ` +
      `the work of Gustave Eiffel &amp; his engineers. ${filler("more", 150)}</pre></html>`,
  )!;
  assert.ok(text.includes("complete in 1889"), "a word broken at a line end is joined");
  assert.ok(text.includes("Eiffel & his"), "entities decoded");
  const w = bestWindow(text, CLAIM_TEXT, TITLE)!;
  assert.deepEqual(w.matched, ["gustave eiffel", "1889", "300", "metres"]);
  const at = w.text.indexOf("The tower was complete");
  assert.ok(at > 100 && at < 250, `centred, not at an edge (at ${at})`);
  assert.ok(w.text.startsWith("…") && w.text.endsWith("…"));
  assert.equal(bestWindow(filler("nothing", 200), CLAIM_TEXT, TITLE), null);
});

test("findArchiveCandidates: phrase queries run beside the anchor ones, and whole texts add a lead", async () => {
  const searches: string[] = [];
  const pages: string[] = [];
  const hit = (identifier: string, text: string, collection: string[] = []) => ({
    fields: { identifier, title: identifier, mediatype: "texts", collection, file_basename: `${identifier}-vol2` },
    highlight: { text: [text] },
  });
  const client: ArchiveClient = {
    async fullTextSearch({ query }) {
      searches.push(query);
      const hits = query.includes("father died")
        ? [hit("queenbook", "the Prince of Leiningen, whose father died in 1814, had two children", ["inlibrary"])]
        : [hit("memoirs", "Leiningen is a German princely house of some note, older than most"), hit("genealogy", "Princess Feodora of Leiningen 1814")];
      return { response: { body: { hits: { hits } } } };
    },
    async metadata() {
      return { metadata: {} };
    },
    async streamPage(identifier, file) {
      pages.push(`${identifier}/${file}`);
      return identifier === "memoirs"
        ? `<pre>${"other matters here. ".repeat(60)}Her father, the Prince of Leiningen, died in 1814 and left Feodora. ${"and so on. ".repeat(60)}</pre>`
        : "<pre>nothing to see</pre>";
    },
  };
  const claim = claimOf("Feodora's father died in 1814.");
  const r = await findArchiveCandidates(claim, "Princess Feodora of Leiningen", { client, fullText: true });

  assert.deepEqual(r.funnel.queries, [
    '"Princess Feodora of Leiningen" "1814"',
    '"Princess" "Feodora" "Leiningen" "1814" "father died"',
    '"Princess" "Feodora" "Leiningen" "1814"',
    '"1814" "father died"',
  ]);
  assert.deepEqual(pages, ["memoirs/memoirs-vol2", "genealogy/genealogy-vol2"], "open books only, the matched volume");
  assert.deepEqual(r.funnel.fullText, { read: 2, windows: 1 });
  const ids = r.candidates.map((c) => c.evidence.identifier);
  assert.ok(ids.includes("queenbook"), "found by its claim phrases alone");
  const memoirs = r.candidates.find((c) => c.evidence.identifier === "memoirs")!;
  assert.ok(memoirs, "a book whose highlights said nothing becomes a lead through its whole text");
  assert.equal(memoirs.evidence.fullText, true);
  assert.ok(memoirs.snippet.includes("died in 1814 and left Feodora"));
});

/**
 * Searching inside open books page by page, through the Worker's
 * /archive/inside: the request, the paragraphs kept as passages, the leads'
 * passages and pages on a stubbed world, and the page a checked quote gives
 * the citation.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { insideTerm, planMatched, specificConcepts, workerChatClient } from "../src/core/archiveLibrarian.js";
import { httpArchiveClient, insideUrl } from "../src/core/internetArchive.js";
import type { InsideResponse } from "../src/core/internetArchive.js";
import {
  PAGE_PASSAGE_CHARS,
  bestStretch,
  citationWithPage,
  claimTerms,
  findArchiveCandidates,
  formatArchiveCitation,
  pagePassages,
  quotePage,
  withQuotePage,
} from "../src/core/archiveSources.js";
import type { ArchiveCandidate } from "../src/core/types.js";
import { CLAIM, PAGE_P1, PAGE_P2, PARAGRAPH, PLAN, worldFetch, type Sent } from "./librarianWorld.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const plan = (t: string): string[] => {
  const f = t.toLowerCase();
  return PLAN.terms.filter((alts) => alts.some((a) => f.includes(a.toLowerCase()))).map((alts) => alts[0].toLowerCase());
};

test("insideUrl: the book, and each term on its own; insideTerm quotes a phrase", () => {
  assert.equal(
    insideUrl("https://w.example/", { identifier: "magazines", doc: "2004/Issue 10 & 11", terms: ["1889", '"300 metres"'] }),
    "https://w.example/archive/inside?id=magazines&doc=2004%2FIssue+10+%26+11&q=1889&q=%22300+metres%22",
  );
  assert.equal(insideUrl("https://w.example", { identifier: "a", doc: null, terms: ["x"] }), "https://w.example/archive/inside?id=a&q=x");
  assert.equal(insideTerm("Prince Charles"), '"Prince Charles"');
  assert.equal(insideTerm("1814"), "1814");
  assert.equal(insideTerm('a/b "c"'), '"a b c"');
});

test("bestStretch: the stretch holding most of the claim, cut at spaces", () => {
  const text = `${"filler words go here ".repeat(30)}On 31 March 1889 Eiffel stood 300 metres up. ${"more filler words ".repeat(30)}`;
  const w = bestStretch(text, plan, 200);
  assert.ok(w.length <= 202, `${w.length}`);
  assert.ok(w.startsWith("…") && w.endsWith("…"));
  assert.ok(w.includes("1889 Eiffel stood 300 metres"), w);
  assert.equal(bestStretch("short", plan, 200), "short");
});

test("pagePassages: most concepts first, two at least, each cut around them; printed pages only when the Archive is sure", () => {
  const long = `${"x ".repeat(500)}The tower was completed in 1889 by Eiffel. ${"y ".repeat(500)}`;
  const r: InsideResponse = {
    id: "b", doc: "b", q: ["1889"], counts: [4], pageConfidence: 90,
    matches: [
      { text: "Eiffel in Paris, 1889.", terms: [0], leaf: 3, page: "iv" },
      { text: "Nothing here about it.", terms: [0], leaf: 4, page: "v" },
      { text: "Paris, 1889.", terms: [0], leaf: 5, page: "vi" },
      { text: long, terms: [0], leaf: 9, page: "3", leafEnd: 10, pageEnd: "4" },
      { text: "Eiffel in Paris, 1889.", terms: [0], leaf: 3, page: "iv" },
    ],
  };
  const p = pagePassages(r, plan);
  assert.deepEqual(p.map((x) => x.matched.length), [3, 2], "one concept is not enough, and a copy goes");
  assert.ok(p[0].text.length <= PAGE_PASSAGE_CHARS + 2 && p[0].text.includes("completed in 1889 by Eiffel"));
  assert.deepEqual(p[0].page, { leaf: 9, page: "3", leafEnd: 10, pageEnd: "4" });
  assert.deepEqual(p[1].page, { leaf: 3, page: "iv" });
  // Unsure of the numbering: the leaf alone.
  assert.deepEqual(pagePassages({ ...r, pageConfidence: 20 }, plan)[0].page, { leaf: 9, page: null, leafEnd: 10, pageEnd: null });
  assert.deepEqual(pagePassages({ ...r, pageConfidence: null }, plan)[1].page, { leaf: 3, page: null });
  const six = Array.from({ length: 6 }, (_, i) => ({ text: `Eiffel completed part ${i} in 1889.`, terms: [0], leaf: i, page: null }));
  assert.equal(pagePassages({ ...r, matches: six }, plan).length, 3);
  // Two paragraphs whose stretches around the claim are the same text are one passage.
  const twice = [r.matches[3], { ...r.matches[3], text: `${r.matches[3].text} trailing words` }];
  assert.equal(pagePassages({ ...r, matches: twice }, plan).length, 1);
});

test("pagePassages: two weak concepts are not enough when the claim has a name to hold", () => {
  const terms = [["Ptolemy II Philadelphus", "Philadelphus"], ["Philoteria"], ["sister"], ["named", "called"]];
  const matched = (t: string) => planMatched(t, terms);
  assert.deepEqual(specificConcepts(terms), ["ptolemy ii philadelphus", "philoteria"]);
  const r: InsideResponse = {
    id: "ocd", doc: "ocd", q: ["sister"], counts: [2], pageConfidence: null,
    matches: [
      { text: "Ada, the sister of Mausolus, was called queen of Caria.", terms: [0], leaf: 1, page: null },
      { text: "Philadelphus founded the town and called it after his sister.", terms: [0], leaf: 2, page: null },
    ],
  };
  assert.deepEqual(pagePassages(r, matched, specificConcepts(terms)).map((p) => p.page!.leaf), [2]);
  assert.deepEqual(pagePassages(r, matched).map((p) => p.page!.leaf), [2, 1], "with no name to hold, two concepts do");
});

test("findArchiveCandidates: every open lead is searched inside page by page, its paragraphs first with their pages", async () => {
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent);
  const r = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { librarian: { client: workerChatClient() } },
  );
  const asked = sent.filter((s) => s.url.includes("/archive/inside?")).map((s) => new URL(s.url).searchParams);
  // The open leads, borrowable ones never, and then two books no lead came
  // from; the shelf's terms, a phrase quoted.
  assert.deepEqual(asked.slice(0, 5).map((p) => p.get("id")).sort(), [
    "eiffeltowerdescr00tiss", "guidetoparis1925", "in.ernet.dli.2015.1234", "tourdetroiscents00eiff", "undatedpamphlet",
  ]);
  assert.deepEqual(asked[0].getAll("q"), ["1889", '"300 metres"', "Eiffel"]);
  assert.ok(asked.every((p) => !p.has("doc")), "no hit here names its book: each item's one book");
  assert.deepEqual(r.funnel.librarian!.pages, { books: 7, beyond: 2, found: 4 });
  assert.deepEqual(r.funnel.errors, [], "a book with no searchable text is no failure");

  const lead = (id: string): ArchiveCandidate => r.candidates.find((c) => c.evidence.identifier === id)!;
  const tour = lead("tourdetroiscents00eiff");
  assert.equal(tour.evidence.passages[0], PAGE_P1);
  assert.deepEqual(tour.evidence.pages![0], { leaf: 57, page: "41" });
  assert.ok(!tour.evidence.passages.includes("Paris: Imprimerie Lemercier, 1889."), "a paragraph with one concept is not kept");
  assert.ok(tour.evidence.passages.includes("The Eiffel tower, completed in 1889, rose 300 metres above the Champ de Mars."), "the planner's highlight stays");
  assert.match(tour.evidence.viewerUrl, /^https:\/\/archive\.org\/details\/tourdetroiscents00eiff\/page\/leaf57\?q=%22/);
  // A dotted identifier the full-text search cannot search inside: its
  // paragraph holds the planner's highlight, which goes; no page numbers.
  const dli = lead("in.ernet.dli.2015.1234");
  assert.deepEqual(dli.evidence.passages, ["The Eiffel Tower, finished in 1889, is 300 metres high, and from its summit all Paris may be seen."]);
  assert.deepEqual(dli.evidence.pages, [{ leaf: 12, page: null }]);
  // The search's own lead keeps its best passage first; its paragraph has
  // fewer of the claim's concepts. The numbering is unsure: the leaf only.
  const tiss = lead("eiffeltowerdescr00tiss");
  assert.match(tiss.evidence.passages[0], /^The Eiffel Tower, finished in 1889 for the Exposition/);
  assert.equal(tiss.evidence.pages![0], null);
  const k = tiss.evidence.passages.findIndex((p) => p.startsWith("The work was begun"));
  assert.deepEqual(tiss.evidence.pages![k], { leaf: 33, page: null });
  // Borrowable and unsearched books carry no pages.
  assert.equal(lead("eiffeltower0000pezz").evidence.pages, undefined);
  assert.equal(lead("guidetoparis1925").evidence.pages, undefined);
});

test("findArchiveCandidates: a book no lead came from is read page by page, and becomes one when a page carries the claim", async () => {
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent);
  const r = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { librarian: { client: workerChatClient() } },
  );
  const asked = sent.filter((s) => s.url.includes("/archive/inside?")).map((s) => new URL(s.url).searchParams.get("id"));
  // Read beyond the leads: the two periodicals whose highlights name the
  // tower; not the cable price list or the yearbook, which only say 1889.
  assert.deepEqual(asked.slice(5), ["sim_engineering_1889_47_index", "sim_scientific-american_1889-05-18_60_20"]);
  const sa = r.candidates.find((c) => c.evidence.identifier === "sim_scientific-american_1889-05-18_60_20")!;
  assert.equal(sa.evidence.via, "pages");
  assert.equal(sa.evidence.passages[0], PAGE_P2);
  assert.deepEqual(sa.evidence.pages![0], { leaf: 14, page: "306" });
  assert.match(sa.evidence.viewerUrl, /\/page\/leaf14\?q=/);
  // A book read with nothing to show stays out.
  assert.ok(!r.candidates.some((c) => c.evidence.identifier === "sim_engineering_1889_47_index"));
  assert.equal(r.funnel.librarian!.added, 4);
});

test("findArchiveCandidates: a failed search inside is noted; a lent or bundled book is not", async () => {
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent, { insideStatus: { undatedpamphlet: 502, guidetoparis1925: 403, eiffeltowerdescr00tiss: 400 } });
  const r = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { librarian: { client: workerChatClient() } },
  );
  assert.deepEqual(r.funnel.errors, ["search inside undatedpamphlet: Internet Archive: HTTP 502"]);
  assert.deepEqual(r.funnel.librarian!.pages, { books: 7, beyond: 2, found: 3 });
});

test("findArchiveCandidates: a client that cannot search inside page by page leaves the books as they were", async () => {
  const sent: Sent[] = [];
  globalThis.fetch = worldFetch(sent);
  const { searchInside: _omit, ...client } = httpArchiveClient;
  void _omit;
  const r = await findArchiveCandidates(
    { claim: CLAIM, context: PARAGRAPH, section: null, offset: 0, tag: "{{cn}}" },
    "Eiffel Tower",
    { client, librarian: { client: workerChatClient() } },
  );
  assert.ok(!sent.some((s) => s.url.includes("/archive/inside")));
  assert.deepEqual(r.funnel.librarian!.pages, { books: 0, beyond: 0, found: 0 });
  assert.ok(r.candidates.every((c) => c.evidence.pages === undefined));
});

test("citationWithPage: |page= before the link, and the link opened at that page", () => {
  const cite = formatArchiveCitation({ identifier: "tour", title: "La tour", creator: "Eiffel, Gustave", year: 1900 }, "open", null);
  assert.equal(
    citationWithPage(cite, { leaf: 57, page: "41" }).template,
    "{{cite book |title=La tour |author=Eiffel, Gustave |year=1900 |page=41 |url=https://archive.org/details/tour/page/41 |via=Internet Archive}}",
  );
  const two = citationWithPage(cite, { leaf: 57, page: "41", leafEnd: 58, pageEnd: "42" });
  assert.match(two.template, /\|pages=41–42 \|url=https:\/\/archive\.org\/details\/tour\/page\/41 \|/);
  assert.equal(two.ref, `<ref>${two.template}</ref>`);
  // No printed number, or one already given: as it was.
  assert.equal(citationWithPage(cite, { leaf: 57, page: null }), cite);
  const given = citationWithPage(cite, { leaf: 57, page: "41" });
  assert.equal(citationWithPage(given, { leaf: 60, page: "44" }), given);
});

test("withQuotePage: the page of the passage holding the checked quote", () => {
  const terms = claimTerms(CLAIM, "Eiffel Tower");
  const cite = formatArchiveCitation({ identifier: "tour", title: "La tour", creator: null, year: null }, "open", null);
  const c: ArchiveCandidate = {
    url: "https://archive.org/details/tour",
    title: "La tour",
    relevance: "",
    snippet: "",
    citation: cite,
    evidence: {
      origin: "internet-archive", identifier: "tour", year: null, access: "open",
      passages: ["Eiffel completed it in 1889.", PAGE_P1],
      pages: [null, { leaf: 57, page: "41" }],
      score: 1, matchedAnchors: [], query: "q", viewerUrl: "https://archive.org/details/tour?q=x",
    },
  };
  assert.deepEqual(quotePage(c.evidence, "the tower was completed, and Eiffel climbed to its summit"), { leaf: 57, page: "41" });
  assert.equal(quotePage(c.evidence, "Eiffel completed it in 1889"), null, "a highlight has no page");
  const paged = withQuotePage(c, "the tower was completed, and Eiffel climbed to its summit", terms);
  assert.match(paged.citation.template, /\|page=41 \|url=https:\/\/archive\.org\/details\/tour\/page\/41 \|/);
  assert.match(paged.evidence.viewerUrl, /^https:\/\/archive\.org\/details\/tour\/page\/leaf57\?q=/);
  assert.equal(withQuotePage(c, "Eiffel completed it in 1889", terms), c);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractClaims } from "../src/core/extractClaims.js";
import type { ArchiveCandidate } from "../src/core/types.js";
import { claimProse, htmlToText, matchClaims, textShowsClaim } from "../src/hints/match.js";
import { keptBooks, toBookHint, PIPELINE_VERSION, type PageHints } from "../src/hints/compute.js";
import { fileStore, memoryStore } from "../src/hints/store.js";
import { handleRequest } from "../src/hints/server.js";
import { upToDate } from "../src/hints/batch.js";

// The paragraph Citation Hunt showed for Mad (magazine), as wikitext and as
// rendered HTML (abridged to the parts that matter).
const WIKITEXT = `== Other satiric-comics magazines ==
In 1967, [[Marvel Comics]] produced the first of 13 issues of the comic book ''[[Not Brand Echh]]'', which parodied the company's own superhero titles as well as other publishers. Another publisher's comic was ''Trash'' (1978){{citation needed|date=December 2013}} featured a blurb on the debut cover reading, "We mess with ''Mad'' (p.&nbsp;21)".

== Film and television ==
''Mad'' has been criticized for its over-reliance on a core group of aging regulars throughout the 1970s and 1980s.{{cn|date=February 2022}}`;

const SNIPPET_HTML = `<p>In 1967, <a href="/wiki/Marvel_Comics">Marvel Comics</a> produced the first of 13 issues of the comic book <i><a href="/wiki/Not_Brand_Echh">Not Brand Echh</a></i>, which parodied the company&#39;s own superhero titles as well as other publishers. Another publisher&#39;s comic was <i>Trash</i> (1978)<sup class="superscript">[<i>citation needed</i>]</sup> featured a blurb on the debut cover reading, &quot;We mess with <i>Mad</i> (p.&nbsp;21)&quot;.</p>`;

test("claimProse drops wiki markup", () => {
  const [trash] = extractClaims(WIKITEXT);
  assert.equal(claimProse(trash.claim), "Another publisher's comic was Trash (1978)");
});

test("htmlToText decodes entities and drops tags", () => {
  assert.match(htmlToText(SNIPPET_HTML), /Another publisher's comic was Trash \(1978\)\[citation needed\]/);
});

test("a snippet matches the claim whose sentence it shows, and no other", () => {
  const claims = extractClaims(WIKITEXT).map((c) => ({ claim: claimProse(c.claim) }));
  const matched = matchClaims(claims, SNIPPET_HTML);
  assert.deepEqual(matched.map((c) => c.claim), ["Another publisher's comic was Trash (1978)"]);
});

test("a short claim must appear whole; a long one survives a small edit", () => {
  assert.equal(textShowsClaim("Mad has never been criticized", "Mad has been criticized"), false);
  const long = "Mad has been criticized for its over-reliance on a core group of aging regulars throughout the 1970s and 1980s";
  const edited = "Mad was criticized for its over-reliance on a core group of ageing regulars throughout the 1970s and 1980s.";
  assert.equal(textShowsClaim(edited, long), true);
  assert.equal(textShowsClaim("Mad was popular in the 1970s and 1980s.", long), false);
});

function candidate(over: Partial<ArchiveCandidate["evidence"]> & { title: string }): ArchiveCandidate {
  const viewerUrl = `https://archive.org/details/${over.identifier ?? "x"}?q=%22old%22`;
  return {
    url: `https://archive.org/details/${over.identifier ?? "x"}`,
    title: over.title,
    relevance: "",
    snippet: "",
    evidence: {
      origin: "internet-archive",
      identifier: over.identifier ?? "x",
      year: over.year ?? 2002,
      access: over.access ?? "borrow",
      passages: over.passages ?? [],
      score: over.score ?? 0.5,
      matchedAnchors: [],
      query: "",
      viewerUrl,
    },
    citation: {
      kind: "cite book",
      template: `{{cite book |title=${over.title} |url=${viewerUrl} |via=Internet Archive}}`,
      ref: `<ref>{{cite book |title=${over.title} |url=${viewerUrl} |via=Internet Archive}}</ref>`,
    },
  };
}

test("keptBooks keeps only checked books with a quote, supports first", () => {
  const books = [
    candidate({ title: "A", identifier: "a", score: 0.9 }),
    candidate({ title: "B", identifier: "b", score: 0.4 }),
    candidate({ title: "C", identifier: "c", score: 0.8 }),
    candidate({ title: "D", identifier: "d", score: 0.7 }),
  ];
  const kept = keptBooks(books, [
    { verdict: "partial", quote: "some words", reason: "" },
    { verdict: "supports", quote: "the words", reason: "" },
    { verdict: "unsupported", quote: "", reason: "" },
    { verdict: "supports", quote: "  ", reason: "" },
  ]);
  assert.deepEqual(kept.map((k) => k.candidate.title), ["B", "A"]);
});

test("a hint links to the book searched for the checked quote, in its citation too", () => {
  const c = candidate({ title: "The Official Overstreet Comic Book Price Guide", identifier: "officialoverstre00robe" });
  const hint = toBookHint(
    c,
    { verdict: "supports", quote: "TRASH Trash Publ. Co.: Mar, 1978 - No. 4, Oct, 1978", reason: "" },
    "Another publisher's comic was ''Trash'' (1978)",
    "Mad (magazine)",
  );
  assert.match(hint.url, /^https:\/\/archive\.org\/details\/officialoverstre00robe\?q=/);
  assert.notEqual(hint.url, c.evidence.viewerUrl);
  assert.ok(hint.cite.includes(hint.url), hint.cite);
  assert.ok(!hint.cite.includes(c.evidence.viewerUrl));
});

const PAGE: PageHints = {
  version: PIPELINE_VERSION,
  wiki: "en",
  pageId: 19399,
  title: "Mad (magazine)",
  revId: 1000,
  computedAt: "2026-11-24T00:00:00.000Z",
  claims: [
    {
      claim: "Another publisher's comic was Trash (1978)",
      section: "Other satiric-comics magazines",
      status: "checked",
      checked: 11,
      books: [
        {
          verdict: "supports",
          quote: "TRASH Trash Publ. Co.: Mar, 1978 - No. 4, Oct, 1978",
          title: "Official Overstreet comic book price guide",
          year: 2002,
          access: "borrow",
          url: "https://archive.org/details/officialoverstre00robe?q=x",
          identifier: "officialoverstre00robe",
          cite: "<ref>{{cite book}}</ref>",
        },
      ],
    },
    {
      claim: "Mad has been criticized for its over-reliance on a core group of aging regulars throughout the 1970s and 1980s.",
      section: "Film and television",
      status: "checked",
      checked: 7,
      books: [],
    },
  ],
};

test("the API returns the snippet's claim and its book", async () => {
  const store = memoryStore();
  await store.put(PAGE);
  const q = new URLSearchParams({ wiki: "en", page_id: "19399", text: SNIPPET_HTML });
  const r = await handleRequest("GET", `/v1/hints?${q}`, store);
  assert.equal(r.status, 200);
  const body = r.body as { claims: { claim: string; books: Record<string, unknown>[] }[] };
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0].books[0].title, "Official Overstreet comic book price guide");
  assert.equal("identifier" in body.claims[0].books[0], false);
});

test("the API says when an article has not been checked, and rejects bad input", async () => {
  const store = memoryStore();
  assert.equal((await handleRequest("GET", "/v1/hints?wiki=en&page_id=1", store)).status, 404);
  assert.equal((await handleRequest("GET", "/v1/hints?wiki=en", store)).status, 400);
  assert.equal((await handleRequest("GET", "/v1/hints?wiki=../x&page_id=1", store)).status, 400);
  assert.equal((await handleRequest("POST", "/v1/hints?wiki=en&page_id=1", store)).status, 405);
});

test("without text, the API returns every claim of the article", async () => {
  const store = memoryStore();
  await store.put(PAGE);
  const r = await handleRequest("GET", "/v1/hints?wiki=en&page_id=19399", store);
  assert.equal((r.body as { claims: unknown[] }).claims.length, 2);
});

test("the file store round-trips a page and refuses unsafe keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hints-"));
  try {
    const store = fileStore(dir);
    assert.equal(await store.get("en", 19399), null);
    await store.put(PAGE);
    assert.deepEqual(await store.get("en", 19399), PAGE);
    await assert.rejects(store.get("../en", 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a page is recomputed after an edit, a pipeline change or a failed claim", () => {
  const input = { wiki: "en", pageId: 19399, title: "Mad (magazine)", revId: 1000, wikitext: "" };
  assert.equal(upToDate(PAGE, input), true);
  assert.equal(upToDate(PAGE, { ...input, revId: 1001 }), false);
  assert.equal(upToDate({ ...PAGE, version: PIPELINE_VERSION - 1 }, input), false);
  const failed = { ...PAGE, claims: [{ ...PAGE.claims[0], status: "error" as const }] };
  assert.equal(upToDate(failed, input), false);
  assert.equal(upToDate(null, input), false);
});

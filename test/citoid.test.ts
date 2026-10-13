/**
 * A {{cite book}} completed from its ISBN through Citoid and the template's
 * TemplateData map, in the core and in the user script alike.
 *
 * The Citoid answer is shaped like the service's `mediawiki` format (a list of
 * Zotero-style records, names as [first, last]); it is written by hand, since
 * the REST API rate-limits the machines the tests are recorded on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatArchiveCitation } from "../src/core/archiveSources.js";
import {
  CITE_BOOK_CITOID_MAP,
  citationIsbn,
  citoidParams,
  completeCitation,
  completeFromIsbn,
  normaliseIsbn,
  type CitoidMap,
} from "../src/core/citoid.js";
import { loadUserScript } from "./userscriptLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CITOID = JSON.parse(
  readFileSync(join(__dirname, "fixtures/citoid/isbn_9780140449136.json"), "utf8"),
);

const script = loadUserScript();

const archive = () =>
  formatArchiveCitation(
    {
      identifier: "crimepunishment0000dost",
      title: "Crime and punishment",
      creator: "Dostoyevsky, Fyodor, 1821-1881",
      year: 2003,
    },
    "borrow",
    { publisher: "London : Penguin", isbn: "9780140449136" },
  );

const FULL =
  "{{cite book |last=Dostoyevsky |first=Fyodor |translator-last=McDuff |translator-first=David " +
  "|title=Crime and punishment |edition=Rev. ed. |series=Penguin classics |publisher=Penguin Books " +
  "|location=London |date=2003 |language=en |isbn=978-0-14-044913-6 |oclc=39283358 " +
  "|url=https://archive.org/details/crimepunishment0000dost |url-access=registration |via=Internet Archive}}";

test("the catalogue fills every field it has; the Archive keeps its link", () => {
  const done = completeCitation(archive(), CITOID, CITE_BOOK_CITOID_MAP);
  assert.equal(done.template, FULL);
  assert.equal(done.ref, `<ref>${FULL}</ref>`);
  assert.equal(done.kind, "cite book");
});

test("the template's own map decides the parameter names", () => {
  const map: CitoidMap = { title: "title", place: "ort", author: [["vorname", "nachname"]] };
  assert.deepEqual(citoidParams(CITOID[0], map), {
    title: "Crime and punishment",
    ort: "London",
    nachname: "Dostoyevsky",
    vorname: "Fyodor",
  });
});

test("a one-part name is all |last=, and pipes are escaped", () => {
  const params = citoidParams(
    { title: "A | B", author: [["", "Penguin Editors"], ["Plato", ""]] },
    CITE_BOOK_CITOID_MAP,
  );
  assert.deepEqual(params, { title: "A {{!}} B", last: "Penguin Editors", last2: "Plato" });
});

test("what the catalogue leaves out comes from the Archive", () => {
  const done = completeCitation(archive(), [{ itemType: "book", title: "Crime and punishment" }], CITE_BOOK_CITOID_MAP);
  assert.equal(
    done.template,
    "{{cite book |author=Dostoyevsky, Fyodor |title=Crime and punishment |publisher=London : Penguin " +
      "|year=2003 |isbn=9780140449136 |url=https://archive.org/details/crimepunishment0000dost " +
      "|url-access=registration |via=Internet Archive}}",
  );
});

test("nothing usable leaves the citation as it was", () => {
  const c = archive();
  assert.equal(completeCitation(c, [], CITE_BOOK_CITOID_MAP), c);
  assert.equal(completeCitation(c, [{ itemType: "book" }], CITE_BOOK_CITOID_MAP), c);
  assert.equal(completeCitation(c, { error: "not found" }, CITE_BOOK_CITOID_MAP), c);
});

test("only a usable ISBN is looked up", () => {
  assert.equal(normaliseIsbn("0-14-044913-2"), "0140449132");
  assert.equal(normaliseIsbn("978 0 14 044913 6"), "9780140449136");
  assert.equal(normaliseIsbn("080442957x"), "080442957X");
  assert.equal(normaliseIsbn("12345"), null);
  assert.equal(citationIsbn(archive()), "9780140449136");
  const noIsbn = formatArchiveCitation({ identifier: "x", title: "T", creator: null, year: null }, "open", null);
  assert.equal(citationIsbn(noIsbn), null);
});

test("the user script completes the citation exactly as the core does", () => {
  for (const items of [CITOID, [{ itemType: "book", title: "Crime and punishment" }], [], [{ itemType: "book" }]]) {
    assert.deepEqual(
      script.completeCitation(archive(), items, script.citeBookMap),
      completeCitation(archive(), items, CITE_BOOK_CITOID_MAP),
    );
  }
  assert.deepEqual(script.citeBookMap, CITE_BOOK_CITOID_MAP);
  assert.equal(script.citationIsbn(archive()), citationIsbn(archive()));
  for (const raw of ["0-14-044913-2", "080442957x", "12345"]) {
    assert.equal(script.normaliseIsbn(raw), normaliseIsbn(raw));
  }
});

/** A fetch that answers TemplateData and Citoid, and counts what was asked. */
function stubFetch(templateData: unknown, citoid: unknown, citoidStatus = 200) {
  const asked: string[] = [];
  const fetchStub = (async (url: string) => {
    asked.push(url);
    if (url.includes("action=templatedata")) return Response.json(templateData);
    if (url.includes("/api/rest_v1/data/citation/mediawiki/")) {
      return citoidStatus === 200 ? Response.json(citoid) : new Response("{}", { status: citoidStatus });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { asked, fetchStub };
}

const TEMPLATE_DATA = { pages: { "1": { title: "Template:Cite book", maps: { citoid: CITE_BOOK_CITOID_MAP } } } };

test("both ask the wiki's Citoid for the ISBN and use the template's map", async () => {
  const realFetch = globalThis.fetch;
  try {
    const core = stubFetch(TEMPLATE_DATA, CITOID);
    globalThis.fetch = core.fetchStub;
    assert.equal((await completeFromIsbn(archive(), "en")).template, FULL);
    assert.ok(core.asked.includes("https://en.wikipedia.org/api/rest_v1/data/citation/mediawiki/9780140449136"));

    const user = stubFetch(TEMPLATE_DATA, CITOID);
    globalThis.fetch = user.fetchStub;
    const s = loadUserScript();
    assert.equal((await s.completeFromIsbn(archive())).template, FULL);
    assert.ok(user.asked.includes("https://en.wikipedia.org/api/rest_v1/data/citation/mediawiki/9780140449136"));

    // A failed lookup leaves the Archive's citation in place.
    globalThis.fetch = stubFetch(TEMPLATE_DATA, null, 404).fetchStub;
    assert.equal((await completeFromIsbn(archive(), "de")).template, archive().template);
    assert.equal((await loadUserScript().completeFromIsbn(archive())).template, archive().template);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the user script keeps the full citation on the book, and looks it up once", async () => {
  const realFetch = globalThis.fetch;
  try {
    const { asked, fetchStub } = stubFetch({ pages: { "1": { title: "Template:Cite book" } } }, CITOID);
    globalThis.fetch = fetchStub;
    const s = loadUserScript();
    const book = { citation: archive() };
    const [a, b] = await Promise.all([s.completeBookCitation(book), s.completeBookCitation(book)]);
    // No map in TemplateData: en.wikipedia's built-in copy.
    assert.equal(a.template, FULL);
    assert.equal(b.template, FULL);
    assert.equal(book.citation.template, FULL);
    await s.completeBookCitation(book);
    assert.equal(asked.filter((u) => u.includes("/citation/")).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

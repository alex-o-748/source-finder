/**
 * Citations completed through Citoid — from a book's ISBN, a link's DOI, or
 * the page itself — with the template the wiki's type map picks and the
 * parameters its TemplateData map names, in the core and in the user script alike.
 *
 * The Citoid answers are shaped like the service's `mediawiki` format (a list
 * of Zotero-style records, names as [first, last]); they are written by hand,
 * since the REST API rate-limits the machines the tests are recorded on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatArchiveCitation } from "../src/core/archiveSources.js";
import { formatCitation } from "../src/core/formatCitation.js";
import {
  BUILTIN_CITOID_MAPS,
  CITE_BOOK_CITOID_MAP,
  CITOID_TYPE_MAP,
  citoidParams,
  citoidQuery,
  citoidTemplate,
  completeCitation,
  completeFromCitoid,
  doiIn,
  normaliseIsbn,
  type CitoidMap,
} from "../src/core/citoid.js";
import type { Citation } from "../src/core/types.js";
import { loadUserScript } from "./userscriptLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures/citoid", name), "utf8"));
const BOOK = fixture("isbn_9780140449136.json");
const NEWS = fixture("url_guardian_news.json");
const JOURNAL = fixture("doi_journal.json");

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

const NEWS_URL = "https://www.theguardian.com/world/2024/mar/02/eiffel-tower-facelift";
const JOURNAL_URL = "https://www.tandfonline.com/doi/full/10.1080/00207543.2019.1234567";
const BLOG_URL = "https://example.org/2024/eiffel";
const news = () => formatCitation({ url: NEWS_URL, title: "Eiffel Tower facelift | World news" } as never);
const journal = () => formatCitation({ url: JOURNAL_URL, title: "Wind loads" } as never);
const blog = () => formatCitation({ url: BLOG_URL, title: "Eiffel" } as never);
const accessDate = (c: Citation) => /access-date=([\d-]+)/.exec(c.template)![1];

const FULL_BOOK =
  "{{cite book |last=Dostoyevsky |first=Fyodor |translator-last=McDuff |translator-first=David " +
  "|title=Crime and punishment |edition=Rev. ed. |series=Penguin classics |publisher=Penguin Books " +
  "|location=London |date=2003 |language=en |isbn=978-0-14-044913-6 |oclc=39283358 " +
  "|url=https://archive.org/details/crimepunishment0000dost |url-access=registration |via=Internet Archive}}";

const fullNews = (date: string) =>
  "{{cite news |last=Willsher |first=Kim |title=Eiffel Tower to get a facelift before the Olympics " +
  `|work=The Guardian |date=2024-03-02 |language=en-GB |issn=0261-3077 |url=${NEWS_URL} |access-date=${date}}}`;

const fullJournal = (date: string) =>
  "{{cite journal |last=Lovelace |first=Ada |last2=Babbage |first2=Charles |title=Wind loads on the Eiffel Tower " +
  "|journal=Journal of Wind Engineering |volume=58 |issue=4 |pages=1001–1019 |date=2020-02-16 |language=en " +
  `|issn=0020-7543 |doi=10.1080/00207543.2019.1234567 |url=${JOURNAL_URL} |access-date=${date}}}`;

test("a book: the catalogue fills every field it has; the Archive keeps its link", () => {
  const done = completeCitation(archive(), BOOK, "cite book", CITE_BOOK_CITOID_MAP);
  assert.equal(done.template, FULL_BOOK);
  assert.equal(done.ref, `<ref>${FULL_BOOK}</ref>`);
  assert.equal(done.kind, "cite book");
});

test("a news page: the author, date and paper's name replace the host", () => {
  const c = news();
  const done = completeCitation(c, NEWS, "cite news", BUILTIN_CITOID_MAPS["cite news"]);
  assert.equal(done.template, fullNews(accessDate(c)));
});

test("a DOI: the journal, volume, issue and pages, with our link kept", () => {
  const c = journal();
  const done = completeCitation(c, JOURNAL, "cite journal", BUILTIN_CITOID_MAPS["cite journal"]);
  assert.equal(done.template, fullJournal(accessDate(c)));
});

test("the item type picks the template; a new template keeps only our link and date", () => {
  assert.equal(citoidTemplate(NEWS[0], CITOID_TYPE_MAP, "cite web"), "cite news");
  assert.equal(citoidTemplate({ itemType: "videoRecording" }, CITOID_TYPE_MAP, "cite web"), "cite AV media");
  assert.equal(citoidTemplate({ itemType: "artwork" }, CITOID_TYPE_MAP, "cite web"), "cite web");
  // A wiki whose map names its own template: ours would not fit its parameters.
  assert.equal(citoidTemplate(NEWS[0], { newspaperArticle: "Internetquelle" }, "cite web"), "cite web");
  const c = blog();
  assert.match(c.template, /^\{\{cite web .*\|website=example\.org/);
  const done = completeCitation(c, NEWS, "cite news", BUILTIN_CITOID_MAPS["cite news"]);
  assert.equal(done.kind, "cite news");
  assert.doesNotMatch(done.template, /website=/);
  assert.match(done.template, new RegExp(`\\|url=${BLOG_URL} \\|access-date=${accessDate(c)}\\}\\}$`));
});

test("the template's own map decides the parameter names", () => {
  const map: CitoidMap = { title: "title", place: "ort", author: [["vorname", "nachname"]] };
  assert.deepEqual(citoidParams(BOOK[0], map), {
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

test("what the catalogue leaves out comes from the citation we had", () => {
  const done = completeCitation(archive(), [{ itemType: "book", title: "Crime and punishment" }], "cite book", CITE_BOOK_CITOID_MAP);
  assert.equal(
    done.template,
    "{{cite book |author=Dostoyevsky, Fyodor |title=Crime and punishment |publisher=London : Penguin " +
      "|year=2003 |isbn=9780140449136 |url=https://archive.org/details/crimepunishment0000dost " +
      "|url-access=registration |via=Internet Archive}}",
  );
  const c = blog();
  const bare = completeCitation(c, [{ itemType: "webpage", title: "The tower" }], "cite web", BUILTIN_CITOID_MAPS["cite web"]);
  assert.equal(bare.template, `{{cite web |title=The tower |website=example.org |url=${BLOG_URL} |access-date=${accessDate(c)}}}`);
});

test("nothing usable leaves the citation as it was", () => {
  const c = archive();
  assert.equal(completeCitation(c, [], "cite book", CITE_BOOK_CITOID_MAP), c);
  assert.equal(completeCitation(c, [{ itemType: "book" }], "cite book", CITE_BOOK_CITOID_MAP), c);
  assert.equal(completeCitation(c, { error: "not found" }, "cite book", CITE_BOOK_CITOID_MAP), c);
  // Citoid names a page it could not read after its link.
  const b = blog();
  assert.equal(completeCitation(b, [{ itemType: "webpage", title: BLOG_URL, url: BLOG_URL }], "cite web", BUILTIN_CITOID_MAPS["cite web"]), b);
});

test("the query: the ISBN, else the DOI in the link, else the link", () => {
  assert.equal(normaliseIsbn("0-14-044913-2"), "0140449132");
  assert.equal(normaliseIsbn("978 0 14 044913 6"), "9780140449136");
  assert.equal(normaliseIsbn("080442957x"), "080442957X");
  assert.equal(normaliseIsbn("12345"), null);
  assert.equal(citoidQuery(archive()), "9780140449136");
  assert.equal(citoidQuery(journal()), "10.1080/00207543.2019.1234567");
  assert.equal(citoidQuery(news()), NEWS_URL);
  // An Archive scan without an ISBN: its own metadata already said more.
  assert.equal(citoidQuery(formatArchiveCitation({ identifier: "x", title: "T", creator: null, year: null }, "open", null)), null);
  assert.equal(doiIn("https://doi.org/10.1038/171737a0"), "10.1038/171737a0");
  assert.equal(doiIn("https://link.springer.com/content/pdf/10.1007/s00222-019-00911-x.pdf"), "10.1007/s00222-019-00911-x");
  assert.equal(doiIn("https://onlinelibrary.wiley.com/doi/abs/10.1002/anie.201915678/abstract"), "10.1002/anie.201915678");
  assert.equal(doiIn("https://example.org/doi%2F10.5555%2F12345678?x=1"), "10.5555/12345678");
  assert.equal(doiIn(NEWS_URL), null);
});

test("the user script completes citations exactly as the core does", () => {
  const cases: [() => Citation, unknown, string][] = [
    [archive, BOOK, "cite book"],
    [archive, [{ itemType: "book", title: "Crime and punishment" }], "cite book"],
    [archive, [], "cite book"],
    [news, NEWS, "cite news"],
    [journal, JOURNAL, "cite journal"],
    [blog, NEWS, "cite news"],
    [blog, [{ itemType: "webpage", title: "The tower" }], "cite web"],
    [blog, [{ itemType: "webpage", title: BLOG_URL }], "cite web"],
  ];
  for (const [make, items, template] of cases) {
    assert.deepEqual(
      script.completeCitation(make(), items, template, script.citoidMaps[template]),
      completeCitation(make(), items, template, BUILTIN_CITOID_MAPS[template]),
    );
  }
  assert.deepEqual(script.citoidMaps, BUILTIN_CITOID_MAPS);
  assert.deepEqual(script.citoidTypeMap, CITOID_TYPE_MAP);
  for (const c of [archive(), news(), journal(), blog()]) assert.equal(script.citoidQuery(c), citoidQuery(c));
  for (const url of [NEWS_URL, JOURNAL_URL, "https://doi.org/10.1038/171737a0", "https://example.org/doi%2F10.5555%2F12345678?x=1"]) {
    assert.equal(script.doiIn(url), doiIn(url));
  }
  for (const item of [NEWS[0], { itemType: "videoRecording" }, { itemType: "artwork" }]) {
    assert.equal(script.citoidTemplate(item, CITOID_TYPE_MAP, "cite web"), citoidTemplate(item, CITOID_TYPE_MAP, "cite web"));
  }
});

/** A fetch that answers the type map, TemplateData and Citoid, and records what was asked. */
function stubFetch(citoid: unknown, { status = 200, typeMap = true, templateData = true } = {}) {
  const asked: string[] = [];
  const fetchStub = (async (url: string) => {
    asked.push(url);
    const u = new URL(url);
    if (u.searchParams.get("action") === "query") {
      const content = JSON.stringify(CITOID_TYPE_MAP);
      return typeMap
        ? Response.json({ query: { pages: [{ revisions: [{ slots: { main: { content } } }] }] } })
        : Response.json({ query: { pages: [{ missing: true }] } });
    }
    if (u.searchParams.get("action") === "templatedata") {
      const name = u.searchParams.get("titles")!.replace(/^Template:/, "").toLowerCase();
      const maps = templateData && BUILTIN_CITOID_MAPS[name] ? { citoid: BUILTIN_CITOID_MAPS[name] } : undefined;
      return Response.json({ pages: { "1": { title: `Template:${name}`, ...(maps && { maps }) } } });
    }
    if (u.pathname.startsWith("/api/rest_v1/data/citation/mediawiki/")) {
      return status === 200 ? Response.json(citoid) : new Response("{}", { status });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { asked, fetchStub };
}

const citoidAsked = (asked: string[]) =>
  asked.filter((u) => u.includes("/api/rest_v1/data/citation/mediawiki/"));

test("both ask the wiki's Citoid and use its type map and the template's map", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const [make, items, want, query] of [
      [archive, BOOK, () => FULL_BOOK, "9780140449136"],
      [news, NEWS, (c: Citation) => fullNews(accessDate(c)), NEWS_URL],
      [journal, JOURNAL, (c: Citation) => fullJournal(accessDate(c)), "10.1080/00207543.2019.1234567"],
    ] as [() => Citation, unknown, (c: Citation) => string, string][]) {
      const expected = `https://en.wikipedia.org/api/rest_v1/data/citation/mediawiki/${encodeURIComponent(query)}`;
      const core = stubFetch(items);
      globalThis.fetch = core.fetchStub;
      assert.equal((await completeFromCitoid(make(), "en")).template, want(make()));
      assert.deepEqual(citoidAsked(core.asked), [expected]);

      const user = stubFetch(items);
      globalThis.fetch = user.fetchStub;
      assert.equal((await loadUserScript().completeFromCitoid(make())).template, want(make()));
      assert.deepEqual(citoidAsked(user.asked), [expected]);
    }

    // No type map and no TemplateData maps on the wiki: the built-in copies.
    globalThis.fetch = stubFetch(NEWS, { typeMap: false, templateData: false }).fetchStub;
    assert.equal((await completeFromCitoid(blog(), "fr")).kind, "cite news");
    assert.equal((await loadUserScript({ wgServer: "//fr.wikipedia.org" }).completeFromCitoid(blog())).kind, "cite news");

    // A failed lookup leaves the citation in place.
    globalThis.fetch = stubFetch(null, { status: 404 }).fetchStub;
    assert.equal((await completeFromCitoid(archive(), "de")).template, archive().template);
    assert.equal((await loadUserScript().completeFromCitoid(archive())).template, archive().template);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the user script keeps the full citation on the source, and looks it up once", async () => {
  const realFetch = globalThis.fetch;
  try {
    const { asked, fetchStub } = stubFetch(BOOK, { templateData: false });
    globalThis.fetch = fetchStub;
    const s = loadUserScript();
    const book = { citation: archive() };
    let saved = 0;
    const held = s.citoidHolder(book, () => saved++);
    const [a, b] = await Promise.all([s.completeHeldCitation(held), s.completeHeldCitation(held)]);
    assert.equal(a.template, FULL_BOOK);
    assert.equal(b.template, FULL_BOOK);
    assert.equal(book.citation.template, FULL_BOOK);
    assert.equal(saved, 1);
    await s.completeHeldCitation(held);
    assert.equal(citoidAsked(asked).length, 1);

    // A web result's item carries its suggestion, so its buttons get the full citation.
    globalThis.fetch = stubFetch(NEWS).fetchStub;
    const s2 = loadUserScript();
    const suggestion = {
      source: { url: NEWS_URL, title: "Eiffel Tower facelift" },
      verdict: { verdict: "SUPPORTED", confidence: 90, comments: "The tower is being repainted.", reliability: "high", reliabilityReason: "" },
      citation: news(),
    };
    const item = s2.webItem({ claim: "The tower was repainted in 2024." }, suggestion, "web0");
    assert.equal(item.cite.holder, suggestion);
    const done = await s2.completeHeldCitation(item.cite);
    assert.equal(done.template, fullNews(accessDate(news())));
    assert.equal(suggestion.citation.template, done.template);
  } finally {
    globalThis.fetch = realFetch;
  }
});

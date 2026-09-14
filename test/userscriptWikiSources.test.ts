/**
 * Parity test for the user script's inlined copy of the wiki-local stage.
 *
 * The user script is standalone by design — it re-implements the pipeline in
 * the browser rather than importing `src/` — so the only thing keeping the two
 * in step is a test that runs the shipped file against the same fixtures the
 * TypeScript core is tested on.
 *
 * The script is an IIFE guarded for a live MediaWiki page, so it is loaded here
 * with just enough of `mw`, `window` and `document` stubbed to get past the
 * boot guards, and the pure functions are handed back for testing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractClaims } from "../src/core/extractClaims.js";
import { extractWikilinks, paragraphRangeAt } from "../src/core/wikitext.js";
import { buildWikiCorpus, findWikiCandidates } from "../src/core/wikiSources.js";
import type { WikidataCorpus } from "../src/core/wikiSources.js";
import type { WdEntity } from "../src/core/wikidata.js";
import type { Article } from "../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures/wiki", name), "utf8");
}

const EN = fixture("en_lighthouse.wikitext");
const DE = fixture("de_lighthouse.wikitext");
const ENTITIES = JSON.parse(fixture("wikidata_lighthouse.json")) as Record<
  string,
  WdEntity
>;

/** Labels the live stage would fetch; hard-coded so the test stays offline. */
const WD_LABELS: Record<string, string> = {
  Q100: "Karsten Point Lighthouse",
  Q200: "Harbour Authority Registry",
  P2048: "height",
  P2929: "light range",
  P2044: "elevation above sea level",
  P580: "start time",
  P571: "inception",
};

interface UserScriptModule {
  indexWikiArticle(lang: string, title: string, wikitext: string): unknown;
  findWikiCandidates(corpus: unknown, index: number): {
    url: string | null;
    title: string;
    ref: string;
    relevance: string;
    evidence: {
      origin: string;
      score: number;
      matchedAnchors?: string[];
      lang: string;
      statement?: { property: string; propertyLabel: string; value: string };
    };
  }[];
  citationNeededOffsets(text: string): { start: number; end: number }[];
  stripWikitext(text: string): string;
  refToSource(content: string): { url: string | null; title: string | null } | null;
  setClaimContexts(value: unknown[]): void;
  setCnSups(value: unknown[]): void;
}

/** Loads the user script with browser globals stubbed, exposing its internals. */
function loadUserScript(): UserScriptModule {
  const src = readFileSync(join(root, "userscript/cnfirmed.js"), "utf8");
  const open = "(function () {";
  const body = src.slice(
    src.indexOf(open) + open.length,
    src.lastIndexOf("})();"),
  );
  const exposed = `
    return {
      indexWikiArticle: indexWikiArticle,
      findWikiCandidates: findWikiCandidates,
      citationNeededOffsets: citationNeededOffsets,
      stripWikitext: stripWikitext,
      refToSource: refToSource,
      setClaimContexts: function (v) { claimContexts = v; },
      setCnSups: function (v) { cnSups = v; }
    };`;

  const config: Record<string, unknown> = {
    wgNamespaceNumber: 0,
    wgAction: "view",
    wgServer: "//en.wikipedia.org",
    wgContentLanguage: "en",
    wgPageName: "Karsten_Point_Lighthouse",
    wgCurRevisionId: 1,
    wgArticlePath: "/wiki/$1",
  };
  const mw = {
    config: { get: (key: string) => config[key] },
    util: { addCSS() {}, addPortletLink() {}, addPortlet() {}, getUrl: (t: string) => `/wiki/${t}` },
    loader: { using: () => ({ then: () => ({ catch() {} }) }), getScript: () => Promise.resolve() },
  };
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  // The boot sequence is a jQuery ready callback; swallowing it leaves the
  // module's pure functions defined and nothing else running.
  const jquery = () => ({ appendTo() {}, on() {}, text() {}, css() {}, append() {} });
  const factory = new Function(
    "mw",
    "window",
    "document",
    "localStorage",
    "$",
    "OO",
    body + exposed,
  ) as (...args: unknown[]) => UserScriptModule;

  return factory(
    mw,
    {},
    { addEventListener() {}, querySelectorAll: () => [] },
    localStorage,
    jquery,
    {},
  );
}

const script = loadUserScript();

/** The claim shape the user script builds from the rendered DOM. */
function claimContextsFromWikitext(wikitext: string) {
  return extractClaims(wikitext).map((claim) => {
    const { start, end } = paragraphRangeAt(wikitext, claim.offset);
    return {
      claim: claim.claim,
      context: claim.context,
      section: claim.section,
      links: extractWikilinks(wikitext.slice(start, end)),
    };
  });
}

const CONTEXTS = claimContextsFromWikitext(EN);
script.setClaimContexts(CONTEXTS);
script.setCnSups(CONTEXTS.map(() => ({})));

function scriptCorpus(withSister: boolean) {
  return {
    local: script.indexWikiArticle("en", "Karsten Point Lighthouse", EN),
    sisters: withSister
      ? [script.indexWikiArticle("de", "Leuchtturm Karsten Point", DE)]
      : [],
    linkTranslations: {
      Fyrland: { de: "Fyrland" },
      "Anna Berg": { de: "Anna Berg" },
    },
    wikidata: {
      entities: ENTITIES,
      titleQids: { "Karsten Point Lighthouse": "Q100" },
      labels: WD_LABELS,
      subjectQid: "Q100",
    },
    claimOffsets: script.citationNeededOffsets(EN),
    warnings: [],
  };
}

const coreWikidata: WikidataCorpus = {
  entities: new Map(Object.entries(ENTITIES)),
  titleQids: new Map([["Karsten Point Lighthouse", "Q100"]]),
  labels: new Map(Object.entries(WD_LABELS)),
};

const article: Article = {
  title: "Karsten Point Lighthouse",
  lang: "en",
  revid: 1,
  wikitext: EN,
  url: "https://en.wikipedia.org/wiki/Karsten_Point_Lighthouse",
};
const coreCorpus = buildWikiCorpus(
  article,
  [{ lang: "de", title: "Leuchtturm Karsten Point", wikitext: DE }],
  new Map([
    ["Fyrland", new Map([["de", "Fyrland"]])],
    ["Anna Berg", new Map([["de", "Anna Berg"]])],
  ]),
  coreWikidata,
);
const coreClaims = extractClaims(EN);

test("citationNeededOffsets lines the wikitext tags up with the rendered sups", () => {
  const offsets = script.citationNeededOffsets(EN);
  assert.equal(offsets.length, coreClaims.length);
  offsets.forEach((o, i) => {
    assert.equal(o.start, coreClaims[i].offset, `tag ${i} is at the same offset`);
    assert.equal(EN.slice(o.start, o.end), coreClaims[i].tag);
  });
});

test("the user script's wikitext stripper agrees with the core's", () => {
  assert.equal(
    script.stripWikitext("It opened in 1889.<ref>{{cite web|url=https://e.org}}</ref>{{cn}}"),
    "It opened in 1889.",
  );
  assert.equal(
    script.refToSource("{{cite news |url=https://ex.com/a |title=Headline}}")?.url,
    "https://ex.com/a",
  );
});

test("the user script finds the same sister-wiki citation as the core", () => {
  const fromScript = script.findWikiCandidates(scriptCorpus(true), 0);
  const fromCore = findWikiCandidates(coreCorpus, coreClaims[0]);
  assert.equal(fromScript[0].url, fromCore[0].url);
  assert.equal(fromScript[0].evidence.origin, "sister-wiki");
  assert.deepEqual(
    fromScript[0].evidence.matchedAnchors?.slice().sort(),
    fromCore[0].evidence.matchedAnchors?.slice().sort(),
  );
});

test("the user script re-uses an existing named ref for a same-article hit", () => {
  const local = script
    .findWikiCandidates(scriptCorpus(false), 0)
    .filter((c) => c.evidence.origin === "same-article");
  assert.ok(local.length > 0);
  assert.equal(local[0].ref, '<ref name="registry" />');
});

test("the user script also excludes a same-paragraph reference for a different fact", () => {
  const found = script.findWikiCandidates(scriptCorpus(false), 0);
  assert.ok(!found.some((c) => c.url === "https://harbourtimes.example.com/1963-automation"));
});

test("both implementations rank and score the same candidates the same way", () => {
  for (let i = 0; i < coreClaims.length; i++) {
    const fromScript = script.findWikiCandidates(scriptCorpus(true), i);
    const fromCore = findWikiCandidates(coreCorpus, coreClaims[i]);
    assert.deepEqual(
      fromScript.map((c) => [c.url, c.evidence.origin, c.evidence.score]),
      fromCore.map((c) => [c.url, c.evidence.origin, c.evidence.score]),
      `claim ${i} should match between the user script and the core`,
    );
  }
});

test("the user script drops blocklisted domains too", () => {
  const urls = CONTEXTS.flatMap((_, i) =>
    script.findWikiCandidates(scriptCorpus(true), i).map((c) => c.url ?? ""),
  );
  assert.ok(!urls.some((u) => u.includes("dailymail")));
});

test("the user script lifts the same Wikidata reference as the core", () => {
  const fromScript = script
    .findWikiCandidates(scriptCorpus(true), 0)
    .filter((c) => c.evidence.origin === "wikidata");
  const fromCore = findWikiCandidates(coreCorpus, coreClaims[0]).filter(
    (c) => c.evidence.origin === "wikidata",
  );
  assert.ok(fromScript.length > 0, "expected the script to find a Wikidata lead");
  assert.deepEqual(
    fromScript.map((c) => [c.url, c.ref, c.evidence.score]),
    fromCore.map((c) => [c.url, c.ref, c.evidence.score]),
  );
});

test("the user script drops circular Wikidata references too", () => {
  // The light-range statement matches "21 nautical miles" but is referenced
  // only to an English Wikipedia import.
  const leads = CONTEXTS.flatMap((_, i) =>
    script.findWikiCandidates(scriptCorpus(true), i),
  );
  assert.ok(!leads.some((c) => c.evidence.statement?.property === "P2929"));
});

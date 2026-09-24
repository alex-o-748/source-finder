/**
 * Parity test for the user script's inlined copy of the wiki-local stage. See
 * `userscriptLoader.ts` for why this exists and how the script is loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractClaims } from "../src/core/extractClaims.js";
import { extractWikilinks, paragraphRangeAt } from "../src/core/wikitext.js";
import { buildWikiCorpus, findWikiCandidates } from "../src/core/wikiSources.js";
import type { Article } from "../src/core/types.js";
import { loadUserScript } from "./userscriptLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures/wiki", name), "utf8");
}

const EN = fixture("en_lighthouse.wikitext");
const DE = fixture("de_lighthouse.wikitext");

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
    claimOffsets: script.citationNeededOffsets(EN),
    warnings: [],
  };
}

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

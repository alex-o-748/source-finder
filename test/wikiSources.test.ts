import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractClaims } from "../src/core/extractClaims.js";
import { buildWikiCorpus, findWikiCandidates } from "../src/core/wikiSources.js";
import type { Article, Claim } from "../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures/wiki", name), "utf8");
}

const EN = fixture("en_lighthouse.wikitext");
const DE = fixture("de_lighthouse.wikitext");
const JA = fixture("ja_lighthouse.wikitext");

const article: Article = {
  title: "Karsten Point Lighthouse",
  lang: "en",
  revid: 1,
  wikitext: EN,
  url: "https://en.wikipedia.org/wiki/Karsten_Point_Lighthouse",
};

const LINKS = new Map([
  ["Fyrland", new Map([["de", "Fyrland"], ["ja", "フュルラン"]])],
  ["Anna Berg", new Map([["de", "Anna Berg"], ["ja", "アンナ・ベリ"]])],
]);

const claims = extractClaims(EN);
const heightClaim = claims[0];
const keeperClaim = claims[1];

function corpusWith(...sisters: { lang: string; title: string; wikitext: string }[]) {
  return buildWikiCorpus(article, sisters, LINKS);
}

test("the fixture article yields the two tagged claims", () => {
  assert.equal(claims.length, 2);
  assert.match(heightClaim.claim, /41 metres tall/);
  assert.match(keeperClaim.claim, /Nils Haugen/);
});

test("same-article pass surfaces a reference from the claim's own paragraph", () => {
  const found = findWikiCandidates(corpusWith(), heightClaim);
  const local = found.filter((c) => c.evidence.origin === "same-article");
  assert.ok(local.length > 0, "expected at least one same-article lead");
  assert.equal(local[0].url, "https://harbourtimes.example.com/1963-automation");
  assert.match(local[0].relevance, /already cited in this article/);
});

test("a same-article lead re-uses the existing named ref, the smallest edit", () => {
  const [top] = findWikiCandidates(corpusWith(), heightClaim).filter(
    (c) => c.evidence.origin === "same-article",
  );
  assert.equal(top.ref, '<ref name="auto" />');
});

test("blocklisted domains never become candidates", () => {
  const urls = claims
    .flatMap((c) => findWikiCandidates(corpusWith(), c))
    .map((c) => c.url ?? "");
  assert.ok(!urls.some((u) => u.includes("dailymail")));
});

test("sister-wiki pass lifts the citation attached to the same fact", () => {
  const found = findWikiCandidates(
    corpusWith({ lang: "de", title: "Leuchtturm Karsten Point", wikitext: DE }),
    heightClaim,
  );
  const top = found[0];
  assert.equal(top.evidence.origin, "sister-wiki");
  assert.equal(top.url, "https://leuchtturmregister.example.de/karsten");
  assert.deepEqual(top.evidence.matchedAnchors?.sort(), ["21", "41"]);
  assert.match(top.relevance, /cited on de\.wikipedia/);
});

test("a sister-wiki lead pastes the citation itself, not a name from another wiki", () => {
  const [top] = findWikiCandidates(
    corpusWith({ lang: "de", title: "Leuchtturm Karsten Point", wikitext: DE }),
    heightClaim,
  );
  assert.match(top.ref, /^<ref>\{\{cite web \|url=https:\/\/leuchtturmregister/);
  assert.doesNotMatch(top.ref, /name=/);
});

test("sister-wiki matching works across scripts, on numbers and mapped wikilinks", () => {
  const found = findWikiCandidates(
    corpusWith({ lang: "ja", title: "カルステン岬灯台", wikitext: JA }),
    heightClaim,
  );
  const japanese = found.filter((c) => c.evidence.lang === "ja");
  assert.equal(japanese.length, 1);
  assert.equal(japanese[0].url, "https://kaijo.example.jp/karsten");
  assert.deepEqual(japanese[0].evidence.matchedAnchors?.sort(), ["21", "41"]);
});

test("a claim whose facts appear nowhere on the sister wiki gets no sister lead", () => {
  const corpus = corpusWith({
    lang: "ja",
    title: "カルステン岬灯台",
    wikitext: JA,
  });
  const found = findWikiCandidates(corpus, keeperClaim);
  assert.equal(
    found.filter((c) => c.evidence.origin === "sister-wiki").length,
    0,
    "the Japanese article never mentions the keeper's dates",
  );
});

test("candidates are deduplicated by URL and ranked by match strength", () => {
  const corpus = corpusWith(
    { lang: "de", title: "Leuchtturm Karsten Point", wikitext: DE },
    { lang: "ja", title: "カルステン岬灯台", wikitext: JA },
  );
  const found = findWikiCandidates(corpus, heightClaim);
  const urls = found.map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length, "no duplicate URLs");
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].evidence.score >= found[i].evidence.score);
  }
});

test("evidence records the sentence the citation was attached to", () => {
  const [top] = findWikiCandidates(
    corpusWith({ lang: "de", title: "Leuchtturm Karsten Point", wikitext: DE }),
    heightClaim,
  );
  assert.match(top.evidence.sentence, /41 Meter hoch/);
  assert.equal(top.evidence.article, "Leuchtturm Karsten Point");
  assert.equal(top.evidence.section, "Geschichte");
});

test("with the sister pass off, the same-article pass still stands alone", () => {
  // maxSisterWikis: 0 stops the fetch, which leaves a corpus with no sisters.
  const withoutSisters = findWikiCandidates(buildWikiCorpus(article), heightClaim);
  assert.ok(withoutSisters.length > 0);
  assert.ok(withoutSisters.every((c) => c.evidence.origin === "same-article"));

  const withSisters = findWikiCandidates(
    corpusWith({ lang: "de", title: "Leuchtturm Karsten Point", wikitext: DE }),
    heightClaim,
  );
  assert.ok(withSisters.length > withoutSisters.length);
});

test("a claim with nothing to match on returns nothing rather than noise", () => {
  const vague: Claim = {
    claim: "The building is widely admired.",
    context: "The building is widely admired.",
    section: "Preservation",
    offset: EN.indexOf("A restoration fund"),
    tag: "{{cn}}",
  };
  const found = findWikiCandidates(
    corpusWith({ lang: "de", title: "Leuchtturm Karsten Point", wikitext: DE }),
    vague,
  );
  assert.equal(found.length, 0);
});

/**
 * The Wikidata pass: matching entity-attribute statements to a tagged claim,
 * and lifting the reference attached to the statement.
 *
 * The fixture entity mirrors the lighthouse article the other wiki-local tests
 * use, so the same two claims drive both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractClaims } from "../src/core/extractClaims.js";
import { buildWikiCorpus, findWikiCandidates } from "../src/core/wikiSources.js";
import type { WikidataCorpus } from "../src/core/wikiSources.js";
import {
  decodeSnak,
  isCircularReference,
  matchValue,
  quantityKeys,
  referenceToSource,
} from "../src/core/wikidata.js";
import type { WdEntity, WdReference } from "../src/core/wikidata.js";
import type { Article } from "../src/core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures/wiki", name), "utf8");
}

const EN = fixture("en_lighthouse.wikitext");
const ENTITIES = JSON.parse(fixture("wikidata_lighthouse.json")) as Record<
  string,
  WdEntity
>;

const article: Article = {
  title: "Karsten Point Lighthouse",
  lang: "en",
  revid: 1,
  wikitext: EN,
  url: "https://en.wikipedia.org/wiki/Karsten_Point_Lighthouse",
};

const LABELS = new Map([
  ["Q100", "Karsten Point Lighthouse"],
  ["Q200", "Harbour Authority Registry"],
  ["P2048", "height"],
  ["P2929", "light range"],
  ["P2044", "elevation above sea level"],
  ["P580", "start time"],
  ["P571", "inception"],
]);

const wikidata: WikidataCorpus = {
  entities: new Map(Object.entries(ENTITIES)),
  titleQids: new Map([["Karsten Point Lighthouse", "Q100"]]),
  labels: LABELS,
};

const claims = extractClaims(EN);
const heightClaim = claims[0];
const keeperClaim = claims[1];

const corpus = buildWikiCorpus(article, [], new Map(), wikidata);

function wikidataLeads(claim = heightClaim) {
  return findWikiCandidates(corpus, claim).filter(
    (c) => c.evidence.origin === "wikidata",
  );
}

// -- the pass end to end --

test("a quantity in the claim matches the statement asserting it", () => {
  const leads = wikidataLeads();
  const height = leads.find((c) => c.evidence.statement?.property === "P2048");
  assert.ok(height, "expected the height statement to match '41 metres tall'");
  assert.equal(height.url, "https://harbourauthority.example.org/registry-wd");
  assert.equal(height.evidence.score, 0.9);
  assert.equal(height.evidence.statement?.value, "41");
  assert.match(height.relevance, /cited on Wikidata \(Karsten Point Lighthouse\)/);
});

test("the lead renders the statement with its property label, not a bare P-number", () => {
  const [height] = wikidataLeads().filter(
    (c) => c.evidence.statement?.property === "P2048",
  );
  assert.equal(height.evidence.sentence, "height: 41");
  assert.equal(height.evidence.statement?.propertyLabel, "height");
});

test("the ready <ref> is a citation template carrying the reference's fields", () => {
  const [height] = wikidataLeads().filter(
    (c) => c.evidence.statement?.property === "P2048",
  );
  assert.match(height.ref, /^<ref>\{\{cite web \|/);
  assert.match(height.ref, /url=https:\/\/harbourauthority\.example\.org\/registry-wd/);
  assert.match(height.ref, /title=Harbour Authority Registry/);
  assert.match(height.ref, /access-date=2023-05-01/);
  assert.match(height.ref, /\}\}<\/ref>$/);
});

test("a statement referenced only to a Wikipedia import is dropped (WP:CIRCULAR)", () => {
  // The claim says "21 nautical miles" and the entity has that as its light
  // range — but its only reference is "imported from English Wikipedia".
  const circular = wikidataLeads().filter(
    (c) => c.evidence.statement?.property === "P2929",
  );
  assert.equal(circular.length, 0);
});

test("a reference on a deprecated domain is dropped", () => {
  const urls = wikidataLeads().map((c) => c.url);
  assert.ok(!urls.some((u) => u?.includes("dailymail")));
});

test("a deprecated statement is never a lead, even when its value matches", () => {
  const deprecated = wikidataLeads().filter(
    (c) => c.evidence.statement?.property === "P2044",
  );
  assert.equal(deprecated.length, 0);
});

test("a statement the claim does not assert produces nothing", () => {
  // Inception is 1878; neither tagged sentence mentions it.
  const all = [...wikidataLeads(heightClaim), ...wikidataLeads(keeperClaim)];
  assert.ok(!all.some((c) => c.evidence.statement?.property === "P571"));
});

test("a year-precision date matches on the year and scores below an exact figure", () => {
  const [start] = wikidataLeads(keeperClaim).filter(
    (c) => c.evidence.statement?.property === "P580",
  );
  assert.ok(start, "expected the 1901 start-time statement to match");
  assert.equal(start.evidence.score, 0.8);
  assert.deepEqual(start.evidence.matchedAnchors, ["1901"]);
});

test("a reference with no URL is still a lead when it names the work", () => {
  const [start] = wikidataLeads(keeperClaim).filter(
    (c) => c.evidence.statement?.property === "P580",
  );
  assert.equal(start.url, null);
  assert.equal(start.title, "Keeper records 1880-1930");
});

test("an article with no Wikidata corpus yields no Wikidata leads", () => {
  const bare = buildWikiCorpus(article);
  assert.equal(
    findWikiCandidates(bare, heightClaim).filter(
      (c) => c.evidence.origin === "wikidata",
    ).length,
    0,
  );
});

test("skipWikidata turns the pass off", () => {
  const leads = findWikiCandidates(corpus, heightClaim, { skipWikidata: true });
  assert.equal(leads.filter((c) => c.evidence.origin === "wikidata").length, 0);
});

// -- the pure pieces --

test("decodeSnak reads the value shapes worth matching", () => {
  const time = decodeSnak({
    snaktype: "value",
    property: "P571",
    datavalue: { value: { time: "+1889-03-31T00:00:00Z", precision: 11 }, type: "time" },
  });
  assert.deepEqual(time, {
    kind: "time",
    year: "1889",
    iso: "1889-03-31",
    precision: 11,
  });

  // Below year precision there is no figure in prose to compare against.
  const decade = decodeSnak({
    snaktype: "value",
    property: "P571",
    datavalue: { value: { time: "+1880-00-00T00:00:00Z", precision: 8 }, type: "time" },
  });
  assert.equal(decade, null);

  // "unknown value" carries no value at all.
  assert.equal(decodeSnak({ snaktype: "somevalue", property: "P571" }), null);
});

test("quantityKeys normalises the way claim anchors do", () => {
  // anchorsOf strips separators, so "1,234" is looked up as "1234".
  assert.deepEqual(quantityKeys("+1,234"), { exact: "1234", whole: "1234" });
  assert.deepEqual(quantityKeys("+324.8"), { exact: "3248", whole: "324" });
});

test("matchValue accepts a rounded figure, but scores it below an exact one", () => {
  const exact = matchValue({ kind: "quantity", amount: "+324" }, new Set(["324"]), new Set());
  const rounded = matchValue({ kind: "quantity", amount: "+324.8" }, new Set(["324"]), new Set());
  assert.equal(exact?.score, 0.9);
  assert.equal(rounded?.score, 0.75);
  assert.ok(exact!.score > rounded!.score);
});

test("matchValue ignores single digits, which prose is full of", () => {
  assert.equal(
    matchValue({ kind: "quantity", amount: "+4" }, new Set(["4"]), new Set()),
    null,
  );
});

test("matchValue resolves an item value through the paragraph's wikilinks", () => {
  const linked = new Set(["Q142"]);
  assert.equal(matchValue({ kind: "item", id: "Q142" }, new Set(), linked)?.score, 0.85);
  assert.equal(matchValue({ kind: "item", id: "Q183" }, new Set(), linked), null);
});

test("isCircularReference rejects Wikimedia imports and Wikimedia URLs", () => {
  const imported: WdReference = {
    snaks: {
      P143: [{ snaktype: "value", property: "P143", datavalue: { value: { id: "Q328" }, type: "wikibase-entityid" } }],
    },
  };
  assert.equal(isCircularReference(imported), true);

  const wikipediaUrl: WdReference = {
    snaks: {
      P854: [{ snaktype: "value", property: "P854", datavalue: { value: "https://en.wikipedia.org/wiki/Eiffel_Tower", type: "string" } }],
      P1476: [{ snaktype: "value", property: "P1476", datavalue: { value: { text: "Eiffel Tower", language: "en" }, type: "monolingualtext" } }],
    },
  };
  assert.equal(isCircularReference(wikipediaUrl), true);

  const real: WdReference = {
    snaks: {
      P854: [{ snaktype: "value", property: "P854", datavalue: { value: "https://www.lemonde.fr/article", type: "string" } }],
    },
  };
  assert.equal(isCircularReference(real), false);
});

test("referenceToSource resolves a DOI into a fetchable URL", () => {
  const source = referenceToSource({
    snaks: {
      P356: [{ snaktype: "value", property: "P356", datavalue: { value: "10.1038/nphys1170", type: "string" } }],
      P1476: [{ snaktype: "value", property: "P1476", datavalue: { value: { text: "A paper", language: "en" }, type: "monolingualtext" } }],
    },
  });
  assert.equal(source?.url, "https://doi.org/10.1038/nphys1170");
  assert.equal(source?.template, "cite journal");
  assert.match(source!.raw, /doi=10\.1038\/nphys1170/);
});

test("referenceToSource returns nothing when there is no work and no URL", () => {
  const source = referenceToSource({
    snaks: {
      P813: [{ snaktype: "value", property: "P813", datavalue: { value: { time: "+2023-05-01T00:00:00Z", precision: 11 }, type: "time" } }],
    },
  });
  assert.equal(source, null);
});

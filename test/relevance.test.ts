import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorScore,
  anchorsOf,
  coverage,
  fold,
  isLatinScript,
  normaliseDigits,
  weightedTokens,
} from "../src/core/relevance.js";

test("fold strips diacritics and case so Zürich matches Zurich", () => {
  assert.equal(fold("Zürich"), "zurich");
  assert.equal(fold("Édouard"), "edouard");
});

test("normaliseDigits maps non-ASCII numerals to ASCII", () => {
  assert.equal(normaliseDigits("١٨٨٩"), "1889");
  assert.equal(normaliseDigits("१९६३"), "1963");
});

test("anchorsOf picks out numbers and proper nouns, not sentence-initial words", () => {
  const a = anchorsOf("Later the tower in Paris reached 300 metres, in 1930.");
  assert.deepEqual(a.numbers.sort(), ["1930", "300"]);
  assert.deepEqual(a.names, ["paris"]);
});

test("anchorsOf keeps multi-word names whole and as parts", () => {
  const a = anchorsOf("It was designed by Anna Berg.");
  assert.ok(a.names.includes("anna berg"));
  assert.ok(a.names.includes("berg"));
});

test("coverage rewards shared content words and ignores unrelated text", () => {
  const query = weightedTokens(
    "It stood 300 metres tall until 1930.",
    new Set(["eiffel", "tower"]),
  );
  const good = coverage(query, "The tower reached 300 metres and held the record until 1930.");
  const bad = coverage(query, "A recipe for chocolate cake.");
  assert.ok(good > 0.6, `expected a strong match, got ${good}`);
  assert.equal(bad, 0);
});

test("background tokens are discounted so every reference does not match", () => {
  const text = "The Eiffel Tower is in Paris.";
  const plain = weightedTokens(text);
  const discounted = weightedTokens(text, new Set(["eiffel", "tower"]));
  assert.ok(
    coverage(discounted, "Eiffel Tower") < coverage(plain, "Eiffel Tower"),
  );
});

test("anchorScore matches a claim to its translation via numbers", () => {
  const query = anchorsOf("The tower is 41 metres tall and visible for 21 nautical miles.");
  const german = anchorScore(query, "Der Turm ist 41 Meter hoch und auf 21 Seemeilen sichtbar.");
  assert.equal(german.score, 1);
  assert.deepEqual(german.matched.sort(), ["21", "41"]);

  const unrelated = anchorScore(query, "Der Leuchtturm wurde 1963 automatisiert.");
  assert.equal(unrelated.score, 0);
});

test("anchorScore counts translated wikilink titles as anchors", () => {
  const query = anchorsOf("Built in 1878 on the north coast.");
  const scored = anchorScore(query, "1878 an der Nordküste von Fyrland erbaut.", ["Fyrland"]);
  assert.ok(scored.matched.includes("fyrland"));
  assert.equal(scored.score, 1);
});

test("isLatinScript separates wikis that can share proper nouns from those that cannot", () => {
  assert.equal(isLatinScript("Der Turm ist einundvierzig Meter hoch und sehr alt."), true);
  assert.equal(isLatinScript("エッフェル塔は千八百八十九年に完成した高さ三百メートルの塔である。"), false);
});

test("a grouped figure is one number, not its thousands groups", () => {
  const query = anchorsOf("In 1861, the number of inhabitants surpassed 100,000 and by 1927, had doubled.");
  assert.deepEqual(query.numbers, ["1861", "100000", "1927"]);

  for (const written of ["100,000", "100.000", "100 000"]) {
    assert.deepEqual(anchorScore(query, `a town of ${written} souls`).matched, ["100000"], written);
  }
  // "000" is no longer a claim number that any round figure matches.
  assert.deepEqual(anchorScore(query, "a garrison of 45,000 men").matched, []);
  // A comma between whole numbers is a list, not a figure.
  assert.deepEqual(anchorsOf("in 1861, 1927 and 1861,186").numbers, ["1861", "1927", "186"]);
});

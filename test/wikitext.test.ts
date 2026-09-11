import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractWikilinks,
  paragraphRanges,
  sectionRanges,
  splitSentences,
  stripWikitext,
} from "../src/core/wikitext.js";

test("stripWikitext removes refs, comments and maintenance templates", () => {
  const plain = stripWikitext(
    "It opened in 1889.<ref>{{cite web|url=https://e.org|title=A}}</ref> " +
      "It is tall.{{citation needed}}<!-- hidden -->",
  );
  assert.equal(plain, "It opened in 1889. It is tall.");
});

test("stripWikitext reduces wikilinks to their display text", () => {
  assert.equal(
    stripWikitext("Designed by [[Anna Berg|Berg]] in [[Paris]]."),
    "Designed by Berg in Paris.",
  );
  assert.equal(stripWikitext("See [[File:X.jpg|thumb|A caption]] here."), "See here.");
});

test("stripWikitext keeps the numbers inside inline value templates", () => {
  assert.match(stripWikitext("It is {{convert|300|m|ft}} tall."), /300 m/);
  assert.equal(stripWikitext("{{Infobox building |height=300 m}}Text."), "Text.");
});

test("stripWikitext unwraps external links and bold/italic markup", () => {
  assert.equal(
    stripWikitext("The '''tower''' [https://e.org/a opened] in 1889."),
    "The tower opened in 1889.",
  );
});

test("splitSentences does not split on abbreviations", () => {
  assert.deepEqual(splitSentences("The U.S. Army arrived. It stayed."), [
    "The U.S. Army arrived.",
    "It stayed.",
  ]);
});

test("splitSentences ends a sentence on CJK punctuation without a space", () => {
  assert.deepEqual(splitSentences("塔は1889年に完成した。高さは300メートルである。"), [
    "塔は1889年に完成した。",
    "高さは300メートルである。",
  ]);
});

test("sectionRanges covers each heading up to the next one of its level", () => {
  const wt = "Lead.\n\n== A ==\nalpha\n\n=== A1 ===\nsub\n\n== B ==\nbeta";
  const sections = sectionRanges(wt);
  assert.deepEqual(
    sections.map((s) => s.heading),
    ["A", "A1", "B"],
  );
  const a = sections[0];
  assert.match(wt.slice(a.start, a.end), /alpha/);
  assert.match(wt.slice(a.start, a.end), /sub/, "a subsection stays inside its parent");
  assert.doesNotMatch(wt.slice(a.start, a.end), /beta/);
});

test("paragraphRanges splits on blank lines", () => {
  const wt = "one\n\ntwo\nstill two\n\nthree";
  assert.deepEqual(
    paragraphRanges(wt).map((r) => wt.slice(r.start, r.end)),
    ["one", "two\nstill two", "three"],
  );
});

test("extractWikilinks normalises targets and skips files and categories", () => {
  assert.deepEqual(
    extractWikilinks(
      "[[Eiffel_Tower|the tower]] in [[Paris]] [[File:X.jpg]] [[Category:Y]] [[Paris#Sights]]",
    ),
    ["Eiffel Tower", "Paris"],
  );
});

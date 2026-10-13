/**
 * "Edit sentence" and "Remove sentence" open the section editor with the
 * tagged sentence selected, or already taken out, for the editor to review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const s = loadUserScript();

// en.wikipedia's Airbus, "Bribery allegations > South Africa" (refs shortened).
const AIRBUS = [
  "=== South Africa ===",
  "In 2003 [[Tony Yengeni]] was convicted of fraud.<ref>{{Cite web|title=Jailed Yengeni shows no remorse}}</ref> " +
    "It was claimed that Airbus had admitted that it had \"rendered assistance\" to around thirty senior officials.<ref>{{cite news|title=Top ANC official resigns}}</ref> " +
    "In March 2003, South Africa withdrew all charges of bribery against the former head of EADS South Africa,<ref>{{cite web|title=Court Diary}}</ref> " +
    "and in September 2004, the prosecutor's office dismissed the bribery charges against Yengeni.{{citation needed|date=March 2020}}",
  "",
  "=== Saudi Arabia ===",
  "In August 2012 the UK's [[Serious Fraud Office]] opened a criminal investigation.",
].join("\n");

test("the selected span is the tagged sentence, with its mid-sentence ref and the tag", () => {
  const span = s.taggedSentenceSpan(AIRBUS, 0);
  assert.equal(
    AIRBUS.slice(span.start, span.end),
    "In March 2003, South Africa withdrew all charges of bribery against the former head of EADS South Africa,<ref>{{cite web|title=Court Diary}}</ref> " +
      "and in September 2004, the prosecutor's office dismissed the bribery charges against Yengeni.{{citation needed|date=March 2020}}",
  );
});

test("removing the last sentence of a paragraph leaves no trailing space", () => {
  const cut = s.removeTaggedSentence(AIRBUS, 0);
  assert.equal(cut.removed, true);
  assert.ok(cut.text.includes("senior officials.<ref>{{cite news|title=Top ANC official resigns}}</ref>\n\n=== Saudi Arabia ==="));
  assert.ok(!cut.text.includes("Yengeni.{{citation"));
  assert.ok(!cut.text.includes("Court Diary"));
  assert.deepEqual(cut.namedRefs, []);
});

test("removing a sentence mid-paragraph keeps one space between its neighbours", () => {
  const text = "First claim.<ref>a</ref> Second claim.{{cn}} Third claim.";
  assert.equal(s.removeTaggedSentence(text, 0).text, "First claim.<ref>a</ref> Third claim.");
});

test("removing the first sentence of a paragraph keeps the heading and the rest", () => {
  const text = "== H ==\n{{Main|X}}\nUnsourced claim.{{cn}} Sourced claim.<ref>a</ref>\n\nNext.";
  assert.equal(s.removeTaggedSentence(text, 0).text, "== H ==\n{{Main|X}}\nSourced claim.<ref>a</ref>\n\nNext.");
});

test("a one-sentence paragraph goes with its blank line", () => {
  const text = "Before.\n\nOnly claim.{{citation needed}}\n\nAfter.";
  assert.equal(s.removeTaggedSentence(text, 0).text, "Before.\n\nAfter.");
});

test("picks the Nth tag and reports a named reference defined in the sentence", () => {
  const text = "One.{{cn}} Two, per <ref name=\"two\">x</ref> someone.{{fact}} Three.<ref name=\"two\" />";
  const cut = s.removeTaggedSentence(text, 1);
  assert.equal(cut.text, "One.{{cn}} Three.<ref name=\"two\" />");
  assert.deepEqual(cut.namedRefs, ["two"]);
});

test("a missing tag removes nothing", () => {
  const cut = s.removeTaggedSentence("No tags here.", 0);
  assert.equal(cut.removed, false);
  assert.equal(s.taggedSentenceSpan("No tags here.", 0), null);
});

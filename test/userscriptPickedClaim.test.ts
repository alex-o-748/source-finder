/**
 * A claim picked from a selection has no {{citation needed}} tag to count, so
 * its place in the wikitext is found by its words, and its <ref> goes after
 * the punctuation and footnotes that follow them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

const s = loadUserScript();

/** The wikitext with the <ref> put where a picked claim's would go. */
function citeAfter(wikitext: string, claim: string, before = "", ref = "<ref>NEW</ref>"): string | null {
  const found = s.locateClaimText(wikitext, claim, before);
  if (!found) return null;
  const at = s.citationPointAfter(wikitext, found.end);
  return wikitext.slice(0, at) + ref + wikitext.slice(at);
}

test("a whole sentence is cited after its full stop", () => {
  const text = "Eiffel initially showed little enthusiasm, but he did approve further study. The two engineers then asked.";
  assert.equal(
    citeAfter(text, "Eiffel initially showed little enthusiasm, but he did approve further study."),
    "Eiffel initially showed little enthusiasm, but he did approve further study.<ref>NEW</ref> The two engineers then asked.",
  );
});

test("link markup, comments and footnotes already there are stepped over", () => {
  const text =
    "It came from the [[Latting Observatory]] built in [[New York City|New York]]<!-- sic --> in 1853." +
    '<ref name="a">A.</ref>{{sfn|Loyrette|1985|p=116}}<ref name="b" /> Next sentence.';
  assert.equal(
    citeAfter(text, "built in New York in 1853"),
    "It came from the [[Latting Observatory]] built in [[New York City|New York]]<!-- sic --> in 1853." +
      '<ref name="a">A.</ref>{{sfn|Loyrette|1985|p=116}}<ref name="b" /><ref>NEW</ref> Next sentence.',
  );
});

test("a fact inside a sentence is cited where it ends, after a comma but never past a space", () => {
  const text = "The design is attributed to Koechlin and Nouguier, two senior engineers working for Eiffel.";
  assert.equal(
    citeAfter(text, "attributed to Koechlin and Nouguier"),
    "The design is attributed to Koechlin and Nouguier,<ref>NEW</ref> two senior engineers working for Eiffel.",
  );
  assert.equal(
    citeAfter(text, "two senior engineers"),
    "The design is attributed to Koechlin and Nouguier, two senior engineers<ref>NEW</ref> working for Eiffel.",
  );
});

test("closing italics and quotes stay with the text they close", () => {
  const text = "It was first reported in ''Le Figaro''. Later, \"it opened to visitors\".<ref>x</ref>";
  assert.equal(citeAfter(text, "first reported in Le Figaro"),
    "It was first reported in ''Le Figaro''.<ref>NEW</ref> Later, \"it opened to visitors\".<ref>x</ref>");
  assert.equal(citeAfter(text, "Later, “it opened to visitors”"),
    "It was first reported in ''Le Figaro''. Later, \"it opened to visitors\".<ref>x</ref><ref>NEW</ref>");
});

test("the same words twice are told apart by the text just before them, or not cited at all", () => {
  const text = "In 1889 the tower opened to visitors. A rival, in 1890, the tower opened to visitors too.";
  assert.equal(s.locateClaimText(text, "the tower opened to visitors", ""), null);
  assert.equal(
    citeAfter(text, "the tower opened to visitors", "A rival, in 1890,"),
    "In 1889 the tower opened to visitors. A rival, in 1890, the tower opened to visitors<ref>NEW</ref> too.",
  );
});

test("text from a template is matched by the claim's last words", () => {
  const text = "The tower is {{convert|300|m}} tall and was finished in March 1889. Next.";
  const found = s.locateClaimText(text, "The tower is 300 metres (980 ft) tall and was finished in March 1889", "");
  assert.ok(found);
  assert.equal(found.start, null);
  assert.equal(text.slice(0, s.citationPointAfter(text, found.end)), "The tower is {{convert|300|m}} tall and was finished in March 1889.");
});

test("text that is not in the wikitext is not placed", () => {
  assert.equal(s.locateClaimText("Nothing like it here.", "The tower opened in 1889", ""), null);
  assert.equal(s.locateClaimText("Anything.", "", ""), null);
});

test("a template that is not a footnote ends the step-over", () => {
  const text = "It opened in 1889.{{better source needed|date=May 2024}} Next.";
  assert.equal(citeAfter(text, "It opened in 1889"), "It opened in 1889.<ref>NEW</ref>{{better source needed|date=May 2024}} Next.");
});

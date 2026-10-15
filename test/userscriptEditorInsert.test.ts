/**
 * "Insert in editor" opens the editor in a new tab, so the <ref> is handed
 * over through localStorage (sessionStorage is per tab) under a one-time token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUserScript } from "./userscriptLoader.js";

test("a staged <ref> is read once, by its token", () => {
  const s = loadUserScript();
  const payload = { pageTitle: "Eiffel_Tower", ref: "<ref>{{cite web |url=x}}</ref>", cnIndexInSection: 0, stagedAt: Date.now() };
  assert.equal(s.writeStagedInsert("abc", payload), true);
  assert.equal(s.takeStagedInsert("other"), null);
  assert.deepEqual(s.takeStagedInsert("abc"), payload);
  assert.equal(s.takeStagedInsert("abc"), null);
});

test("staging drops <ref>s nobody picked up, once they are old", () => {
  const s = loadUserScript();
  const ref = "<ref>x</ref>";
  s.storage.setItem("cnfirmed:pending-insert:stale", JSON.stringify({ ref, stagedAt: Date.now() - 11 * 60 * 1000 }));
  s.storage.setItem("cnfirmed:pending-insert:broken", "{");
  s.storage.setItem("cnfirmed:pending-insert:recent", JSON.stringify({ ref, stagedAt: Date.now() - 60 * 1000 }));
  s.storage.setItem("cnfirmed-key-claude", "sk-keep");
  s.writeStagedInsert("new", { ref, stagedAt: Date.now() });
  const keys = Array.from({ length: s.storage.length }, (_, n) => s.storage.key(n)).sort();
  assert.deepEqual(keys, ["cnfirmed-key-claude", "cnfirmed:pending-insert:new", "cnfirmed:pending-insert:recent"]);
});

// The page finds tags by <sup class="Template-Fact">, which other sourcing
// templates render too; the editor has to count them the same way.
test("the <ref> replaces the Nth tag of any template the page counts, not only {{citation needed}}", () => {
  const s = loadUserScript();
  const text = "One.{{Better source needed|date=May 2024}} Two.{{cn}} Three.{{Medcn}} Four.{{Primary source inline}}";
  const ref = "<ref>R</ref>";
  assert.equal(s.citationNeededOffsets(text).length, 4);
  assert.equal(s.replaceNthCitationNeeded(text, 0, ref).text,
    "One.<ref>R</ref> Two.{{cn}} Three.{{Medcn}} Four.{{Primary source inline}}");
  assert.equal(s.replaceNthCitationNeeded(text, 2, ref).text,
    "One.{{Better source needed|date=May 2024}} Two.{{cn}} Three.<ref>R</ref> Four.{{Primary source inline}}");
});

test("a {{Citation needed span}} keeps the text it wraps, with the <ref> after it", () => {
  const s = loadUserScript();
  const text = "A. {{cn span|text=The claim itself.|date=May 2024}} B.";
  const result = s.replaceNthCitationNeeded(text, 0, "<ref>R</ref>");
  assert.equal(result.text, "A. The claim itself.<ref>R</ref> B.");
  assert.equal(result.text.slice(result.replacementStart, result.replacementStart + 12), "<ref>R</ref>");
});

test("tags the page does not render as [citation needed] are not counted", () => {
  const s = loadUserScript();
  const text = "One.{{Failed verification}} Two.{{Dubious}} Three.{{cn}}";
  assert.equal(s.replaceNthCitationNeeded(text, 0, "<ref>R</ref>").text, "One.{{Failed verification}} Two.{{Dubious}} Three.<ref>R</ref>");
});

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

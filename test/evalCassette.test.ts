/**
 * The evaluation's record-and-replay layer: requests that ask the same thing
 * must share a recording, and a transient failure must never be recorded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCassette, isTransient, requestKey } from "../eval/lib/http.js";

test("the core and the user script share a recording for the same query", () => {
  // The core puts format/formatversion/origin first; the user script builds
  // its own order. `origin` changes nothing about the answer.
  const core =
    "https://en.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*&action=query&prop=revisions&titles=Silvae";
  const script =
    "https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=Silvae&format=json&formatversion=2";
  assert.equal(requestKey(core), requestKey(script));
  assert.notEqual(
    requestKey(core),
    requestKey(core.replace("Silvae", "Statius")),
  );
});

test("rate limits and the Archive's backend failures are transient", () => {
  assert.equal(isTransient(429, ""), true);
  assert.equal(isTransient(503, ""), true);
  assert.equal(
    isTransient(400, '{"error":{"message":"The search backend encountered an exception"}}'),
    true,
  );
  assert.equal(isTransient(400, '{"error":"bad query"}'), false);
  assert.equal(isTransient(404, ""), false);
});

test("replay serves what was recorded and refuses what was not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cassette-"));
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    installCassette({ dir, mode: "record", minIntervalMs: 0 });
    const first = await fetch("https://archive.org/metadata/x?b=2&a=1");
    assert.deepEqual(await first.json(), { ok: true });

    installCassette({ dir, mode: "replay" });
    const again = await fetch("https://archive.org/metadata/x?a=1&b=2");
    assert.deepEqual(await again.json(), { ok: true });
    assert.equal(calls, 1, "the replay did not touch the network");
    await assert.rejects(fetch("https://archive.org/metadata/y"), /not recorded/);
  } finally {
    globalThis.fetch = real;
  }
});

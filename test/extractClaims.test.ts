import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractClaims } from "../src/core/extractClaims.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, "fixtures/simple.wikitext"),
  "utf8",
);

test("extractClaims finds every {{cn}}-family tag in the fixture", () => {
  const claims = extractClaims(fixture);
  assert.equal(claims.length, 3, "expected 3 tagged claims");
});

test("extractClaims captures the sentence immediately preceding the tag", () => {
  const claims = extractClaims(fixture);
  const first = claims[0];
  assert.match(
    first.claim,
    /300 metres tall when first built\./,
    `claim was: ${first.claim}`,
  );
});

test("extractClaims attaches the correct section heading", () => {
  const claims = extractClaims(fixture);
  assert.equal(claims[0].section, "History");
  assert.equal(claims[1].section, "History");
  assert.equal(claims[2].section, "Design");
});

test("extractClaims recognises the {{cn}}, {{citation needed}}, and {{fact}} aliases", () => {
  const claims = extractClaims(fixture);
  const tags = claims.map((c) => c.tag.toLowerCase());
  assert.ok(tags.some((t) => t.startsWith("{{cn")));
  assert.ok(tags.some((t) => t.startsWith("{{citation needed")));
  assert.ok(tags.some((t) => t.startsWith("{{fact")));
});

test("extractClaims offsets point at the literal tag in the wikitext", () => {
  const claims = extractClaims(fixture);
  for (const c of claims) {
    assert.equal(fixture.slice(c.offset, c.offset + c.tag.length), c.tag);
  }
});

test("extractClaims recognises {{Citation needed}} redirect family", () => {
  const samples = [
    "Claim one.{{Cn}}",
    "Claim two.{{Cb}}",
    "Claim three.{{Citation_needed|date=May 2024}}",
    "Claim four.{{citation-needed}}",
    "Claim five.{{citationneeded}}",
    "Claim six.{{Cite needed}}",
    "Claim seven.{{Ref-needed}}",
    "Claim eight.{{needs citation}}",
    "Claim nine.{{Need citation}}",
    "Claim ten.{{citation requested}}",
    "Claim eleven.{{Source needed}}",
    "Claim twelve.{{subst:Citation needed}}",
  ];
  for (const s of samples) {
    const claims = extractClaims(s);
    assert.equal(claims.length, 1, `failed to match: ${s}`);
  }
});

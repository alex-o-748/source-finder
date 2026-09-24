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

test("a decimal figure does not end the claim sentence", () => {
  // "297.8" was read as a sentence boundary, truncating the claim to
  // "8 square kilometres." — discarding the figure the sentence is about
  // before any source pass, or the model, could use it.
  const [claim] = extractClaims(
    "The borough covers 297.8 square kilometres.{{cn}}\n",
  );
  assert.equal(claim.claim, "The borough covers 297.8 square kilometres.");
});

test("a genuine sentence boundary before a figure still splits", () => {
  const [claim] = extractClaims(
    "The harbour opened in 1861. 297 ships called that year.{{cn}}\n",
  );
  assert.equal(claim.claim, "297 ships called that year.");
});

test("the previous sentence's {{cn}} tag is not part of the next claim", () => {
  // Every search for the second claim was built on "May 2024", the tag's date.
  const claims = extractClaims(
    "The tower opened in 1889.{{citation needed|date=May 2024}} It was popular.{{cn}}\n",
  );
  assert.deepEqual(
    claims.map((c) => c.claim),
    ["The tower opened in 1889.", "It was popular."],
  );
  assert.equal(claims[1].context, "The tower opened in 1889. It was popular.");
});

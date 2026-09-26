/**
 * The sentence a {{citation needed}} tag is on, and the references attached to
 * it: those are the ones an editor already judged not enough.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { taggedSentenceRange } from "../src/core/wikitext.js";

const TAG = "{{citation needed|date=May 2020}}";

/** The wikitext the range covers for the first tag in `text`. */
function own(text: string): string {
  const at = text.indexOf(TAG);
  const r = taggedSentenceRange(text, at, at + TAG.length);
  return text.slice(r.start, r.end);
}

const PREV = 'It opened in 1889.<ref name="prev">Prev</ref> ';

test("a ref just before the tag belongs to the tagged sentence", () => {
  const span = own(`${PREV}In 2015 it made a film.<ref>Telegraph</ref>${TAG} Next one.<ref>Next</ref>`);
  assert.ok(span.includes("Telegraph"));
  assert.ok(!span.includes("Prev"), "the previous sentence's ref stays out");
  assert.ok(!span.includes("Next"), "the next sentence's ref stays out");
});

test("a ref right after the tag belongs to it", () => {
  const span = own(`${PREV}The novel is about warming.${TAG}<ref>Kirkus</ref> Other text.<ref>Other</ref>`);
  assert.ok(span.includes("Kirkus"));
  assert.ok(!span.includes("Other"));
});

test("a tag in mid-sentence covers the sentence to its end", () => {
  const span = own(
    `${PREV}The communists blamed it for the events of January 1905,${TAG} when troops fired.<ref>Salisbury</ref> Later.<ref>Later</ref>`,
  );
  assert.ok(span.includes("Salisbury"));
  assert.ok(!span.includes("Later"));
});

test("a ref earlier in the same sentence belongs to it", () => {
  const span = own(`${PREV}They filed in July 2024,<ref>Fightful</ref> and it ended on 2 August.${TAG}`);
  assert.ok(span.includes("Fightful"));
  assert.ok(!span.includes("Prev"));
});

test("abbreviations, initials and decimals do not end the sentence", () => {
  const span = own(`${PREV}Paintings by Franz A. Bischoff and 2.5 more by St. John,<ref>Art</ref> hang there.${TAG}`);
  assert.ok(span.includes("Art"));
  assert.ok(!span.includes("Prev"));
});

test("a cited sentence ends at its full stop even if the next starts lowercase", () => {
  const span = own(`He joined eMusement in 2001.<ref>IGN</ref> eMusement was later shut down.${TAG}`);
  assert.ok(!span.includes("IGN"));
});

test("a full stop inside a citation is not a sentence end", () => {
  const span = own(
    `First fact.<ref>{{cite web|url=https://e.org/a.html|title=A. B. C.}}</ref> Second fact, cited,<ref>Mid</ref> and more${TAG}. After.<ref>After</ref>`,
  );
  assert.ok(span.includes("Mid"));
  assert.ok(!span.includes("cite web"));
  assert.ok(!span.includes("After"));
});

test("the user script finds the same span as the core", async () => {
  const { loadUserScript } = await import("./userscriptLoader.js");
  const script = loadUserScript();
  const cases = [
    `${PREV}In 2015 it made a film.<ref>Telegraph</ref>${TAG} Next one.<ref>Next</ref>`,
    `${PREV}The communists blamed it for the events of January 1905,${TAG} when troops fired.<ref>Salisbury</ref> Later.`,
    `${PREV}Paintings by Franz A. Bischoff and 2.5 more by St. John,<ref>Art</ref> hang there.${TAG}`,
  ];
  for (const text of cases) {
    const at = text.indexOf(TAG);
    assert.deepEqual(
      script.taggedSentenceRange(text, at, at + TAG.length),
      taggedSentenceRange(text, at, at + TAG.length),
    );
  }
});

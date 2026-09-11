import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRefs, refToSource, resolveRefs } from "../src/core/wikitextRefs.js";

test("parseRefs finds inline, named, and self-closing refs", () => {
  const wt =
    'A.<ref>one</ref> B.<ref name="x">two</ref> C.<ref name="x" /> D.<ref name=y>three</ref>';
  const refs = parseRefs(wt);
  assert.equal(refs.length, 4);
  assert.deepEqual(
    refs.map((r) => [r.name, r.content, r.reuse]),
    [
      [null, "one", false],
      ["x", "two", false],
      ["x", "", true],
      ["y", "three", false],
    ],
  );
});

test("parseRefs offsets and ends bracket the literal tag", () => {
  const wt = 'Claim.<ref name="a">body</ref> More.';
  const [ref] = parseRefs(wt);
  assert.equal(wt.slice(ref.offset, ref.end), '<ref name="a">body</ref>');
});

test("parseRefs tolerates a slash inside a quoted attribute", () => {
  const refs = parseRefs('X.<ref name="a/b">body</ref>');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "a/b");
  assert.equal(refs[0].reuse, false);
});

test("parseRefs marks list-defined references as definition-only", () => {
  const wt = [
    'Claim.<ref name="ldr" /> More.',
    "",
    "== References ==",
    '{{reflist|refs=',
    '<ref name="ldr">{{cite web |url=https://example.org/a |title=A}}</ref>',
    "}}",
  ].join("\n");
  const refs = parseRefs(wt);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].definitionOnly, false, "the use site is not a definition");
  assert.equal(refs[1].definitionOnly, true, "the {{reflist}} body is");
});

test("parseRefs marks refs inside <references> as definition-only", () => {
  const wt = [
    'Claim.<ref name="a" />',
    "",
    '<references>',
    '<ref name="a">{{cite web |url=https://example.org/a |title=A}}</ref>',
    "</references>",
  ].join("\n");
  const refs = parseRefs(wt);
  assert.deepEqual(
    refs.map((r) => r.definitionOnly),
    [false, true],
  );
});

test("resolveRefs gives a self-closing re-use the body it points at", () => {
  const wt = 'A.<ref name="x">{{cite web |url=https://e.org/a |title=A}}</ref> B.<ref name="x" />';
  const resolved = resolveRefs(parseRefs(wt));
  assert.equal(resolved[1].resolvedContent, resolved[0].content);
  assert.equal(refToSource(resolved[1].resolvedContent)?.url, "https://e.org/a");
});

test("refToSource reads a cite template's url, title, work and quote", () => {
  const source = refToSource(
    "{{cite news |url=https://ex.com/a |title=Headline |work=The Paper |date=1963-06-04 |quote=It opened in 1878.}}",
  );
  assert.equal(source?.url, "https://ex.com/a");
  assert.equal(source?.title, "Headline");
  assert.equal(source?.work, "The Paper");
  assert.equal(source?.date, "1963-06-04");
  assert.equal(source?.quote, "It opened in 1878.");
  assert.equal(source?.template, "cite news");
});

test("refToSource joins last/first into one author", () => {
  const source = refToSource("{{cite book |last=Berg |first=Anna |title=Lighthouses}}");
  assert.equal(source?.author, "Berg, Anna");
});

test("refToSource synthesises a URL from an identifier", () => {
  assert.equal(
    refToSource("{{cite journal |title=A |doi=10.1000/xyz}}")?.url,
    "https://doi.org/10.1000/xyz",
  );
  assert.equal(
    refToSource("{{cite journal |title=A |pmid=12345}}")?.url,
    "https://pubmed.ncbi.nlm.nih.gov/12345/",
  );
});

test("refToSource prefers the archive when the original is marked dead", () => {
  const dead = refToSource(
    "{{cite web |url=https://gone.example/a |archive-url=https://web.archive.org/x |url-status=dead |title=A}}",
  );
  assert.equal(dead?.url, "https://web.archive.org/x");
  const live = refToSource(
    "{{cite web |url=https://here.example/a |archive-url=https://web.archive.org/x |url-status=live |title=A}}",
  );
  assert.equal(live?.url, "https://here.example/a");
});

test("refToSource handles bare and bracketed external links", () => {
  assert.equal(refToSource("https://example.org/bare")?.url, "https://example.org/bare");
  const bracketed = refToSource("[https://example.net/x Bracketed title]");
  assert.equal(bracketed?.url, "https://example.net/x");
  assert.equal(bracketed?.title, "Bracketed title");
});

test("refToSource reads citation templates from other language editions", () => {
  const de = refToSource(
    "{{Internetquelle |url=https://x.de/a |titel=Der Titel |hrsg=Amt |datum=2020-01-02}}",
  );
  assert.equal(de?.url, "https://x.de/a");
  assert.equal(de?.title, "Der Titel");
  assert.equal(de?.work, "Amt");
  assert.equal(de?.date, "2020-01-02");

  const fr = refToSource(
    "{{Lien web |lien=https://x.fr/a |titre=Le Titre |auteur=Dupont}}",
  );
  assert.equal(fr?.url, "https://x.fr/a");
  assert.equal(fr?.title, "Le Titre");
  assert.equal(fr?.author, "Dupont");
});

test("refToSource flags shortened footnotes, which have no URL of their own", () => {
  const sfn = refToSource("{{sfn|Smith|2003|p=45}}");
  assert.equal(sfn?.shortFootnote, true);
  assert.equal(sfn?.url, null);
  assert.equal(sfn?.author, "Smith");
});

test("refToSource keeps free-form citation prose as an unlinked lead", () => {
  const source = refToSource("Smith, John. ''A Book''. Penguin, 1998.");
  assert.equal(source?.url, null);
  assert.match(source?.title ?? "", /Smith, John\. A Book\. Penguin, 1998\./);
});

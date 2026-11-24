/**
 * Which of an article's {{citation needed}} claims a piece of rendered text is
 * about.
 *
 * Citation Hunt shows a paragraph (its "snippet", rendered HTML) and knows the
 * article's page id, but its snippet ids are hashes of that HTML and change
 * with any edit to the paragraph. So the hints are stored per page, one entry
 * per claim, and a request is matched to a claim by text: the claim's sentence
 * is in the snippet.
 */

import { fold } from "../core/relevance.js";
import { stripWikitext } from "../core/wikitext.js";

/** Letters and digits only, folded for case and diacritics, single-spaced. */
export function normalizeText(text: string): string {
  return fold(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#160": " ",
  "#39": "'",
};

/** Rendered HTML (or plain text) → plain text. Footnote markers are left in: matching ignores them. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, name: string) => {
      const known = ENTITIES[name.toLowerCase()];
      if (known !== undefined) return known;
      const code = /^#x([0-9a-f]+)$/i.exec(name)?.[1] ?? /^#(\d+)$/.exec(name)?.[1];
      if (!code) return m;
      return String.fromCodePoint(parseInt(code, name[1] === "x" || name[1] === "X" ? 16 : 10));
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** A claim's wikitext as a reader sees it: links, italics and templates gone. */
export function claimProse(claimWikitext: string): string {
  return stripWikitext(claimWikitext).replace(/\s+/g, " ").trim();
}

/** Below this many words, a claim must appear whole in the text: a few common words prove nothing. */
const MIN_WORDS_FOR_OVERLAP = 6;
/** Share of a claim's words the text must hold when the claim is not found whole. */
const MIN_OVERLAP = 0.85;

/**
 * Does `text` show this claim? Yes when the claim's sentence is in it word for
 * word (after normalising), or, for a claim of six words or more, when nearly
 * all of its words are (the paragraph was edited a little since the hints
 * were computed, or a template rendered differently).
 */
export function textShowsClaim(text: string, prose: string): boolean {
  const t = normalizeText(text);
  const c = normalizeText(prose);
  if (!c) return false;
  if (` ${t} `.includes(` ${c} `)) return true;
  const claimWords = c.split(" ");
  if (claimWords.length < MIN_WORDS_FOR_OVERLAP) return false;
  const textWords = new Set(t.split(" "));
  const found = claimWords.filter((w) => textWords.has(w)).length;
  return found / claimWords.length >= MIN_OVERLAP;
}

/** The claims, in order, that `text` shows. */
export function matchClaims<T extends { claim: string }>(claims: T[], text: string): T[] {
  const plain = htmlToText(text);
  return claims.filter((c) => textShowsClaim(plain, c.claim));
}

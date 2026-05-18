import type { Claim } from "./types.js";

/**
 * Matches a {{citation needed}}-style template call, covering the redirects
 * that render as <sup class="Template-Fact"> on en.wikipedia.
 *
 * Intentionally does not handle nested templates inside the parameters
 * ({{cn|reason={{foo}}}}) — rare in practice, and the match still succeeds
 * on the outer tag because we stop at the first `}}`.
 */
const CN_REGEX =
  /\{\{\s*(?:safesubst:|subst:)?\s*(cn|cb|fact|citation[ _-]?needed|cite[ _-]?needed|ref[ _-]?needed|needs?[ _-]citation|citation[ _-]requested|source[ _-]?needed|needs?[ _-]source|cn[ _-]needed)(?:\s*\|[^{}]*)?\s*\}\}/gi;

/** Matches MediaWiki section headings: == Section ==, === Subsection ===, etc. */
const HEADING_REGEX = /^(={2,6})\s*([^=\n][^\n]*?)\s*\1\s*$/gm;

/**
 * Locates the character offset of the start of the paragraph containing `pos`.
 * A paragraph is bounded by blank lines or headings.
 */
function paragraphStart(wikitext: string, pos: number): number {
  // Look for the nearest \n\n before pos.
  const blank = wikitext.lastIndexOf("\n\n", pos);
  const heading = lastHeadingEnd(wikitext, pos);
  return Math.max(blank === -1 ? 0 : blank + 2, heading);
}

/** Returns the offset immediately after the nearest preceding heading line. */
function lastHeadingEnd(wikitext: string, pos: number): number {
  // Search backward for a line that looks like a heading.
  // Cheaper than regex over the full buffer: scan line starts backward.
  let i = pos;
  while (i > 0) {
    const nl = wikitext.lastIndexOf("\n", i - 1);
    const lineStart = nl === -1 ? 0 : nl + 1;
    const lineEnd = wikitext.indexOf("\n", lineStart);
    const line = wikitext.slice(lineStart, lineEnd === -1 ? pos : lineEnd);
    if (/^={2,6}\s*[^=\n].*?\s*={2,6}\s*$/.test(line)) {
      return (lineEnd === -1 ? wikitext.length : lineEnd) + 1;
    }
    if (nl === -1) return 0;
    i = nl;
  }
  return 0;
}

/** Returns the most recent section heading text preceding `pos`, or null. */
function sectionFor(wikitext: string, pos: number): string | null {
  HEADING_REGEX.lastIndex = 0;
  let current: string | null = null;
  for (;;) {
    const m = HEADING_REGEX.exec(wikitext);
    if (!m || m.index >= pos) break;
    current = m[2].trim();
  }
  return current;
}

/**
 * Given a paragraph and the offset (within that paragraph) where the {{cn}}
 * tag starts, return the substring that represents the claim being cited.
 *
 * Heuristic: the claim ends just before the {{cn}} tag and begins at the last
 * sentence-ending punctuation (.!?) before that point — or the paragraph start
 * if none. Punctuation at the very end (immediately before {{cn}}) is part of
 * the claim, not a boundary.
 */
function claimFromParagraph(paragraph: string, cnOffset: number): string {
  // End of the claim = position just before the {{cn}} tag, trimming spaces.
  let end = cnOffset;
  while (end > 0 && /\s/.test(paragraph[end - 1])) end--;

  // Walk back to find a prior sentence boundary (but skip the one that ends
  // the current claim — i.e. the punctuation immediately before {{cn}}).
  let start = 0;
  // Skip trailing punctuation attached to the claim.
  let probe = end;
  while (probe > 0 && /[.!?]/.test(paragraph[probe - 1])) probe--;
  // Now find the previous sentence end before `probe`.
  for (let i = probe - 1; i > 0; i--) {
    const ch = paragraph[i];
    if (ch === "." || ch === "!" || ch === "?") {
      // Avoid splitting on common abbreviations like "U.S." or "Dr." — if the
      // next char is lowercase or another period, keep scanning.
      const next = paragraph[i + 1] ?? "";
      const prev = paragraph[i - 1] ?? "";
      if (next === "." || /[A-Z]/.test(prev) === false || /\s/.test(next)) {
        start = i + 1;
        break;
      }
    }
  }

  return paragraph.slice(start, end).trim();
}

/** Strips common wikitext noise (refs, comments) from a slice for readability. */
function cleanForDisplay(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scans wikitext for {{citation needed}}-family tags and returns, for each, the
 * sentence being cited plus paragraph context and section.
 */
export function extractClaims(wikitext: string): Claim[] {
  const claims: Claim[] = [];
  CN_REGEX.lastIndex = 0;
  for (;;) {
    const m = CN_REGEX.exec(wikitext);
    if (!m) break;
    const tag = m[0];
    const offset = m.index;

    const paraStart = paragraphStart(wikitext, offset);
    // Paragraph ends at the next blank line or heading after offset.
    const nextBlank = wikitext.indexOf("\n\n", offset);
    const paraEnd = nextBlank === -1 ? wikitext.length : nextBlank;
    const paragraph = wikitext.slice(paraStart, paraEnd);
    const cnOffsetInPara = offset - paraStart;

    const rawClaim = claimFromParagraph(paragraph, cnOffsetInPara);
    const claim = cleanForDisplay(rawClaim);
    const context = cleanForDisplay(paragraph);
    const section = sectionFor(wikitext, offset);

    claims.push({
      claim: claim.length > 0 ? claim : context,
      context,
      section,
      offset,
      tag,
    });
  }
  return claims;
}

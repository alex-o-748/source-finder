/**
 * Wikitext text utilities shared by the wiki-local source finders.
 *
 * Everything here is pure and deterministic — no network, no model. The point
 * of the wiki-local layer is that it costs nothing to run, so the parsing it
 * depends on has to be plain code.
 */

/** A `== Heading ==` and the wikitext range it covers. */
export interface SectionRange {
  heading: string;
  level: number;
  /** Offset of the first character after the heading line. */
  start: number;
  /** Offset of the next heading of the same or a higher level (or EOF). */
  end: number;
}

/** A half-open `[start, end)` character range in a wikitext buffer. */
export interface Range {
  start: number;
  end: number;
}

/**
 * Templates whose arguments carry prose or numbers worth keeping when the rest
 * of the template markup is stripped. `keep` selects positional arguments by
 * index; everything else is dropped wholesale (infoboxes, navboxes, maintenance
 * tags) because their contents are not part of the sentence.
 */
const INLINE_TEMPLATES: Record<string, { keep: number[] | "all" }> = {
  convert: { keep: [0, 1] },
  cvt: { keep: [0, 1] },
  val: { keep: [0] },
  formatnum: { keep: [0] },
  nowrap: { keep: "all" },
  nobr: { keep: "all" },
  lang: { keep: [1] },
  langx: { keep: [1] },
  transliteration: { keep: [1] },
  transl: { keep: [1] },
  circa: { keep: "all" },
  c: { keep: "all" },
  "as of": { keep: [0] },
  asof: { keep: [0] },
  "start date": { keep: "all" },
  "end date": { keep: "all" },
  "birth date": { keep: "all" },
  "death date": { keep: "all" },
  "sic": { keep: [0] },
};

/** Sentence terminators that always end a sentence, with or without a space. */
const HARD_TERMINATORS = "。！？؟۔।॥";

/**
 * Words whose trailing period is part of the word. Kept short: over-splitting
 * costs a truncated claim, while under-splitting only means extra context.
 */
const ABBREVIATIONS = new Set(
  ("mr mrs ms dr prof st jr sr vs etc ca approx no nos fig figs vol vols " +
    "pp ed eds inc ltd co corp cf al dept univ mt est ave rd"
  ).split(" "),
);

/** True when the period at `dot` closes an abbreviation rather than a sentence. */
function endsAbbreviation(text: string, dot: number): boolean {
  let i = dot - 1;
  while (i >= 0 && /[\p{L}\p{N}]/u.test(text[i])) i--;
  const word = text.slice(i + 1, dot);
  if (word.length === 0) return false;
  // A single capital is an initial ("J. Smith"); a preceding dot means we are
  // inside a dotted acronym ("U.S.").
  if (word.length === 1 && /\p{Lu}/u.test(word)) return true;
  if (text[i] === ".") return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** Returns the balanced `}}` position for the `{{` starting at `start`. */
function templateEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      i++;
    } else if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Splits template body text on top-level `|`, ignoring nested templates/links. */
export function splitTemplateArgs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{" && body[i + 1] === "{") {
      depth++;
      i++;
    } else if (body[i] === "}" && body[i + 1] === "}") {
      depth--;
      i++;
    } else if (body[i] === "[" && body[i + 1] === "[") {
      depth++;
      i++;
    } else if (body[i] === "]" && body[i + 1] === "]") {
      depth--;
      i++;
    } else if (body[i] === "|" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * Parses a template call (`{{name|a|b|k=v}}`, without the braces) into its name,
 * positional arguments, and named parameters. Parameter names are lower-cased
 * and hyphen/underscore-normalised so `access-date` and `accessdate` collide.
 */
export function parseTemplate(body: string): {
  name: string;
  positional: string[];
  named: Record<string, string>;
} {
  const args = splitTemplateArgs(body);
  const name = (args.shift() ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    // A `=` inside a nested template or link is not a parameter assignment.
    if (eq > 0 && !/[[{]/.test(arg.slice(0, eq))) {
      const key = arg.slice(0, eq).trim().toLowerCase().replace(/[_\s]+/g, "-");
      named[key] = arg.slice(eq + 1).trim();
    } else {
      positional.push(arg.trim());
    }
  }
  return { name, positional, named };
}

/** Replaces every balanced `{{…}}` call, keeping prose from inline templates. */
function stripTemplates(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{" && text[i + 1] === "{") {
      const end = templateEnd(text, i);
      const body = text.slice(i + 2, Math.max(i + 2, end - 2));
      const { name, positional } = parseTemplate(body);
      const rule = INLINE_TEMPLATES[name];
      if (rule) {
        const kept =
          rule.keep === "all"
            ? positional
            : rule.keep.map((n) => positional[n]).filter((v) => v !== undefined);
        out += " " + kept.map(stripWikitext).join(" ") + " ";
      } else {
        out += " ";
      }
      i = end;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * Reduces wikitext to the plain prose a reader sees: comments, refs, tables,
 * files and markup removed, wikilinks reduced to their display text.
 *
 * Deliberately lossy and deliberately cheap — the output feeds a bag-of-tokens
 * scorer and a human-readable evidence snippet, not a renderer.
 */
export function stripWikitext(text: string): string {
  let s = text;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<ref[^>]*\/\s*>/gi, " ");
  s = s.replace(/<ref[\s\S]*?<\/ref\s*>/gi, " ");
  s = s.replace(/<references[\s\S]*?<\/references\s*>/gi, " ");
  s = s.replace(/<\/?(?:references|gallery|math|score|syntaxhighlight|nowiki|poem|small|sub|sup|br|div|span|blockquote|code|pre)[^>]*>/gi, " ");
  s = s.replace(/^\s*\{\|[\s\S]*?^\s*\|\}/gm, " ");
  s = stripTemplates(s);
  // Files and categories carry no prose for our purposes.
  s = s.replace(
    /\[\[\s*(?:File|Image|Media|Category|Категория|Fichier|Datei|Archivo)\s*:[\s\S]*?\]\]/gi,
    " ",
  );
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1");
  s = s.replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, "$1");
  s = s.replace(/\[(?:https?:)?\/\/\S+\]/g, " ");
  s = s.replace(/'{2,5}/g, "");
  s = s.replace(/^[*#:;]+\s*/gm, "");
  s = s.replace(/^=+\s*(.*?)\s*=+\s*$/gm, "$1.");
  s = s.replace(/&nbsp;|&#160;/gi, " ");
  s = s.replace(/&amp;/gi, "&");
  return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * Splits plain text into sentences. Latin-script boundaries need a following
 * space plus an opening-looking character (so "U.S. Army" and "Dr. Who" stay
 * whole); CJK/Devanagari/Arabic terminators end a sentence on their own.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (HARD_TERMINATORS.includes(ch)) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
      continue;
    }
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\n") continue;
    if (ch === "\n") {
      out.push(text.slice(start, i).trim());
      start = i + 1;
      continue;
    }
    if (ch === "." && endsAbbreviation(text, i)) continue;
    // Consume runs like "?!" or "..." so the boundary lands after the last one.
    let j = i;
    while (j + 1 < text.length && /[.!?]/.test(text[j + 1])) j++;
    const rest = text.slice(j + 1);
    const ws = rest.match(/^[ \n\t]+/);
    if (!ws) continue;
    const after = rest.slice(ws[0].length);
    if (!after || /^[A-ZÀ-ÞА-ЯΑ-Ω(“"'\d[]/.test(after)) {
      out.push(text.slice(start, j + 1).trim());
      start = j + 1;
      i = j;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter((s) => s.length > 0);
}

/** Returns the sentence within `text` that covers `pos`, or the whole text. */
export function sentenceAt(text: string, pos: number): string {
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    const at = text.indexOf(sentence, cursor);
    if (at === -1) continue;
    cursor = at + sentence.length;
    if (pos < cursor) return sentence;
  }
  return text.trim();
}

/** All `== Heading ==` ranges in a wikitext buffer, in document order. */
export function sectionRanges(wikitext: string): SectionRange[] {
  const re = /^(={2,6})\s*([^=\n][^\n]*?)\s*\1\s*$/gm;
  const heads: { heading: string; level: number; start: number }[] = [];
  for (;;) {
    const m = re.exec(wikitext);
    if (!m) break;
    heads.push({
      heading: m[2].trim(),
      level: m[1].length,
      start: m.index + m[0].length + 1,
    });
  }
  return heads.map((h, i) => {
    let end = wikitext.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) {
        // Back up over the heading line itself.
        end = wikitext.lastIndexOf("\n", heads[j].start - 2);
        if (end < h.start) end = h.start;
        break;
      }
    }
    return { heading: h.heading, level: h.level, start: h.start, end };
  });
}

/** The blank-line-delimited paragraph containing `pos`. */
export function paragraphRangeAt(wikitext: string, pos: number): Range {
  const before = wikitext.lastIndexOf("\n\n", pos);
  const after = wikitext.indexOf("\n\n", pos);
  return {
    start: before === -1 ? 0 : before + 2,
    end: after === -1 ? wikitext.length : after,
  };
}

/** Splits wikitext into blank-line-delimited paragraph ranges. */
export function paragraphRanges(wikitext: string): Range[] {
  const out: Range[] = [];
  let start = 0;
  for (;;) {
    const idx = wikitext.indexOf("\n\n", start);
    const end = idx === -1 ? wikitext.length : idx;
    if (end > start) out.push({ start, end });
    if (idx === -1) break;
    start = idx + 2;
  }
  return out;
}

/**
 * Wikilink targets appearing in `text`, normalised (underscores to spaces,
 * section anchors and leading colons dropped). File/Category links are skipped:
 * they are not entity mentions in the sentence.
 */
export function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    const target = m[1].replace(/_/g, " ").replace(/^\s*:/, "").trim();
    if (!target) continue;
    if (/^(?:File|Image|Media|Category)\s*:/i.test(target)) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * `<ref>` parsing for the wiki-local source finders.
 *
 * MediaWiki references come in three shapes that all have to be understood
 * before an article's citations can be reused:
 *
 *   <ref>{{cite web|url=…}}</ref>            a plain, inline reference
 *   <ref name="a">{{cite news|…}}</ref>      a named reference…
 *   <ref name="a" />                         …and a re-use of it elsewhere
 *
 * plus list-defined references, where every body lives inside `{{reflist|refs=}}`
 * or `<references>` at the bottom of the page and only the self-closing re-uses
 * sit next to the prose. That last case is why occurrences and definitions are
 * tracked separately: the *definition* carries the citation, but only the
 * *occurrence* tells you which sentence the citation was used for.
 */

import { parseTemplate, splitTemplateArgs, stripWikitext } from "./wikitext.js";
import type { Range } from "./wikitext.js";

/** One `<ref…>` in the wikitext, whether a definition or a re-use. */
export interface RefOccurrence {
  /** `name=` attribute, or null for anonymous refs. */
  name: string | null;
  /** `group=` attribute — non-null groups are usually explanatory footnotes. */
  group: string | null;
  /** Body of the ref as written, empty for a self-closing re-use. */
  content: string;
  /** Offset of the `<` that opens the tag. */
  offset: number;
  /** Offset just past the closing tag. */
  end: number;
  /** True when this occurrence only re-uses a body defined elsewhere. */
  reuse: boolean;
  /**
   * True when the tag sits inside `<references>` or `{{reflist|refs=}}` — i.e.
   * it defines a citation but says nothing about where it is used.
   */
  definitionOnly: boolean;
}

/** An occurrence with its body resolved through `name=` when it is a re-use. */
export interface ResolvedRef extends RefOccurrence {
  /** Body of the ref, following `name=` to the defining occurrence. */
  resolvedContent: string;
}

/** Bibliographic fields recovered from a ref body. */
export interface RefSource {
  /** Best fetchable URL for the source, or null (offline books, {{sfn}}, …). */
  url: string | null;
  title: string | null;
  /** Work, website, publisher, newspaper or journal — whichever was given. */
  work: string | null;
  author: string | null;
  date: string | null;
  /** `quote=` from the citation template: the source's own words, for free. */
  quote: string | null;
  /** Citation template used, e.g. "cite news". Null for bare links. */
  template: string | null;
  /** True for shortened footnotes ({{sfn}}, {{harvnb}}) with no URL of their own. */
  shortFootnote: boolean;
  /** The ref body verbatim, so a caller can re-use the citation as written. */
  raw: string;
}

const CITE_TEMPLATES = /^(?:cite\b|citation$|vcite\b)/;

/**
 * Citation templates on the largest non-English Wikipedias. Sister-wiki
 * references are the point of this parser, and most of them are not written
 * with `{{cite web}}`.
 */
const FOREIGN_CITE_TEMPLATES = new Set([
  "internetquelle", "literatur", // de
  "lien web", "ouvrage", "article", "périodique", "lien brisé", // fr
  "cita web", "cita publicación", "cita libro", "cita noticia", // es
  "cita libro", "cita news", "cita pubblicazione", "cita testo", // it
  "citeer web", "citeer boek", "citeer nieuws", // nl
  "cytuj stronę", "cytuj książkę", "cytuj pismo", "cytuj", // pl
  "citar web", "citar livro", "citar jornal", "citar periódico", // pt
  "статья", "книга", "публикация", "cite news2", // ru
  "webbref", "bokref", "tidningsref", // sv
  "citace elektronické monografie", "citace monografie", "citace periodika", // cs
  "verkkoviite", "kirjaviite", "lehtiviite", // fi
  "kilde www", "kilde bok", "kilde avis", // no/da
  "web kaynağı", // tr
  "hivatkozás", "cite web/hu", // hu
]);

const SHORT_FOOTNOTE_TEMPLATES =
  /^(?:sfn|sfnp|sfnm|harvnb|harv|harvtxt|harvp|r)$/;

/**
 * Parameter names carrying each field, across the wikis above. `parseTemplate`
 * lower-cases and hyphen-normalises keys before these are looked up.
 */
const URL_KEYS = [
  "url", "chapter-url", "article-url", "entry-url", "transcript-url",
  "lien", "adresse", "ссылка",
];

const TITLE_KEYS = [
  "title", "chapter", "article", "entry",
  "titel", "titre", "título", "titulo", "titolo", "tytuł", "tytul",
  "otsikko", "tittel", "заголовок", "название", "başlık",
];

const WORK_KEYS = [
  "work", "website", "newspaper", "magazine", "journal", "publisher",
  "periodical", "encyclopedia", "site",
  "werk", "hrsg", "herausgeber", "verlag", "éditeur", "editeur", "site-web",
  "obra", "editorial", "editore", "opublikowany", "wydawca", "uitgever",
  "utgivare", "julkaisija", "издательство", "издание", "periódico",
];

const AUTHOR_KEYS = [
  "author", "author1", "last", "last1", "authors", "first",
  "autor", "auteur", "autore", "författare", "forfatter", "tekijä",
  "автор", "авторы", "yazar",
];

const DATE_KEYS = [
  "date", "year", "publication-date",
  "datum", "jahr", "fecha", "año", "ano", "data", "rok", "année",
  "vuosi", "år", "дата", "год", "tarih",
];

const QUOTE_KEYS = ["quote", "quotation", "zitat", "cita", "cytat", "цитата"];

/** True for a template that is a full citation on some Wikipedia. */
function isCitationTemplate(name: string): boolean {
  return CITE_TEMPLATES.test(name) || FOREIGN_CITE_TEMPLATES.has(name);
}

/** Parses the attributes of a `<ref …>` opening tag, respecting quoting. */
function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g;
  for (;;) {
    const m = re.exec(raw);
    if (!m) break;
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

/** Ranges in which a `<ref>` is a bare definition rather than a use site. */
function definitionRanges(wikitext: string): Range[] {
  const ranges: Range[] = [];
  const block = /<references[^>]*>[\s\S]*?<\/references\s*>/gi;
  for (;;) {
    const m = block.exec(wikitext);
    if (!m) break;
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  // {{reflist|refs=…}} and {{notelist|refs=…}} hold list-defined references.
  const listTemplate = /\{\{\s*(?:reflist|notelist|refbegin)[^{}]*?\|\s*refs\s*=/gi;
  for (;;) {
    const m = listTemplate.exec(wikitext);
    if (!m) break;
    let depth = 0;
    let end = wikitext.length;
    for (let i = m.index; i < wikitext.length - 1; i++) {
      if (wikitext[i] === "{" && wikitext[i + 1] === "{") {
        depth++;
        i++;
      } else if (wikitext[i] === "}" && wikitext[i + 1] === "}") {
        depth--;
        i++;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    ranges.push({ start: m.index, end });
  }
  return ranges;
}

/** Scans wikitext for every `<ref>` tag, in document order. */
export function parseRefs(wikitext: string): RefOccurrence[] {
  const defRanges = definitionRanges(wikitext);
  const inDefinitionBlock = (pos: number): boolean =>
    defRanges.some((r) => pos >= r.start && pos < r.end);

  const out: RefOccurrence[] = [];
  const lower = wikitext.toLowerCase();
  const open = /<ref(\s[^>]*?)?\/?\s*>/gi;
  for (;;) {
    const m = open.exec(wikitext);
    if (!m) break;
    const attrs = parseAttributes(m[1] ?? "");
    const selfClosing = m[0].trimEnd().endsWith("/>");
    const start = m.index;

    let content = "";
    let end = m.index + m[0].length;
    if (!selfClosing) {
      // MediaWiki does not nest <ref>, so the next </ref> closes this one.
      const close = lower.indexOf("</ref", end);
      if (close === -1) continue;
      const closeEnd = wikitext.indexOf(">", close);
      content = wikitext.slice(end, close);
      end = closeEnd === -1 ? wikitext.length : closeEnd + 1;
      open.lastIndex = end;
    }

    out.push({
      name: attrs.name ?? null,
      group: attrs.group ?? null,
      content: content.trim(),
      offset: start,
      end,
      reuse: selfClosing || content.trim().length === 0,
      definitionOnly: inDefinitionBlock(start),
    });
  }
  return out;
}

/**
 * Resolves `<ref name="x" />` re-uses to the body defined elsewhere on the
 * page, so every occurrence knows the citation it stands for.
 */
export function resolveRefs(refs: RefOccurrence[]): ResolvedRef[] {
  const bodies = new Map<string, string>();
  for (const ref of refs) {
    if (ref.name && ref.content && !bodies.has(ref.name)) {
      bodies.set(ref.name, ref.content);
    }
  }
  return refs.map((ref) => ({
    ...ref,
    resolvedContent: ref.content || (ref.name ? bodies.get(ref.name) ?? "" : ""),
  }));
}

/** Normalises an identifier-style parameter into a resolvable URL. */
function identifierUrl(named: Record<string, string>): string | null {
  const doi = named.doi?.trim();
  if (doi) return `https://doi.org/${encodeURI(doi.replace(/^doi:\s*/i, ""))}`;
  const pmid = named.pmid?.trim();
  if (pmid && /^\d+$/.test(pmid)) {
    return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  }
  const pmc = named.pmc?.trim();
  if (pmc) {
    return `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmc.replace(/^PMC/i, "")}/`;
  }
  const jstor = named.jstor?.trim();
  if (jstor) return `https://www.jstor.org/stable/${encodeURIComponent(jstor)}`;
  const arxiv = named.arxiv?.trim();
  if (arxiv) return `https://arxiv.org/abs/${encodeURIComponent(arxiv)}`;
  const hdl = named.hdl?.trim();
  if (hdl) return `https://hdl.handle.net/${encodeURI(hdl)}`;
  return null;
}

/** First value present among `keys`, trimmed and stripped of markup. */
function firstOf(named: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = named[key];
    if (value && value.trim()) return stripWikitext(value).trim() || null;
  }
  return null;
}

/** Finds the first `{{…}}` call in a ref body and returns its inner text. */
function firstTemplateBody(content: string): string | null {
  const start = content.indexOf("{{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < content.length - 1; i++) {
    if (content[i] === "{" && content[i + 1] === "{") {
      depth++;
      i++;
    } else if (content[i] === "}" && content[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) return content.slice(start + 2, i - 1);
    }
  }
  return null;
}

/**
 * Extracts the bibliographic payload of a ref body: a citation template if one
 * is present, otherwise a bare or bracketed external link. Returns null when
 * the body carries nothing citable at all.
 */
export function refToSource(content: string): RefSource | null {
  const raw = content.trim();
  if (!raw) return null;

  const body = firstTemplateBody(raw);
  if (body) {
    const { name, named, positional } = parseTemplate(body);
    if (SHORT_FOOTNOTE_TEMPLATES.test(name)) {
      const label = positional.filter((p) => p).join(" ");
      return {
        url: null,
        title: label || null,
        work: null,
        author: positional[0] ?? null,
        date: positional.find((p) => /^\d{4}$/.test(p)) ?? null,
        quote: null,
        template: name,
        shortFootnote: true,
        raw,
      };
    }
    if (isCitationTemplate(name)) {
      const dead = /^(?:dead|unfit|usurped|bot: unknown)$/i.test(
        named["url-status"] ?? "",
      );
      const archive =
        named["archive-url"] || named.archiveurl || named.archiv_url || null;
      const live = URL_KEYS.map((k) => named[k]).find((v) => v && v.trim()) ?? null;
      const url =
        (dead && archive ? archive : live || archive) || identifierUrl(named);
      const surname = named.last1 || named.last;
      const given = named.first1 || named.first;
      const author =
        surname && given
          ? `${stripWikitext(surname)}, ${stripWikitext(given)}`
          : firstOf(named, AUTHOR_KEYS);
      return {
        url: url ? url.trim() : null,
        title:
          firstOf(named, TITLE_KEYS) ??
          (positional[0] ? stripWikitext(positional[0]) : null),
        work: firstOf(named, WORK_KEYS),
        author,
        date: firstOf(named, DATE_KEYS),
        quote: firstOf(named, QUOTE_KEYS),
        template: name,
        shortFootnote: false,
        raw,
      };
    }
  }

  // No citation template: fall back to an external link in the body.
  const bracketed = raw.match(/\[((?:https?:)?\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/);
  if (bracketed) {
    return {
      url: bracketed[1],
      title: bracketed[2] ? stripWikitext(bracketed[2]).trim() : null,
      work: null,
      author: null,
      date: null,
      quote: null,
      template: null,
      shortFootnote: false,
      raw,
    };
  }
  const bare = raw.match(/(?:https?:)?\/\/[^\s|}\]<]+/);
  if (bare) {
    return {
      url: bare[0],
      title: null,
      work: null,
      author: null,
      date: null,
      quote: null,
      template: null,
      shortFootnote: false,
      raw,
    };
  }

  // Free-form citation prose ("Smith, John. *A Book*. Penguin, 1998."): keep it
  // as an unlinked candidate so an editor can still see what is available.
  const text = stripWikitext(raw).trim();
  if (!text) return null;
  return {
    url: null,
    title: text.length > 200 ? `${text.slice(0, 199)}…` : text,
    work: null,
    author: null,
    date: null,
    quote: null,
    template: null,
    shortFootnote: false,
    raw,
  };
}

/** Plain-text summary of a ref, used for lexical scoring and display. */
export function refText(source: RefSource): string {
  return [source.title, source.work, source.author, source.date, source.quote]
    .filter(Boolean)
    .join(" ");
}

/** Splits a `{{cite}}` body into args — re-exported for callers that need it. */
export { splitTemplateArgs };

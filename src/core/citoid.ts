/**
 * A fully filled {{cite book}} from an ISBN, the way ProveIt and VisualEditor's
 * "Automatic" cite tab do it.
 *
 * Citoid (`/api/rest_v1/data/citation/mediawiki/<ISBN>`) looks the ISBN up in
 * library catalogues (WorldCat, the Library of Congress, Open Library) and
 * answers with Zotero-style fields: `author: [[first, last], …]`, `place`,
 * `edition`, `oclc`… The template's own TemplateData carries a `maps.citoid`
 * table that says which parameter each field goes into (`place` → `location`,
 * the second author → `first2`/`last2`), so the mapping is the template's,
 * not ours: a wiki whose {{cite book}} names its parameters differently maps
 * them itself. A built-in copy of en.wikipedia's map covers a wiki without one.
 *
 * The Internet Archive citation keeps what only it knows — the link to the
 * scan, `url-access`, `via` — and gives way to the catalogue on everything
 * bibliographic, filling only what the catalogue left out.
 */
import { USER_AGENT } from "./mediawiki.js";
import { parseTemplate } from "./wikitext.js";
import type { Citation } from "./types.js";

/** A TemplateData `maps.citoid` table: field → parameter, parameters, or [first, last] pairs. */
export type CitoidMap = Record<string, string | (string | string[])[]>;

/** One Citoid result in the `mediawiki` format. */
export type CitoidItem = Record<string, unknown>;

function namePairs(first: string, last: string): string[][] {
  const pairs = [[first, last]];
  for (let n = 2; n <= 9; n++) pairs.push([`${first}${n}`, `${last}${n}`]);
  return pairs;
}

/** en.wikipedia's {{cite book}} map, for a wiki whose template has none. */
export const CITE_BOOK_CITOID_MAP: CitoidMap = {
  title: "title",
  bookTitle: "title",
  edition: "edition",
  series: "series",
  volume: "volume",
  publisher: "publisher",
  place: "location",
  date: "date",
  language: "language",
  ISBN: ["isbn"],
  ISSN: ["issn"],
  oclc: "oclc",
  DOI: "doi",
  url: "url",
  author: namePairs("first", "last"),
  editor: namePairs("editor-first", "editor-last"),
  translator: namePairs("translator-first", "translator-last"),
  contributor: "others",
};

/** Parameters the Archive citation keeps whatever the catalogue says. */
const KEEP = ["url", "url-access", "via", "access-date"];

/** The order the parameters are written in: names, then the work, then where to read it. */
const FIELD_ORDER = [
  "title", "edition", "series", "volume", "others", "publisher", "location",
  "date", "year", "language", "isbn", "issn", "oclc", "doi",
  "url", "url-access", "via", "access-date",
];

/** "0-14-044913-2" → "0140449132"; anything that is not a 10- or 13-digit ISBN → null. */
export function normaliseIsbn(raw: string): string | null {
  const digits = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  return /^(?:\d{9}[\dX]|\d{13})$/.test(digits) ? digits : null;
}

function clean(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim().replace(/\|/g, "{{!}}")
    : "";
}

/**
 * Citoid's fields as template parameters, through the template's map — the
 * same walk ProveIt and VisualEditor make: a string maps one value, a list maps
 * the field's values in turn, a list of pairs maps each [first, last] name.
 */
export function citoidParams(item: CitoidItem, map: CitoidMap): Record<string, string> {
  const params: Record<string, string> = {};
  const set = (param: unknown, value: unknown) => {
    const v = clean(value);
    if (typeof param === "string" && param && v && !params[param]) params[param] = v;
  };
  for (const [field, target] of Object.entries(map)) {
    const value = item[field];
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    if (typeof target === "string") {
      set(target, values[0]);
      continue;
    }
    target.forEach((param, i) => {
      const v = values[i];
      if (Array.isArray(param)) {
        // [first, last]; a one-part name (an organisation) is all "last".
        const name = Array.isArray(v) ? v : [];
        const first = clean(name[0]);
        const last = clean(name[1]);
        set(param[1], last || first);
        if (last) set(param[0], first);
      } else {
        set(param, v);
      }
    });
  }
  return params;
}

function orderKey(param: string): [number, number, number] {
  const m = /^(?:(editor|translator)-)?(last|first|author)(\d*)$/.exec(param);
  if (m) {
    const group = m[1] === "editor" ? 1 : m[1] === "translator" ? 2 : 0;
    return [group, Number(m[3] || 1), m[2] === "first" ? 1 : 0];
  }
  const i = FIELD_ORDER.indexOf(param);
  return [3, i < 0 ? FIELD_ORDER.length : i, 0];
}

/**
 * The catalogue's parameters with the Archive citation's link kept and its
 * gaps filled from what the Archive knew. Null when the catalogue had no title.
 */
export function mergeCiteBook(
  existing: Record<string, string>,
  catalogue: Record<string, string>,
): Record<string, string> | null {
  if (!catalogue.title) return null;
  const out: Record<string, string> = { ...catalogue };
  delete out.url;
  const hasAuthor = Object.keys(out).some((k) => /^(?:last|author)1?$/.test(k));
  for (const [k, v] of Object.entries(existing)) {
    if (KEEP.includes(k)) out[k] = v;
    else if (k === "author" ? hasAuthor : k === "year" ? Boolean(out.date) : Boolean(out[k])) continue;
    else out[k] = v;
  }
  const ordered: Record<string, string> = {};
  Object.keys(out)
    .map((k, i) => ({ k, i, key: orderKey(k) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.i - b.i)
    .forEach(({ k }) => { ordered[k] = out[k]; });
  return ordered;
}

/** `{{cite book |…}}` back to wikitext, in the order given. */
export function citeBookTemplate(params: Record<string, string>): string {
  return `{{cite book |${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" |")}}}`;
}

/**
 * A {{cite book}} with an |isbn= completed from Citoid's answer; the same
 * citation when it has no ISBN or the answer has nothing usable.
 */
export function completeCitation(citation: Citation, items: unknown, map: CitoidMap): Citation {
  const item = Array.isArray(items) ? items[0] : null;
  if (!item || typeof item !== "object") return citation;
  const body = citation.template.replace(/^\{\{/, "").replace(/\}\}$/, "");
  const { name, named } = parseTemplate(body);
  if (name !== "cite book") return citation;
  const merged = mergeCiteBook(named, citoidParams(item as CitoidItem, map));
  if (!merged) return citation;
  const template = citeBookTemplate(merged);
  return { template, ref: `<ref>${template}</ref>`, kind: "cite book" };
}

/** The ISBN of a {{cite book}} citation, if it carries a usable one. */
export function citationIsbn(citation: Citation): string | null {
  if (citation.kind !== "cite book") return null;
  const body = citation.template.replace(/^\{\{/, "").replace(/\}\}$/, "");
  const isbn = parseTemplate(body).named.isbn;
  return isbn ? normaliseIsbn(isbn) : null;
}

export function citoidUrl(lang: string, isbn: string): string {
  return `https://${lang}.wikipedia.org/api/rest_v1/data/citation/mediawiki/${encodeURIComponent(isbn)}`;
}

type TemplateDataResponse = { pages?: Record<string, { maps?: { citoid?: CitoidMap } }> };

const mapCache = new Map<string, Promise<CitoidMap>>();

/** The wiki's own {{cite book}} map from TemplateData, or en.wikipedia's built-in copy. */
export function citeBookMap(lang: string): Promise<CitoidMap> {
  let map = mapCache.get(lang);
  if (!map) {
    const url = `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({
      action: "templatedata", titles: "Template:Cite book", redirects: "1",
      format: "json", formatversion: "2",
    }).toString();
    map = fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null) as Promise<TemplateDataResponse | null>)
      .then((data) => {
        const page = data?.pages ? Object.values(data.pages)[0] : undefined;
        return page?.maps?.citoid ?? CITE_BOOK_CITOID_MAP;
      })
      .catch(() => CITE_BOOK_CITOID_MAP);
    mapCache.set(lang, map);
  }
  return map;
}

/**
 * Completes a {{cite book}} from its ISBN through Citoid. Never throws: a
 * lookup that fails leaves the citation as it was.
 */
export async function completeFromIsbn(citation: Citation, lang = "en"): Promise<Citation> {
  const isbn = citationIsbn(citation);
  if (!isbn) return citation;
  try {
    const [map, res] = await Promise.all([
      citeBookMap(lang),
      fetch(citoidUrl(lang, isbn), {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      }),
    ]);
    if (!res.ok) return citation;
    return completeCitation(citation, await res.json(), map);
  } catch {
    return citation;
  }
}

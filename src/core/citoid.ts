/**
 * A fully filled citation template from an ISBN, a DOI or a URL, the way
 * ProveIt and VisualEditor's "Automatic" cite tab do it.
 *
 * Citoid (`/api/rest_v1/data/citation/mediawiki/<query>`) looks an ISBN up in
 * library catalogues, a DOI in Crossref, and reads a web page's own metadata,
 * and answers with Zotero-style fields: an `itemType`, `author: [[first, last],
 * …]`, `publicationTitle`, `place`, `oclc`… Two pieces of the wiki's own
 * configuration turn that into wikitext:
 *
 *   - `MediaWiki:Citoid-template-type-map.json` picks the template for the
 *     item type (a newspaper article → {{cite news}}, a journal article →
 *     {{cite journal}});
 *   - the template's TemplateData `maps.citoid` table says which parameter
 *     each field goes into (`publicationTitle` → `journal`, the second author
 *     → `first2`/`last2`).
 *
 * So the mapping is the wiki's, not ours. Built-in copies of en.wikipedia's
 * cover a wiki that has none.
 *
 * The citation we already had keeps what only it knows — the link the source
 * was found at, `access-date`, and for an Internet Archive scan `url-access`
 * and `via` — and gives way to the catalogue on everything bibliographic,
 * filling only what the catalogue left out.
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

/** en.wikipedia's item type → template table, for a wiki without one. */
export const CITOID_TYPE_MAP: Record<string, string> = {
  book: "Cite book",
  bookSection: "Cite book",
  journalArticle: "Cite journal",
  magazineArticle: "Cite magazine",
  newspaperArticle: "Cite news",
  webpage: "Cite web",
  blogPost: "Cite web",
  forumPost: "Cite web",
  thesis: "Cite thesis",
  report: "Cite report",
  conferencePaper: "Cite conference",
  encyclopediaArticle: "Cite encyclopedia",
  dictionaryEntry: "Cite encyclopedia",
  videoRecording: "Cite AV media",
  film: "Cite AV media",
  podcast: "Cite podcast",
  interview: "Cite interview",
  map: "Cite map",
};

const COMMON_MAP: CitoidMap = {
  title: "title",
  url: "url",
  date: "date",
  accessDate: "access-date",
  language: "language",
  publisher: "publisher",
  archiveUrl: "archive-url",
  archiveDate: "archive-date",
  author: namePairs("first", "last"),
};

/** en.wikipedia's {{cite book}} map. */
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

/** en.wikipedia's maps for the templates the search results use, for a wiki without them. */
export const BUILTIN_CITOID_MAPS: Record<string, CitoidMap> = {
  "cite book": CITE_BOOK_CITOID_MAP,
  "cite web": { ...COMMON_MAP, websiteTitle: "website", publicationTitle: "website", blogTitle: "website", forumTitle: "website" },
  "cite news": { ...COMMON_MAP, publicationTitle: "work", websiteTitle: "work", place: "location", ISSN: ["issn"], DOI: "doi" },
  "cite journal": {
    ...COMMON_MAP, publicationTitle: "journal", volume: "volume", issue: "issue", pages: "pages", series: "series",
    DOI: "doi", ISSN: ["issn"], PMID: "pmid", PMCID: "pmc", editor: namePairs("editor-first", "editor-last"),
  },
  "cite magazine": { ...COMMON_MAP, publicationTitle: "magazine", volume: "volume", issue: "issue", pages: "pages", ISSN: ["issn"] },
};

/** Parameters the citation we had keeps whatever the catalogue says. */
const KEEP = ["url", "url-access", "via", "access-date"];

/** Parameters naming the work the item is in: the catalogue's one replaces ours. */
const WORK = ["website", "work", "newspaper", "magazine", "journal", "periodical"];

/** The order the parameters are written in: names, then the work, then where to read it. */
const FIELD_ORDER = [
  "title", "work", "website", "newspaper", "magazine", "journal", "periodical",
  "edition", "series", "volume", "issue", "pages", "others", "publisher", "location",
  "date", "year", "language", "isbn", "issn", "oclc", "doi", "pmid", "pmc",
  "url", "url-access", "via", "access-date", "archive-url", "archive-date",
];

/** "0-14-044913-2" → "0140449132"; anything that is not a 10- or 13-digit ISBN → null. */
export function normaliseIsbn(raw: string): string | null {
  const digits = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  return /^(?:\d{9}[\dX]|\d{13})$/.test(digits) ? digits : null;
}

/** The DOI a link carries: "https://doi.org/10.1038/171737a0", ".../doi/full/10.1080/x" → "10.…". */
export function doiIn(url: string): string | null {
  let text = url;
  try { text = decodeURIComponent(url); } catch { /* as it is */ }
  const m = /\b(10\.\d{4,9}\/[^\s?#&"<>]+)/.exec(text);
  if (!m) return null;
  return m[1].replace(/\/(?:full|abstract|pdf|epdf|fulltext)$/i, "").replace(/\.pdf$/i, "").replace(/[.,;)]+$/, "");
}

function templateBody(citation: Citation): string {
  return citation.template.replace(/^\{\{/, "").replace(/\}\}$/, "");
}

function isCiteTemplate(name: string): boolean {
  return /^(?:cite .+|citation)$/i.test(name.trim());
}

/**
 * What to ask Citoid for: a book's ISBN, else the DOI in the link, else the
 * link itself. An Internet Archive scan without an ISBN is left alone: the
 * scan's page says less than the Archive's own metadata already did.
 */
export function citoidQuery(citation: Citation): string | null {
  if (!citation.template) return null;
  const { name, named } = parseTemplate(templateBody(citation));
  if (!isCiteTemplate(name)) return null;
  const isbn = named.isbn ? normaliseIsbn(named.isbn) : null;
  if (isbn) return isbn;
  const url = named.url;
  if (!url || !/^https?:\/\//i.test(url) || /\barchive\.org\/details\//i.test(url)) return null;
  return doiIn(url) ?? url;
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

/**
 * The template the wiki writes this item type with ("Cite news" → "cite news");
 * the one we had when the type is unknown or the wiki's choice is not an
 * English `cite …` template, whose parameters ours would not match.
 */
export function citoidTemplate(item: CitoidItem, typeMap: Record<string, string>, current: string): string {
  const mapped = typeof item.itemType === "string" ? typeMap[item.itemType] : undefined;
  if (typeof mapped !== "string" || !isCiteTemplate(mapped)) return current;
  const name = mapped.trim().replace(/_/g, " ");
  return name.charAt(0).toLowerCase() + name.slice(1);
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
 * The catalogue's parameters with our link and access date kept. When the
 * template stays the same, the gaps are filled from the citation we had; a new
 * template takes nothing else, since its parameters are not ours.
 */
export function mergeParams(
  existing: Record<string, string>,
  catalogue: Record<string, string>,
  sameTemplate: boolean,
): Record<string, string> {
  const out: Record<string, string> = { ...catalogue };
  delete out.url;
  const hasAuthor = Object.keys(out).some((k) => /^(?:last|author)1?$/.test(k));
  const hasWork = WORK.some((w) => out[w]);
  for (const [k, v] of Object.entries(existing)) {
    if (KEEP.includes(k)) out[k] = v;
    else if (!sameTemplate) continue;
    else if (out[k] || (k === "author" && hasAuthor) || (k === "year" && out.date) || (WORK.includes(k) && hasWork)) continue;
    else out[k] = v;
  }
  const ordered: Record<string, string> = {};
  Object.keys(out)
    .map((k, i) => ({ k, i, key: orderKey(k) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.i - b.i)
    .forEach(({ k }) => { ordered[k] = out[k]; });
  return ordered;
}

/** A title Citoid made up from the link when the page told it nothing. */
function usableTitle(title: string | undefined, url: string | undefined): boolean {
  return Boolean(title) && !/^https?:\/\//i.test(title!) && title !== url;
}

/**
 * The citation rewritten from Citoid's answer in `template` through its map;
 * the same citation when the answer has nothing usable.
 */
export function completeCitation(citation: Citation, items: unknown, template: string, map: CitoidMap): Citation {
  const item = Array.isArray(items) ? items[0] : null;
  if (!item || typeof item !== "object") return citation;
  const { name, named } = parseTemplate(templateBody(citation));
  if (!isCiteTemplate(name) || !isCiteTemplate(template)) return citation;
  const catalogue = citoidParams(item as CitoidItem, map);
  if (!usableTitle(catalogue.title, named.url)) return citation;
  const merged = mergeParams(named, catalogue, template.toLowerCase() === name);
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join(" |");
  const out = `{{${template} |${body}}}`;
  return { template: out, ref: `<ref>${out}</ref>`, kind: template.toLowerCase() as Citation["kind"] };
}

export function citoidUrl(lang: string, query: string): string {
  return `https://${lang}.wikipedia.org/api/rest_v1/data/citation/mediawiki/${encodeURIComponent(query)}`;
}

function mwGet(lang: string, params: Record<string, string>): Promise<unknown> {
  const url = `https://${lang}.wikipedia.org/w/api.php?` +
    new URLSearchParams({ ...params, format: "json", formatversion: "2" }).toString();
  return fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null));
}

type PagesResponse = {
  query?: { pages?: { revisions?: { slots?: { main?: { content?: string } } }[] }[] };
  pages?: Record<string, { maps?: { citoid?: CitoidMap } }>;
};

const typeMapCache = new Map<string, Promise<Record<string, string>>>();

/** The wiki's `MediaWiki:Citoid-template-type-map.json`, or en.wikipedia's built-in copy. */
export function citoidTypeMap(lang: string): Promise<Record<string, string>> {
  let map = typeMapCache.get(lang);
  if (!map) {
    map = mwGet(lang, {
      action: "query", prop: "revisions", rvprop: "content", rvslots: "main",
      titles: "MediaWiki:Citoid-template-type-map.json",
    })
      .then((data) => {
        const content = (data as PagesResponse | null)?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
        const parsed = content ? JSON.parse(content) : null;
        return parsed && typeof parsed === "object" ? parsed : CITOID_TYPE_MAP;
      })
      .catch(() => CITOID_TYPE_MAP);
    typeMapCache.set(lang, map);
  }
  return map;
}

const templateMapCache = new Map<string, Promise<CitoidMap | null>>();

/** A template's `maps.citoid` from its TemplateData, or the built-in copy; null when there is neither. */
export function templateCitoidMap(lang: string, template: string): Promise<CitoidMap | null> {
  const key = `${lang}|${template.toLowerCase()}`;
  let map = templateMapCache.get(key);
  if (!map) {
    const builtin = BUILTIN_CITOID_MAPS[template.toLowerCase()] ?? null;
    map = mwGet(lang, { action: "templatedata", titles: `Template:${template}`, redirects: "1" })
      .then((data) => {
        const pages = (data as PagesResponse | null)?.pages;
        const page = pages ? Object.values(pages)[0] : undefined;
        return page?.maps?.citoid ?? builtin;
      })
      .catch(() => builtin);
    templateMapCache.set(key, map);
  }
  return map;
}

/**
 * Completes a citation through Citoid: the template the wiki picks for the
 * item, every field its map has. Never throws: a lookup that fails leaves the
 * citation as it was.
 */
export async function completeFromCitoid(citation: Citation, lang = "en"): Promise<Citation> {
  const query = citoidQuery(citation);
  if (!query) return citation;
  try {
    const [typeMap, res] = await Promise.all([
      citoidTypeMap(lang),
      fetch(citoidUrl(lang, query), {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      }),
    ]);
    if (!res.ok) return citation;
    const items: unknown = await res.json();
    const item = Array.isArray(items) && items[0] && typeof items[0] === "object" ? (items[0] as CitoidItem) : null;
    if (!item) return citation;
    const current = parseTemplate(templateBody(citation)).name;
    let template = citoidTemplate(item, typeMap, current);
    let map = await templateCitoidMap(lang, template);
    if (!map && template !== current) {
      template = current;
      map = await templateCitoidMap(lang, current);
    }
    return map ? completeCitation(citation, items, template, map) : citation;
  } catch {
    return citation;
  }
}

import { fetchWikitext } from "./mediawiki.js";
import type { Article } from "./types.js";

/**
 * Parses a Wikipedia URL or bare title into { lang, title }.
 * Accepts forms like:
 *   - "Eiffel Tower"
 *   - "https://en.wikipedia.org/wiki/Eiffel_Tower"
 *   - "https://fr.wikipedia.org/wiki/Tour_Eiffel"
 */
export function parseArticleRef(urlOrTitle: string): { lang: string; title: string } {
  const trimmed = urlOrTitle.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const hostMatch = u.hostname.match(/^([a-z-]+)\.wikipedia\.org$/i);
    if (!hostMatch) {
      throw new Error(`Not a Wikipedia URL: ${trimmed}`);
    }
    const lang = hostMatch[1].toLowerCase();
    const pathMatch = u.pathname.match(/^\/wiki\/(.+)$/);
    if (!pathMatch) {
      throw new Error(`URL does not point to a wiki article: ${trimmed}`);
    }
    const title = decodeURIComponent(pathMatch[1]).replace(/_/g, " ");
    return { lang, title };
  }
  return { lang: "en", title: trimmed.replace(/_/g, " ") };
}

/**
 * Fetches the raw wikitext for a Wikipedia article via the MediaWiki action API.
 * No HTML scraping — wikitext is authoritative for {{cn}} positions, and it is
 * also what the wiki-local source finders read `<ref>` tags out of.
 */
export async function fetchArticle(urlOrTitle: string): Promise<Article> {
  const { lang, title } = parseArticleRef(urlOrTitle);
  const page = await fetchWikitext(lang, title);
  return {
    title: page.title,
    lang,
    revid: page.revid,
    wikitext: page.wikitext,
    url: articleUrl(lang, page.title),
  };
}

/** Canonical article URL for a title on a given language edition. */
export function articleUrl(lang: string, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
    title.replace(/ /g, "_"),
  )}`;
}

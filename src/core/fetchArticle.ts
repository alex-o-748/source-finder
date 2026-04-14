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

interface MwParseResponse {
  parse?: {
    title: string;
    pageid: number;
    revid: number;
    wikitext: { "*": string };
  };
  error?: { code: string; info: string };
}

/**
 * Fetches the raw wikitext for a Wikipedia article via the MediaWiki action API.
 * No HTML scraping — wikitext is authoritative for {{cn}} positions.
 */
export async function fetchArticle(urlOrTitle: string): Promise<Article> {
  const { lang, title } = parseArticleRef(urlOrTitle);
  const endpoint = `https://${lang}.wikipedia.org/w/api.php`;
  const params = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "wikitext|revid",
    format: "json",
    formatversion: "1",
    redirects: "1",
    origin: "*",
  });

  const res = await fetch(`${endpoint}?${params.toString()}`, {
    headers: {
      "user-agent":
        "CNfirmed/0.1 (https://github.com/alex-o-748/source-finder; +cnfirmed)",
      accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Wikipedia API error: ${res.status} ${res.statusText} for ${title}`,
    );
  }

  const data = (await res.json()) as MwParseResponse;
  if (data.error) {
    throw new Error(`Wikipedia API error [${data.error.code}]: ${data.error.info}`);
  }
  if (!data.parse) {
    throw new Error(`No parse result for "${title}" on ${lang}.wikipedia.org`);
  }

  return {
    title: data.parse.title,
    lang,
    revid: data.parse.revid,
    wikitext: data.parse.wikitext["*"],
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
      data.parse.title.replace(/ /g, "_"),
    )}`,
  };
}

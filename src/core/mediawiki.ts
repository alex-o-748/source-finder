/**
 * Thin MediaWiki action-API client.
 *
 * Every wiki-local lookup goes through here: the article's own wikitext, the
 * interlanguage links that name its counterparts on other Wikipedias, and those
 * counterparts' wikitext. All of it is free and unmetered for reasonable use,
 * which is the whole reason this layer runs before the web search.
 */

export const USER_AGENT =
  "CNfirmed/0.1 (https://github.com/alex-o-748/source-finder; +cnfirmed)";

/** How long a single API request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20_000;

/** `titles=` accepts 50 per request for anonymous clients. */
const TITLES_PER_REQUEST = 50;

export interface WikiPage {
  title: string;
  lang: string;
  revid: number;
  wikitext: string;
}

/** An article's counterpart on another language edition. */
export interface LangLink {
  lang: string;
  title: string;
}

interface MwError {
  error?: { code: string; info: string };
}

/** Issues a GET against `<lang>.wikipedia.org/w/api.php` and returns the JSON. */
export async function mwApi<T>(
  lang: string,
  params: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams({
    format: "json",
    formatversion: "2",
    // Required for CORS when the same code runs in a browser; ignored in Node.
    origin: "*",
    ...params,
  });
  const url = `https://${lang}.wikipedia.org/w/api.php?${query.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(
      `MediaWiki API error on ${lang}.wikipedia.org: ${res.status} ${res.statusText}`,
    );
  }
  const data = (await res.json()) as T & MwError;
  if (data.error) {
    throw new Error(
      `MediaWiki API error [${data.error.code}] on ${lang}.wikipedia.org: ${data.error.info}`,
    );
  }
  return data;
}

interface QueryPagesResponse {
  query?: {
    pages?: {
      title: string;
      missing?: boolean;
      revisions?: { revid: number; slots?: { main?: { content?: string } } }[];
      langlinks?: { lang: string; title: string }[];
    }[];
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
  };
}

/** Fetches the current wikitext of one article, following redirects. */
export async function fetchWikitext(
  lang: string,
  title: string,
): Promise<WikiPage> {
  const data = await mwApi<QueryPagesResponse>(lang, {
    action: "query",
    prop: "revisions",
    rvprop: "content|ids",
    rvslots: "main",
    titles: title,
    redirects: "1",
  });
  const page = data.query?.pages?.[0];
  if (!page || page.missing) {
    throw new Error(`No article "${title}" on ${lang}.wikipedia.org`);
  }
  const revision = page.revisions?.[0];
  const content = revision?.slots?.main?.content;
  if (typeof content !== "string") {
    throw new Error(
      `No wikitext returned for "${title}" on ${lang}.wikipedia.org`,
    );
  }
  return {
    title: page.title,
    lang,
    revid: revision?.revid ?? 0,
    wikitext: content,
  };
}

/**
 * Looks up the interlanguage links of one or more titles in a single batch of
 * requests. Returns a map keyed by the *requested* title (normalisation and
 * redirects are folded back), each value mapping a language code to the title
 * of the counterpart article on that wiki.
 */
export async function fetchLangLinks(
  lang: string,
  titles: string[],
  options: { langs?: string[] } = {},
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];

  // `lllang` filters server-side but takes a single code, and asking for every
  // language at once can exceed `lllimit` and truncate without saying so. One
  // request per wanted language keeps each response bounded by the batch size.
  const targets: (string | null)[] = options.langs?.length
    ? [...options.langs]
    : [null];

  for (const target of targets) {
    for (let i = 0; i < unique.length; i += TITLES_PER_REQUEST) {
      const batch = unique.slice(i, i + TITLES_PER_REQUEST);
      const params: Record<string, string> = {
        action: "query",
        prop: "langlinks",
        lllimit: "max",
        titles: batch.join("|"),
        redirects: "1",
      };
      if (target) params.lllang = target;

      const data = await mwApi<QueryPagesResponse>(lang, params);

      // Rebuild "requested title -> canonical title" so callers can look up
      // what they asked for rather than what MediaWiki normalised it to.
      const alias = new Map<string, string>();
      for (const step of [
        ...(data.query?.normalized ?? []),
        ...(data.query?.redirects ?? []),
      ]) {
        alias.set(step.from, step.to);
      }
      const canonical = (requested: string): string => {
        let current = requested;
        for (let hop = 0; hop < 4; hop++) {
          const next = alias.get(current);
          if (!next) break;
          current = next;
        }
        return current;
      };

      const byTitle = new Map<string, Map<string, string>>();
      for (const page of data.query?.pages ?? []) {
        const links = new Map<string, string>();
        for (const link of page.langlinks ?? []) {
          if (options.langs && !options.langs.includes(link.lang)) continue;
          links.set(link.lang, link.title);
        }
        byTitle.set(page.title, links);
      }
      for (const requested of batch) {
        const links = byTitle.get(canonical(requested));
        if (!links || links.size === 0) continue;
        const merged = out.get(requested) ?? new Map<string, string>();
        for (const [code, foreignTitle] of links) merged.set(code, foreignTitle);
        out.set(requested, merged);
      }
    }
  }
  return out;
}

/** Convenience wrapper: the interlanguage links of a single article. */
export async function fetchArticleLangLinks(
  lang: string,
  title: string,
): Promise<LangLink[]> {
  const map = await fetchLangLinks(lang, [title]);
  const links = map.get(title);
  if (!links) return [];
  return [...links].map(([code, foreignTitle]) => ({
    lang: code,
    title: foreignTitle,
  }));
}

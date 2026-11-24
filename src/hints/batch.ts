#!/usr/bin/env node
/**
 * The batch job: computes hints for articles and stores them for the API.
 *
 *   node dist/hints/batch.js --title "Mad (magazine)"
 *   node dist/hints/batch.js --titles pilot.txt
 *   node dist/hints/batch.js --search 'incategory:"All articles with unsourced statements" articletopic:military-and-warfare' --limit 50 --random
 *
 * An article already stored at the same revision, by the same pipeline
 * version and with no failed claim, is skipped (`--force` recomputes it).
 * Articles run one after another: the Internet Archive and the model provider
 * are shared services, and each claim takes a minute or so anyway.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { mwApi } from "../core/mediawiki.js";
import { defaultChatClient } from "./chat.js";
import { computePageHints, PIPELINE_VERSION, type PageHints, type PageInput } from "./compute.js";
import { defaultHintsDir, fileStore, type HintStore } from "./store.js";

interface RevisionsResponse {
  query?: {
    pages?: {
      pageid?: number;
      title: string;
      missing?: boolean;
      revisions?: { revid: number; slots?: { main?: { content?: string } } }[];
    }[];
  };
}

/** The article's current wikitext, with the page and revision ids the store is keyed on. */
export async function fetchPage(wiki: string, title: string): Promise<PageInput | null> {
  const data = await mwApi<RevisionsResponse>(wiki, {
    action: "query",
    prop: "revisions",
    rvprop: "ids|content",
    rvslots: "main",
    redirects: "1",
    titles: title,
  });
  const page = data.query?.pages?.[0];
  const rev = page?.revisions?.[0];
  const wikitext = rev?.slots?.main?.content;
  if (!page || page.missing || !page.pageid || !rev || typeof wikitext !== "string") return null;
  return { wiki, pageId: page.pageid, title: page.title, revId: rev.revid, wikitext };
}

interface SearchResponse {
  query?: { search?: { title: string }[] };
  continue?: { sroffset?: number };
}

/** Article titles for a CirrusSearch query (e.g. `incategory:… articletopic:…`). */
export async function searchTitles(wiki: string, query: string, limit: number, random = false): Promise<string[]> {
  const titles: string[] = [];
  let offset = 0;
  while (titles.length < limit) {
    const data = await mwApi<SearchResponse>(wiki, {
      action: "query",
      list: "search",
      srsearch: query,
      srnamespace: "0",
      srlimit: String(Math.min(500, limit - titles.length)),
      srinfo: "",
      srprop: "",
      ...(random ? { srsort: "random" } : { sroffset: String(offset) }),
    });
    const found = data.query?.search?.map((r) => r.title) ?? [];
    for (const t of found) if (!titles.includes(t)) titles.push(t);
    if (random || !found.length || data.continue?.sroffset === undefined) break;
    offset = data.continue.sroffset;
  }
  return titles.slice(0, limit);
}

/** Whether a stored page can be kept as it is. */
export function upToDate(stored: PageHints | null, page: PageInput): boolean {
  return (
    !!stored &&
    stored.version === PIPELINE_VERSION &&
    stored.revId === page.revId &&
    stored.claims.every((c) => c.status !== "error")
  );
}

export async function runBatch(
  titles: string[],
  opts: { wiki: string; store: HintStore; force?: boolean; log?: (line: string) => void },
): Promise<{ computed: number; skipped: number; missing: number; books: number }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const { client, via } = defaultChatClient();
  log(`${titles.length} article(s) on ${opts.wiki}; models through ${via}`);
  const totals = { computed: 0, skipped: 0, missing: 0, books: 0 };
  for (const [i, title] of titles.entries()) {
    const head = `[${i + 1}/${titles.length}] ${title}`;
    let page: PageInput | null;
    try {
      page = await fetchPage(opts.wiki, title);
    } catch (err) {
      log(`${head}: could not fetch (${(err as Error).message})`);
      totals.missing++;
      continue;
    }
    if (!page) {
      log(`${head}: no such article`);
      totals.missing++;
      continue;
    }
    if (!opts.force && upToDate(await opts.store.get(page.wiki, page.pageId), page)) {
      log(`${head}: up to date`);
      totals.skipped++;
      continue;
    }
    const started = Date.now();
    const hints = await computePageHints(page, {
      chat: client,
      onClaim: (done, total, c) => {
        const what =
          c.status === "error"
            ? `failed: ${c.error}`
            : c.status === "no_leads"
              ? "no books to check"
              : c.books.length
                ? `${c.books[0].verdict}: ${c.books[0].title} — "${c.books[0].quote}"`
                : `${c.checked} checked, none states it`;
        log(`${head} claim ${done}/${total}: ${what}`);
      },
    });
    await opts.store.put(hints);
    const books = hints.claims.filter((c) => c.books.length).length;
    totals.computed++;
    totals.books += books;
    log(
      `${head}: ${hints.claims.length} claim(s), ${books} with a book, ` +
        `${Math.round((Date.now() - started) / 1000)} s`,
    );
  }
  log(
    `done: ${totals.computed} computed, ${totals.skipped} up to date, ${totals.missing} not found; ` +
      `${totals.books} claim(s) with a book`,
  );
  return totals;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      wiki: { type: "string", default: "en" },
      title: { type: "string", multiple: true },
      titles: { type: "string" },
      search: { type: "string" },
      limit: { type: "string", default: "20" },
      random: { type: "boolean", default: false },
      dir: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const wiki = values.wiki!;
  const titles = [...(values.title ?? [])];
  if (values.titles) {
    const lines = (await readFile(values.titles, "utf8")).split("\n").map((l) => l.trim());
    titles.push(...lines.filter((l) => l && !l.startsWith("#")));
  }
  if (values.search) titles.push(...(await searchTitles(wiki, values.search, Number(values.limit), values.random)));
  if (!titles.length) {
    console.error("Nothing to do: give --title, --titles <file> or --search <query>.");
    process.exit(2);
  }
  const dir = values.dir ?? defaultHintsDir();
  console.log(`storing in ${dir}`);
  await runBatch(titles, { wiki, store: fileStore(dir), force: values.force });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/**
 * Where computed hints are kept: one JSON file per article, under
 * `<dir>/<wiki>/<pageId>.json`.
 *
 * On Toolforge the directory is on the tool's NFS share, which both the web
 * service and the batch job see (run each with `--mount=all`). There is one
 * writer, the batch job, and each file is written whole and renamed into
 * place, so the web service never reads half a file. If the pilot outgrows
 * files, the same interface can sit on ToolsDB.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageHints } from "./compute.js";

export interface HintStore {
  get(wiki: string, pageId: number): Promise<PageHints | null>;
  put(hints: PageHints): Promise<void>;
}

const WIKI_CODE = /^[a-z][a-z0-9-]{0,30}$/;

function checkKey(wiki: string, pageId: number): void {
  if (!WIKI_CODE.test(wiki)) throw new Error(`Not a wiki code: ${wiki}`);
  if (!Number.isSafeInteger(pageId) || pageId <= 0) throw new Error(`Not a page id: ${pageId}`);
}

/** The default directory: `$HINTS_DIR`, else `$TOOL_DATA_DIR/hints` on Toolforge, else `./data/hints`. */
export function defaultHintsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HINTS_DIR) return env.HINTS_DIR;
  if (env.TOOL_DATA_DIR) return join(env.TOOL_DATA_DIR, "hints");
  return join(process.cwd(), "data", "hints");
}

export function fileStore(dir: string = defaultHintsDir()): HintStore {
  const path = (wiki: string, pageId: number) => join(dir, wiki, `${pageId}.json`);
  return {
    async get(wiki, pageId) {
      checkKey(wiki, pageId);
      try {
        return JSON.parse(await readFile(path(wiki, pageId), "utf8")) as PageHints;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async put(hints) {
      checkKey(hints.wiki, hints.pageId);
      await mkdir(join(dir, hints.wiki), { recursive: true });
      const target = path(hints.wiki, hints.pageId);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(hints, null, 1));
      await rename(tmp, target);
    },
  };
}

/** For tests. */
export function memoryStore(): HintStore & { pages: Map<string, PageHints> } {
  const pages = new Map<string, PageHints>();
  return {
    pages,
    async get(wiki, pageId) {
      return pages.get(`${wiki}:${pageId}`) ?? null;
    },
    async put(hints) {
      pages.set(`${hints.wiki}:${hints.pageId}`, hints);
    },
  };
}

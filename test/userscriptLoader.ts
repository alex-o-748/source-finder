/**
 * Loads the shipped user script with browser globals stubbed, and hands back
 * its pure internals for the parity tests.
 *
 * The user script is standalone by design — it re-implements the pipeline in
 * the browser rather than importing `src/` — so the only thing keeping the two
 * in step is a test that runs the shipped file against the same fixtures the
 * TypeScript core is tested on. It is an IIFE guarded for a live MediaWiki
 * page, so it is loaded with just enough of `mw`, `window` and `document`
 * stubbed to get past the boot guards.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every internal the parity tests call, by name. */
const EXPOSED = [
  "indexWikiArticle",
  "findWikiCandidates",
  "citationNeededOffsets",
  "stripWikitext",
  "refToSource",
  "iaClaimTerms",
  "buildArchiveQueries",
  "parseArchiveHits",
  "rankArchiveHits",
  "toArchiveCandidate",
  "iaSearchUrl",
  "findArchiveCandidates",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UserScriptModule = Record<string, (...args: any[]) => any> & {
  setClaimContexts(value: unknown[]): void;
  setCnSups(value: unknown[]): void;
};

export function loadUserScript(overrides: Record<string, unknown> = {}): UserScriptModule {
  const src = readFileSync(join(root, "userscript/cnfirmed.js"), "utf8");
  const open = "(function () {";
  const body = src.slice(src.indexOf(open) + open.length, src.lastIndexOf("})();"));
  const exposed = `
    return {
      ${EXPOSED.map((name) => `${name}: ${name},`).join("\n      ")}
      setClaimContexts: function (v) { claimContexts = v; },
      setCnSups: function (v) { cnSups = v; }
    };`;

  const config: Record<string, unknown> = {
    wgNamespaceNumber: 0,
    wgAction: "view",
    wgServer: "//en.wikipedia.org",
    wgContentLanguage: "en",
    wgPageName: "Karsten_Point_Lighthouse",
    wgCurRevisionId: 1,
    wgArticlePath: "/wiki/$1",
    ...overrides,
  };
  const mw = {
    config: { get: (key: string) => config[key] },
    util: { addCSS() {}, addPortletLink() {}, addPortlet() {}, getUrl: (t: string) => `/wiki/${t}` },
    loader: { using: () => ({ then: () => ({ catch() {} }) }), getScript: () => Promise.resolve() },
  };
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  // The boot sequence is a jQuery ready callback; swallowing it leaves the
  // module's pure functions defined and nothing else running.
  const jquery = () => ({ appendTo() {}, on() {}, text() {}, css() {}, append() {} });
  const factory = new Function(
    "mw",
    "window",
    "document",
    "localStorage",
    "$",
    "OO",
    body + exposed,
  ) as (...args: unknown[]) => UserScriptModule;

  return factory(
    mw,
    {},
    { addEventListener() {}, querySelectorAll: () => [] },
    localStorage,
    jquery,
    {},
  );
}

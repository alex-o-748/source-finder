/**
 * Runs the shipped user script, `userscript/cnfirmed.js`, the way it runs on a
 * Wikipedia page: over the rendered article, reading each claim from the DOM,
 * then its own wiki-local and Internet Archive stages through `fetch`.
 *
 * This is what an editor sees, so it is what the evaluation scores. The Node
 * core (the CLI) reads claims from wikitext instead and can be run for
 * comparison with `--engine core`.
 */
import { parseHTML } from "linkedom";
import { loadUserScript } from "../../test/userscriptLoader.js";
import type { EvalClaim } from "./dataset.js";

/** The rendered article body at the recorded revision, as MediaWiki serves it. */
export function renderUrl(lang: string, revid: number): string {
  return `https://${lang}.wikipedia.org/w/index.php?oldid=${revid}&action=render`;
}

export interface ScriptClaim {
  claim: string;
  context: string;
  section: string | null;
  links: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface ScriptArticle {
  /** Every rendered {{cn}} on the page, read the way the script reads it. */
  contexts: ScriptClaim[];
  /** Offsets of the {{cn}} tags in the wikitext, in page order. */
  offsets: { start: number; end: number }[];
  /** Whether the script could line rendered tags up with wikitext tags. */
  aligned: boolean;
  corpus: Json;
  findWiki(index: number): Json[];
  findArchive(index: number): Promise<{ candidates: Json[]; funnel: Json }>;
  /** The paid stage: one Claude call with web search, as the script makes it. */
  findWeb(index: number, apiKey: string): Promise<Json[]>;
  /**
   * The check of the Archive leads, as the script makes it: the judge model in
   * one call with the planner's restated claim, or the Verify API. A verdict
   * per lead (or null), and what gave them.
   */
  checkArchive(index: number, candidates: Json[], plan: Json | null): Promise<{ verdicts: Json[]; by: string }>;
  /**
   * The check of the other-language leads, as the script makes it: whether
   * each lead's sentence states the claim's fact, then the sources of those
   * that do, read through the Worker and judged. Per candidate, where it ends
   * up (`sisterOutcome`), or null for a same-article lead.
   */
  checkWiki(index: number, candidates: Json[]): Promise<{ outcomes: (Json | null)[]; by: string }>;
}

export async function loadScriptArticle(
  c: Pick<EvalClaim, "lang" | "title" | "revid">,
  window: Record<string, unknown> = {},
): Promise<ScriptArticle> {
  const res = await fetch(renderUrl(c.lang, c.revid));
  if (!res.ok) throw new Error(`rendered page: HTTP ${res.status}`);
  const html = await res.text();
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  const script = loadUserScript(
    {
      wgServer: `//${c.lang}.wikipedia.org`,
      wgContentLanguage: c.lang,
      wgPageName: c.title.replace(/ /g, "_"),
      wgTitle: c.title,
      wgCurRevisionId: c.revid,
    },
    { document, window },
  );
  const sups = Array.from(document.querySelectorAll("sup.Template-Fact"));
  script.setCnSups(sups);
  script.extractAllClaims();
  const corpus = await script.loadWikiCorpus();
  const offsets = script.citationNeededOffsets(corpus.local.wikitext) as { start: number; end: number }[];

  return {
    contexts: script.getClaimContexts(),
    offsets,
    aligned: !!corpus.claimOffsets,
    corpus,
    findWiki: (index) => script.findWikiCandidates(corpus, index),
    findArchive: (index) => script.findArchiveCandidates(index),
    findWeb: (index, apiKey) => script.callClaude(script.getClaimContexts()[index], apiKey),
    checkArchive: (index, candidates, plan) =>
      script.checkArchiveLeads(script.getClaimContexts()[index], plan, candidates),
    checkWiki: async (index, candidates) => {
      const ctx = script.getClaimContexts()[index];
      const isSister = (c: Json) => c.evidence?.origin === "sister-wiki";
      const leads = candidates.filter(isSister);
      if (!leads.length) return { outcomes: candidates.map(() => null), by: "" };
      const r = await script.checkSisterLeads(ctx, leads);
      leads.forEach((c: Json, k: number) => { c.check = r.verdicts[k]; });
      await script.checkSisterSources(ctx, leads);
      return {
        by: r.by,
        outcomes: candidates.map((c: Json) => isSister(c)
          ? { outcome: script.sisterOutcome(c, true), check: c.check ?? null, source: c.source ?? null }
          : null),
      };
    },
  };
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/**
 * Which rendered tag is the recorded one. When the script lines the page's
 * tags up with the wikitext's (the usual case), it is the tag at the same
 * position. Otherwise, the rendered claim sharing most words with the
 * recorded paragraph.
 */
export function indexOfClaim(article: ScriptArticle, c: EvalClaim): { index: number; how: string } {
  const byOffset = article.offsets.findIndex((o) => o.start === c.offset);
  if (article.aligned && byOffset !== -1) return { index: byOffset, how: "position" };
  const want = tokens(`${c.claim} ${c.context}`);
  let best = -1;
  let bestScore = 0;
  article.contexts.forEach((ctx, i) => {
    const have = tokens(ctx.claim);
    if (have.size === 0) return;
    let shared = 0;
    for (const t of have) if (want.has(t)) shared++;
    const score = shared / have.size;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return { index: best, how: best === -1 ? "not found" : `text overlap ${bestScore.toFixed(2)}` };
}

/**
 * Hints for one article: for every {{citation needed}} claim, the Internet
 * Archive books whose passages a model checked and found to state it.
 *
 * This is the user script's book search (src/core/archiveSources.ts with the
 * librarian) plus its check (judgeArchiveBooks), run ahead of time so that a
 * tool such as Citation Hunt can look the answer up instantly. Only books the
 * check passed, with words verified to be in their passages, are kept: a hint
 * shown to someone who has never heard of CNfirmed has to be right more often
 * than a lead in CNfirmed's own panel.
 */

import { claimTerms, findArchiveCandidates, viewerUrl } from "../core/archiveSources.js";
import {
  DEFAULT_LIBRARIAN_MODELS,
  judgeArchiveBooks,
  type ArchiveVerdict,
  type ChatClient,
  type LibrarianModels,
} from "../core/archiveLibrarian.js";
import { completeFromCitoid } from "../core/citoid.js";
import { extractClaims } from "../core/extractClaims.js";
import type { ArchiveClient } from "../core/internetArchive.js";
import type { ArchiveCandidate, Citation, Claim } from "../core/types.js";
import { claimProse } from "./match.js";

/** Bumped when what is computed changes, so the batch job knows a stored page is stale. */
export const PIPELINE_VERSION = 1;

export interface BookHint {
  verdict: "supports" | "partial";
  /** Words from the book's passage that state the claim, checked to be in its OCR text. */
  quote: string;
  title: string;
  year: number | null;
  /** "borrow": readable with a free archive.org account. */
  access: "open" | "borrow";
  /** The book in the Archive's viewer, searched for the quote. */
  url: string;
  identifier: string;
  /** A ready `<ref>{{cite book …}}</ref>`, linking to `url`. */
  cite: string;
}

export interface ClaimHints {
  /** The claim's sentence as a reader sees it (no wiki markup): what a request's text is matched against. */
  claim: string;
  section: string | null;
  /**
   * "checked": the leads were checked (`books` may still be empty).
   * "no_leads": the search found no book to check.
   * "error": the search or the check failed; the batch job tries again.
   */
  status: "checked" | "no_leads" | "error";
  books: BookHint[];
  /** Books the check read for this claim. */
  checked: number;
  /** Every book checked and its verdict: for labelling a pilot, not served by the API. */
  verdicts?: { identifier: string; title: string; verdict: ArchiveVerdict["verdict"] | null; reason: string }[];
  error?: string;
}

export interface PageHints {
  version: number;
  wiki: string;
  pageId: number;
  title: string;
  revId: number;
  computedAt: string;
  claims: ClaimHints[];
}

export interface PageInput {
  wiki: string;
  pageId: number;
  title: string;
  revId: number;
  wikitext: string;
}

export interface ComputeDeps {
  chat: ChatClient;
  /** The Archive client; the live one unless given. */
  archive?: ArchiveClient;
  models?: Partial<LibrarianModels>;
  /** Books kept per claim (default 1: the hint names one book). */
  maxBooks?: number;
  /** Fills a citation from the wiki's Citoid; the live one unless given. */
  completeCitation?: (citation: Citation, lang: string) => Promise<Citation>;
  /** Called after each claim, for progress output. */
  onClaim?: (done: number, total: number, hints: ClaimHints) => void;
}

const RANK: Record<ArchiveVerdict["verdict"], number> = { supports: 0, partial: 1, unsupported: 2 };

/** The books a check passed, best first: "supports" before "partial", then by passage score. */
export function keptBooks(
  candidates: ArchiveCandidate[],
  verdicts: (ArchiveVerdict | null)[],
): { candidate: ArchiveCandidate; verdict: ArchiveVerdict }[] {
  return candidates
    .map((candidate, i) => ({ candidate, verdict: verdicts[i] ?? null }))
    .filter(
      (b): b is { candidate: ArchiveCandidate; verdict: ArchiveVerdict } =>
        !!b.verdict && b.verdict.verdict !== "unsupported" && !!b.verdict.quote.trim(),
    )
    .sort(
      (a, b) =>
        RANK[a.verdict.verdict] - RANK[b.verdict.verdict] || b.candidate.evidence.score - a.candidate.evidence.score,
    );
}

/** A kept book as a hint: the viewer link searched for the checked quote, in the citation too. */
export function toBookHint(
  candidate: ArchiveCandidate,
  verdict: ArchiveVerdict,
  claim: string,
  articleTitle: string,
  citation: Citation = candidate.citation,
): BookHint {
  const url = viewerUrl(candidate.url, verdict.quote, claimTerms(claim, articleTitle));
  const old = candidate.evidence.viewerUrl;
  return {
    verdict: verdict.verdict as "supports" | "partial",
    quote: verdict.quote,
    title: candidate.title,
    year: candidate.evidence.year,
    access: candidate.evidence.access,
    url,
    identifier: candidate.evidence.identifier,
    cite: old ? citation.ref.split(old).join(url) : citation.ref,
  };
}

export async function computeClaimHints(claim: Claim, page: PageInput, deps: ComputeDeps): Promise<ClaimHints> {
  const base = { claim: claimProse(claim.claim), section: claim.section };
  const judge = deps.models?.judge === undefined ? DEFAULT_LIBRARIAN_MODELS.judge : deps.models.judge;
  if (!judge) throw new Error("A judge model is needed: hints are only ever books a model checked.");
  try {
    const found = await findArchiveCandidates(claim, page.title, {
      ...(deps.archive && { client: deps.archive }),
      librarian: { client: deps.chat, ...(deps.models && { models: deps.models }) },
    });
    if (!found.candidates.length) return { ...base, status: "no_leads", books: [], checked: 0 };

    const verdicts = await judgeArchiveBooks(
      {
        articleTitle: page.title,
        section: claim.section,
        paragraph: claim.context,
        claim: claim.claim,
        fact: found.funnel.librarian?.plan?.fact || null,
      },
      found.candidates.map((c) => ({ title: c.title, year: c.evidence.year, passages: c.evidence.passages })),
      deps.chat,
      judge,
    );
    const complete = deps.completeCitation ?? completeFromCitoid;
    const books: BookHint[] = [];
    for (const { candidate, verdict } of keptBooks(found.candidates, verdicts).slice(0, deps.maxBooks ?? 1)) {
      const citation = await complete(candidate.citation, page.wiki);
      books.push(toBookHint(candidate, verdict, claim.claim, page.title, citation));
    }
    const all = found.candidates.map((c, i) => ({
      identifier: c.evidence.identifier,
      title: c.title,
      verdict: verdicts[i]?.verdict ?? null,
      reason: verdicts[i]?.reason ?? "",
    }));
    return { ...base, status: "checked", books, checked: found.candidates.length, verdicts: all };
  } catch (err) {
    return { ...base, status: "error", books: [], checked: 0, error: (err as Error).message };
  }
}

/** Every claim in the page, one after another: the Archive is a shared, donated service. */
export async function computePageHints(page: PageInput, deps: ComputeDeps, now = () => new Date()): Promise<PageHints> {
  const claims = extractClaims(page.wikitext);
  const out: ClaimHints[] = [];
  for (const claim of claims) {
    const hints = await computeClaimHints(claim, page, deps);
    out.push(hints);
    deps.onClaim?.(out.length, claims.length, hints);
  }
  return {
    version: PIPELINE_VERSION,
    wiki: page.wiki,
    pageId: page.pageId,
    title: page.title,
    revId: page.revId,
    computedAt: now().toISOString(),
    claims: out,
  };
}

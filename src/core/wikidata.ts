/**
 * Wikidata as a citation source for {{citation needed}} claims.
 *
 * Many tagged sentences are entity-attribute facts — a founding year, a
 * population, a height, a birthplace — and Wikidata frequently holds the same
 * statement *with a reference already attached by an editor*. Lifting that
 * reference is free, needs no model, and targets exactly the claims the
 * sentence-matching passes in `wikiSources.ts` are worst at: a bare number in a
 * short sentence has too little vocabulary to match on, but it is precisely
 * what a Wikidata value comparison keys off.
 *
 * Two things make this cheap. The paragraph's wikilinks are already
 * disambiguated entities, so `pageprops` turns them into QIDs with no entity
 * recognition step; and matching a decoded value against a claim is exact
 * comparison, not similarity — a year either appears in the sentence or it
 * does not.
 *
 * The hard rule here is WP:CIRCULAR. A large share of Wikidata's references
 * are "imported from Wikipedia", which cite the very encyclopedia we are
 * trying to source. Those are discarded outright — see `isCircularReference`.
 */

import { mwHostApi } from "./mediawiki.js";
import { normaliseDigits } from "./relevance.js";
import type { RefSource } from "./wikitextRefs.js";

const WIKIDATA_HOST = "www.wikidata.org";

/** `wbgetentities` accepts 50 ids per request for anonymous clients. */
const IDS_PER_REQUEST = 50;

// -- The slice of the Wikidata JSON model this module reads --

export interface WdSnak {
  snaktype: "value" | "novalue" | "somevalue";
  property: string;
  datavalue?: { value: unknown; type: string };
}

export interface WdReference {
  snaks: Record<string, WdSnak[]>;
}

export interface WdStatement {
  mainsnak: WdSnak;
  rank?: "preferred" | "normal" | "deprecated";
  references?: WdReference[];
}

export interface WdEntity {
  id: string;
  labels?: Record<string, { language: string; value: string }>;
  claims?: Record<string, WdStatement[]>;
  missing?: string;
}

/** A decoded statement value, in the shapes worth matching against prose. */
export type WdValue =
  | { kind: "time"; year: string; iso: string; precision: number }
  | { kind: "quantity"; amount: string }
  | { kind: "item"; id: string }
  | { kind: "text"; text: string };

// -- Reference properties --

/** Reference URL. */
const P_REFERENCE_URL = "P854";
/** Stated in (an item: the work being cited). */
const P_STATED_IN = "P248";
/** Title of the cited work. */
const P_TITLE = "P1476";
const P_DOI = "P356";
const P_PMID = "P698";
const P_PMC = "P932";
const P_PUBLISHER = "P123";
const P_AUTHOR = "P50";
const P_AUTHOR_NAME = "P2093";
const P_PUBLICATION_DATE = "P577";
const P_RETRIEVED = "P813";

/**
 * Properties that mark a reference as a Wikimedia import rather than a source.
 * A statement referenced only by these is citing Wikipedia for Wikipedia.
 */
const CIRCULAR_PROPERTIES = new Set([
  "P143", // imported from Wikimedia project
  "P4656", // Wikimedia import URL
  "P3452", // inferred from — a derivation, not a source
]);

/** Hosts that cannot substantiate a Wikipedia claim: Wikimedia's own. */
const CIRCULAR_HOSTS =
  /(?:^|\.)(?:wikipedia|wikidata|wikimedia|wikisource|wikiquote|wikivoyage|wiktionary)\.org$/i;

/** Fetches entities by QID, in batches. Missing ids are simply absent. */
export async function fetchEntities(
  ids: string[],
  options: { languages?: string[]; props?: string[] } = {},
): Promise<Map<string, WdEntity>> {
  const out = new Map<string, WdEntity>();
  const unique = [...new Set(ids.filter((id) => /^[QP]\d+$/.test(id)))];
  if (unique.length === 0) return out;

  const languages = [...new Set([...(options.languages ?? []), "en"])];
  for (let i = 0; i < unique.length; i += IDS_PER_REQUEST) {
    const batch = unique.slice(i, i + IDS_PER_REQUEST);
    const data = await mwHostApi<{ entities?: Record<string, WdEntity> }>(
      WIKIDATA_HOST,
      {
        action: "wbgetentities",
        ids: batch.join("|"),
        props: (options.props ?? ["claims", "labels"]).join("|"),
        languages: languages.join("|"),
        languagefallback: "1",
      },
    );
    for (const [id, entity] of Object.entries(data.entities ?? {})) {
      if (entity.missing !== undefined) continue;
      out.set(id, entity);
    }
  }
  return out;
}

/** An entity's label in the first available language, or its id. */
export function labelOf(
  entity: WdEntity | undefined,
  languages: string[],
): string | null {
  if (!entity?.labels) return null;
  for (const lang of [...languages, "en"]) {
    const label = entity.labels[lang]?.value;
    if (label) return label;
  }
  const first = Object.values(entity.labels)[0]?.value;
  return first ?? null;
}

/** Decodes a snak's value into a comparable shape, or null if not comparable. */
export function decodeSnak(snak: WdSnak): WdValue | null {
  if (snak.snaktype !== "value" || !snak.datavalue) return null;
  const { value, type } = snak.datavalue;

  if (type === "time") {
    const time = (value as { time?: string; precision?: number }).time;
    const precision = (value as { precision?: number }).precision ?? 0;
    // Below year precision (decade, century) there is no figure in the prose
    // to compare against, and BCE dates are not worth the sign handling.
    if (!time || precision < 9 || !time.startsWith("+")) return null;
    const m = /^\+(\d{4,})-(\d{2})-(\d{2})/.exec(time);
    if (!m) return null;
    const year = String(Number(m[1]));
    const iso =
      precision >= 11 ? `${m[1]}-${m[2]}-${m[3]}`
      : precision === 10 ? `${m[1]}-${m[2]}`
      : year;
    return { kind: "time", year, iso, precision };
  }

  if (type === "quantity") {
    const amount = (value as { amount?: string }).amount;
    if (!amount) return null;
    return { kind: "quantity", amount };
  }

  if (type === "wikibase-entityid") {
    const id = (value as { id?: string }).id;
    if (!id) return null;
    return { kind: "item", id };
  }

  if (type === "string") return { kind: "text", text: String(value) };
  if (type === "monolingualtext") {
    const text = (value as { text?: string }).text;
    if (!text) return null;
    return { kind: "text", text };
  }
  return null;
}

/** Separators that group or decimalise digits, across locales. */
const FIGURE_SEPARATORS = /[.,\u00a0\u202f\u2009']/g;

/**
 * Every figure in a claim, keyed the way `quantityKeys` keys a stored amount:
 * separators stripped, so "616,093" and the German "616.093" both key as
 * "616093".
 *
 * Deliberately not `anchorsOf`. That tokeniser splits on punctuation, so it
 * reads "616,093" as the two anchors "616" and "093" — which is right for
 * cross-language sentence matching, where grouping separators differ by locale
 * and the groups are what survive translation, and wrong here, where the
 * figure is compared exactly against a value. Using it was the reason this
 * pass never matched a population, area or elevation: every grouped figure in
 * an article missed.
 *
 * A plain space is not treated as a separator — "in 2022 15 people" must not
 * key as "202215".
 */
export function claimFigures(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\d(?:[\d.,\u00a0\u202f\u2009']*\d)?/g;
  const src = normaliseDigits(text);
  for (;;) {
    const m = re.exec(src);
    if (!m) break;
    const digits = m[0].replace(FIGURE_SEPARATORS, "");
    // Single digits are everywhere in prose; they are not evidence.
    if (digits.length >= 2) out.add(digits);
  }
  return out;
}

/**
 * Digit strings a stored value should be looked for under, normalised to match
 * `claimFigures`. The integer part is offered too: prose rounds ("324 metres"
 * for a stored 324.8), and that is a real match, just a weaker one.
 */
export function quantityKeys(amount: string): { exact: string; whole: string } {
  const digits = amount.replace(/^[+-]/, "");
  return {
    exact: digits.replace(FIGURE_SEPARATORS, ""),
    whole: digits.split(".")[0].replace(FIGURE_SEPARATORS, ""),
  };
}

/** Human-readable rendering of a value, for the evidence shown to an editor. */
export function renderValue(
  value: WdValue,
  labels: Map<string, string> = new Map(),
): string {
  switch (value.kind) {
    case "time":
      return value.iso;
    case "quantity":
      return value.amount.replace(/^\+/, "");
    case "item":
      return labels.get(value.id) ?? value.id;
    case "text":
      return value.text;
  }
}

/** True when a reference cites Wikimedia itself, or nothing external at all. */
export function isCircularReference(ref: WdReference): boolean {
  const properties = Object.keys(ref.snaks ?? {});
  if (properties.length === 0) return true;
  if (properties.every((p) => CIRCULAR_PROPERTIES.has(p))) return true;

  // An explicit Wikimedia URL is circular even alongside other fields.
  for (const snak of ref.snaks[P_REFERENCE_URL] ?? []) {
    const decoded = decodeSnak(snak);
    if (decoded?.kind !== "text") continue;
    try {
      if (CIRCULAR_HOSTS.test(new URL(decoded.text).hostname)) return true;
    } catch {
      // An unparseable URL is judged by the other fields.
    }
  }
  return false;
}

/** First decoded value for a property in a reference, if any. */
function refValue(ref: WdReference, property: string): WdValue | null {
  for (const snak of ref.snaks[property] ?? []) {
    const decoded = decodeSnak(snak);
    if (decoded) return decoded;
  }
  return null;
}

function refText(ref: WdReference, property: string): string | null {
  const value = refValue(ref, property);
  if (!value) return null;
  if (value.kind === "text") return value.text;
  if (value.kind === "time") return value.iso;
  return null;
}

/** Escapes pipes so a value cannot break out of its template parameter. */
function escapePipes(value: string): string {
  return value.replace(/\|/g, "{{!}}");
}

/**
 * Turns a Wikidata reference into the same `RefSource` shape the wikitext
 * parser produces, so downstream formatting and de-duplication need no special
 * case for it.
 *
 * Returns null when the reference is circular or names no identifiable work —
 * a bare "retrieved on" with no URL is not a lead.
 */
export function referenceToSource(
  ref: WdReference,
  labels: Map<string, string> = new Map(),
): RefSource | null {
  if (isCircularReference(ref)) return null;

  let url = refText(ref, P_REFERENCE_URL);
  const doi = refText(ref, P_DOI);
  const pmid = refText(ref, P_PMID);
  const pmc = refText(ref, P_PMC);
  // Identifiers resolve to a fetchable page, which is what makes the lead
  // checkable rather than merely citable.
  if (!url && doi) url = `https://doi.org/${doi}`;
  if (!url && pmid) url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  if (!url && pmc) url = `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc}/`;

  const statedIn = refValue(ref, P_STATED_IN);
  const work =
    statedIn?.kind === "item" ? (labels.get(statedIn.id) ?? null) : null;
  const title = refText(ref, P_TITLE) ?? work;
  // Nothing to name and nothing to open: not a lead an editor could act on.
  if (!title && !url) return null;

  const authorItem = refValue(ref, P_AUTHOR);
  const author =
    refText(ref, P_AUTHOR_NAME) ??
    (authorItem?.kind === "item" ? (labels.get(authorItem.id) ?? null) : null);
  const publisherItem = refValue(ref, P_PUBLISHER);
  const publisher =
    publisherItem?.kind === "item"
      ? (labels.get(publisherItem.id) ?? null)
      : null;
  const date = refText(ref, P_PUBLICATION_DATE);
  const retrieved = refText(ref, P_RETRIEVED);

  const kind = doi || pmid || pmc ? "cite journal" : url ? "cite web" : "cite book";
  const parts = [kind];
  if (url) parts.push(`url=${url}`);
  parts.push(`title=${escapePipes(title ?? url ?? "")}`);
  if (work && work !== title) parts.push(`work=${escapePipes(work)}`);
  if (author) parts.push(`author=${escapePipes(author)}`);
  if (publisher) parts.push(`publisher=${escapePipes(publisher)}`);
  if (date) parts.push(`date=${escapePipes(date)}`);
  if (doi) parts.push(`doi=${escapePipes(doi)}`);
  if (pmid) parts.push(`pmid=${escapePipes(pmid)}`);
  if (url && retrieved) parts.push(`access-date=${escapePipes(retrieved)}`);

  return {
    url,
    title,
    work: work ?? publisher,
    author,
    date,
    quote: null,
    template: kind,
    shortFootnote: false,
    raw: `{{${parts.join(" |")}}}`,
  };
}

/** Every QID a reference mentions, so their labels can be fetched in one batch. */
export function referencedItemIds(ref: WdReference): string[] {
  const out: string[] = [];
  for (const property of [P_STATED_IN, P_PUBLISHER, P_AUTHOR]) {
    const value = refValue(ref, property);
    if (value?.kind === "item") out.push(value.id);
  }
  return out;
}

/**
 * Whether a claim asserts this value. Exact comparison rather than similarity:
 * the figure is either in the sentence or it is not, which is what makes this
 * pass free and why it works on sentences too short to match lexically.
 *
 * `claimNumbers` is a `claimFigures(...)` set; `linkedQids` are the Wikidata
 * ids of the wikilinks in the tagged paragraph.
 */
export function matchValue(
  value: WdValue,
  claimNumbers: Set<string>,
  linkedQids: Set<string>,
): { score: number; anchor: string } | null {
  switch (value.kind) {
    case "time": {
      if (!claimNumbers.has(value.year)) return null;
      // A day-precision date whose day is also in the sentence is a far
      // tighter match than a bare year, which two unrelated facts about the
      // same entity can easily share.
      const day = Number(value.iso.slice(8, 10));
      const dayHit =
        value.precision >= 11 && day > 0 && claimNumbers.has(String(day));
      return { score: dayHit ? 0.95 : 0.8, anchor: value.year };
    }
    case "quantity": {
      const { exact, whole } = quantityKeys(value.amount);
      // Single digits are everywhere in prose; they are not evidence.
      if (exact.length >= 2 && claimNumbers.has(exact)) {
        return { score: 0.9, anchor: exact };
      }
      // Prose rounds: "324 metres" for a stored 324.8 is a real match, weaker.
      if (whole.length >= 2 && claimNumbers.has(whole)) {
        return { score: 0.75, anchor: whole };
      }
      return null;
    }
    case "item":
      return linkedQids.has(value.id)
        ? { score: 0.85, anchor: value.id }
        : null;
    case "text":
      // Free strings and external identifiers are not the kind of fact a
      // {{citation needed}} tag marks.
      return null;
  }
}

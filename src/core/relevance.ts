/**
 * Deterministic relevance scoring for the wiki-local source finders.
 *
 * No model, no embeddings — the wiki-local layer has to stay free to run, so
 * "does this reference look like it is about this claim?" is answered with
 * weighted token overlap, and "is this the same sentence in another language?"
 * is answered with anchors that survive translation (numbers, names, and
 * wikilink targets mapped through interlanguage links).
 */

/** A bag of tokens with per-token discriminative weights. */
export type TokenBag = Map<string, number>;

/**
 * Very common words across the large Latin-script Wikipedias. Tokens shorter
 * than three characters are dropped anyway, so this only needs the long ones.
 */
const STOPWORDS = new Set(
  (
    "the and for that with from this was were are has have had not but they " +
    "his her its their our your which who whom whose been being other than " +
    "into over under after before during between about above below such more " +
    "most some any all can could would should may might will shall must " +
    "also however therefore because since while when where what how why " +
    "der die das den dem des und ist sind war waren nicht auch aber oder " +
    "les des une del las los por para con como que qui est sont pour dans " +
    "sur avec plus mais nel della delle degli sono come anche per " +
    "van het een voor met zijn niet ook maar " +
    "article page site www http https com org net html pdf archived retrieved " +
    "cite citation isbn issn doi accessed"
  ).split(/\s+/),
);

const DIGIT_MAP: Record<string, string> = {};
for (const base of [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50, 0xff10]) {
  for (let d = 0; d <= 9; d++) {
    DIGIT_MAP[String.fromCodePoint(base + d)] = String(d);
  }
}

/** Maps non-ASCII digits to ASCII so numeric anchors survive script changes. */
export function normaliseDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹०-९০-৯๐-๙０-９]/g, (c) => DIGIT_MAP[c] ?? c);
}

/** Lower-cases and strips combining marks, so "Zürich" matches "Zurich". */
export function fold(text: string): string {
  return normaliseDigits(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Splits text into raw word tokens, preserving original case. */
export function words(text: string): string[] {
  return normaliseDigits(text)
    .replace(/[‘’“”]/g, "'")
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter((w) => w.length > 0);
}

/** True for tokens that carry meaning: long enough, or numeric, and not a stopword. */
function isContentToken(folded: string): boolean {
  if (STOPWORDS.has(folded)) return false;
  if (/\d/.test(folded)) return true;
  return folded.length >= 3;
}

/**
 * How discriminative a token is. Numbers — especially years — are the strongest
 * signal a reference is about the same fact; capitalised words are usually
 * proper nouns; everything else is ordinary vocabulary.
 */
function tokenWeight(raw: string, folded: string): number {
  if (/^\d{3,4}$/.test(folded)) return 3;
  if (/\d/.test(folded)) return 2.5;
  if (/^\p{Lu}/u.test(raw)) return 1.8;
  return 1;
}

/**
 * Builds a weighted bag from text. `background` names tokens that are true of
 * the whole article (its title, the section heading) and therefore say nothing
 * about *which* reference is the right one; they are kept but discounted.
 */
export function weightedTokens(text: string, background?: Set<string>): TokenBag {
  const bag: TokenBag = new Map();
  for (const raw of words(text)) {
    const folded = fold(raw);
    if (!isContentToken(folded)) continue;
    let weight = tokenWeight(raw, folded);
    if (background?.has(folded)) weight *= 0.3;
    bag.set(folded, Math.max(bag.get(folded) ?? 0, weight));
  }
  return bag;
}

/** The folded content tokens of a text, for use as a `background` set. */
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of words(text)) {
    const folded = fold(raw);
    if (isContentToken(folded)) out.add(folded);
  }
  return out;
}

/**
 * Fraction of the query's weight that `target` covers, in [0, 1]. Coverage
 * rather than similarity: a long reference title is not penalised for saying
 * more than the claim does.
 */
export function coverage(query: TokenBag, target: string | Set<string>): number {
  if (query.size === 0) return 0;
  const have = typeof target === "string" ? tokenSet(target) : target;
  let total = 0;
  let matched = 0;
  for (const [token, weight] of query) {
    total += weight;
    if (have.has(token)) matched += weight;
  }
  return total === 0 ? 0 : matched / total;
}

/**
 * Anchors are the parts of a sentence that survive translation: numbers and
 * dates, and proper nouns that are spelled the same in the target language.
 * They are what lets a claim be located in another language edition without a
 * translation model.
 */
export interface Anchors {
  /** Numeric tokens: years, quantities, dates. */
  numbers: string[];
  /** Capitalised words and multi-word names, folded. */
  names: string[];
}

/** Extracts translation-stable anchors from a piece of plain text. */
export function anchorsOf(text: string): Anchors {
  const src = normaliseDigits(text).replace(/[\u2018\u2019\u201c\u201d]/g, "'");
  const numbers = new Set<string>();
  const names = new Set<string>();
  const re = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
  let run: string[] = [];
  let runEnd = -1;
  const flush = (): void => {
    if (run.length > 0) {
      names.add(fold(run.join(" ")));
      if (run.length > 1) for (const part of run) names.add(fold(part));
      run = [];
    }
  };
  for (;;) {
    const m = re.exec(src);
    if (!m) break;
    const raw = m[0];
    const folded = fold(raw);

    if (/^\d[\d,.]*$/.test(folded)) {
      const digits = folded.replace(/[,.]/g, "");
      if (digits.length >= 2) numbers.add(digits);
      flush();
      continue;
    }

    // A capitalised word right after sentence-ending punctuation (or at the
    // very start) is capitalised by grammar, not because it is a name.
    const before = src.slice(0, m.index);
    const sentenceInitial = /(?:^|[.!?\u3002\uff01\uff1f]|\n)\s*["'(\u00ab]?$/.test(before);
    const capitalised = /^\p{Lu}/u.test(raw);

    if (capitalised && folded.length >= 3 && !STOPWORDS.has(folded) && !sentenceInitial) {
      // Only continue a run when the words are adjacent in the source text.
      if (run.length > 0 && !/^[ \u00a0-]*$/.test(src.slice(runEnd, m.index))) flush();
      run.push(raw);
      runEnd = m.index + raw.length;
      continue;
    }
    flush();
  }
  flush();
  return { numbers: [...numbers], names: [...names] };
}

/** Total number of distinct anchors. */
export function anchorCount(a: Anchors): number {
  return a.numbers.length + a.names.length;
}

/**
 * How much of `query`'s anchor set appears in `text`. Numbers count double:
 * a matching year is far better evidence of "the same fact" than a matching
 * surname, which may just mean "the same article".
 */
export function anchorScore(
  query: Anchors,
  text: string,
  extraNames: string[] = [],
): { score: number; matched: string[] } {
  const folded = fold(text);
  const have = tokenSet(text);
  const matched = new Set<string>();
  let total = 0;
  let hit = 0;
  for (const n of new Set(query.numbers)) {
    total += 2;
    if (have.has(n) || folded.includes(n)) {
      hit += 2;
      matched.add(n);
    }
  }
  for (const name of new Set([...query.names, ...extraNames.map(fold)])) {
    total += 1;
    if (name.includes(" ") ? folded.includes(name) : have.has(name)) {
      hit += 1;
      matched.add(name);
    }
  }
  return { score: total === 0 ? 0 : hit / total, matched: [...matched] };
}

/**
 * Whether a text is predominantly Latin-script. Source-language proper nouns
 * only work as cross-lingual anchors when the target wiki writes them the same
 * way, so this gates whether they are worth scoring at all.
 */
export function isLatinScript(text: string): boolean {
  const sample = text.slice(0, 4000);
  const letters = sample.match(/\p{L}/gu);
  if (!letters || letters.length < 20) return true;
  const latin = sample.match(/\p{Script=Latin}/gu);
  return (latin?.length ?? 0) / letters.length > 0.6;
}

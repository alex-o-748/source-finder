/**
 * A small stubbed world for the librarian's tests: the Worker's model replies,
 * archive.org's full-text and catalogue searches, and item metadata, all
 * answered from here through a replacement `fetch`. Both the core and the user
 * script call the global `fetch`, so one stub drives both, and the parity test
 * can compare what they make of it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BOOKS_SYSTEM, JUDGE_SYSTEM, PLAN_SYSTEM } from "../src/core/archiveLibrarian.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SEARCH = JSON.parse(readFileSync(join(__dirname, "fixtures/archive/search_eiffel_1889.json"), "utf8"));

export const CLAIM = "On its completion in 1889 the tower was 300 metres tall, designed under Gustave Eiffel.";
export const PARAGRAPH = `The tower was built for the Exposition Universelle. ${CLAIM}`;

export const PLAN = {
  fact: "The Eiffel Tower was 300 metres tall on its completion in 1889, designed under Gustave Eiffel.",
  queries: ['"Eiffel Tower" completed 1889', '"300 metres" Eiffel 1889'],
  terms: [["1889"], ["Eiffel", "Eiffel Tower"], ["300 metres", "300 meters", "984 feet"], ["completed", "completion", "finished"]],
};

export const BOOKS = {
  books: [
    { title: "La tour de trois cents mètres", author: "Eiffel", year: 1900 },
    { title: "The Eiffel Tower: a tour de force", author: "Henri Loyrette", year: 1985 },
    { title: "A book nobody wrote", author: "Nobody", year: 2001 },
  ],
};

function hit(identifier: string, title: string, creator: string | null, collection: string[], highlights: string[], year: number | null = null) {
  return {
    fields: { identifier, title, creator: creator ? [creator] : undefined, year, mediatype: "texts", collection },
    highlight: { text: highlights.map((t) => t.replace(/(1889|Eiffel)/g, "{{{$1}}}")) },
  };
}

/** What the planner's queries find. */
const PLANNED = {
  response: {
    body: {
      hits: {
        total: 4,
        hits: [
          // A book about the claim: its passages give the concepts and the name.
          hit("tourdetroiscents00eiff", "La tour de trois cents mètres", "Eiffel, Gustave, 1832-1923", ["americana"], [
            "The Eiffel tower, completed in 1889, rose 300 metres above the Champ de Mars.",
          ], 1900),
          // Two concepts, but nothing names the tower or Eiffel: not a lead.
          hit("cablecatalogue1889", "Trade catalogue", null, ["americana"], ["Price list for 1889: completed orders of 300 metres of cable."]),
          // About the claim, but its identifier cannot be searched inside.
          hit("in.ernet.dli.2015.1234", "Paris guide", null, ["digitallibraryindia"], [
            "The Eiffel Tower, finished in 1889, is 300 metres high.",
          ]),
          // Already the search's own lead.
          hit("eiffeltowerdescr00tiss", "The Eiffel tower : a description of the monument", null, ["americana"], [
            "Eiffel completed the tower in 1889.",
          ]),
          // Only print-disabled readers may open it.
          hit("eiffelprintdis00", "Eiffel's tower", null, ["printdisabled"], ["Eiffel completed it in 1889, 300 metres tall."]),
        ],
      },
    },
  },
};

/** Catalogue records, by the author the query asks for. */
const CATALOGUE: Record<string, unknown[]> = {
  Eiffel: [
    // Its dotted identifier cannot be searched inside: skipped.
    { identifier: "in.ernet.dli.2015.9999", title: "La tour de trois cents metres", creator: "Eiffel", collection: ["digitallibraryindia"], mediatype: "texts" },
    // The same work as a planner lead: not added twice.
    { identifier: "tourtroiscents1900", title: "La tour de trois cents mètres", creator: "Eiffel, Gustave", collection: ["americana"], mediatype: "texts", year: "1900" },
  ],
  Loyrette: [
    // The first scan is not in the full-text index; the second is.
    { identifier: "eiffeltowertour0000loyr", title: "The Eiffel Tower : a tour de force", creator: "Loyrette, Henri", collection: ["inlibrary", "printdisabled"], mediatype: "texts", year: "1985" },
    { identifier: "eiffeltowertour0000loyr_b2c3", title: "The Eiffel Tower : a tour de force", creator: "Loyrette, Henri", collection: ["inlibrary", "printdisabled"], mediatype: "texts", year: "1985" },
  ],
};

/**
 * What the Worker's search inside page by page finds, by book: the book's
 * name inside its item, how sure the Archive is of its page numbers, and per
 * term (as the client quotes it) the paragraphs, as [leaf, printed page, text].
 * Open books only: the client never asks for a borrowable one.
 */
export const PAGE_P1 =
  "On 31 March 1889 the tower was completed, and Eiffel climbed to its summit, 300 metres above the Champ de Mars, to raise the flag.";
export const PAGE_P2 =
  "The Eiffel tower, completed this spring of 1889, rises 300 metres above the Champ de Mars, more than twice the height of the Washington Monument.";
export const PAGES: Record<string, { doc?: string; pageConfidence: number | null; matches: Record<string, [number, string | null, string][]> }> = {
  tourdetroiscents00eiff: {
    pageConfidence: 97,
    matches: {
      "1889": [[12, "iv", "Paris: Imprimerie Lemercier, 1889."], [57, "41", PAGE_P1]],
      '"300 metres"': [[57, "41", PAGE_P1]],
    },
  },
  // Its paragraph holds the planner's highlight, which goes.
  "in.ernet.dli.2015.1234": {
    doc: "2015.1234.Paris-Guide",
    pageConfidence: null,
    matches: { "1889": [[12, null, "The Eiffel Tower, finished in 1889, is 300 metres high, and from its summit all Paris may be seen."]] },
  },
  // Not a lead: its highlights show the tower but not the claim; a page does.
  "sim_scientific-american_1889-05-18_60_20": {
    pageConfidence: 99,
    matches: {
      "1889": [[14, "306", PAGE_P2]],
      Eiffel: [[14, "306", PAGE_P2]],
    },
  },
  // Numbered, but the Archive is unsure of it: the leaf only.
  eiffeltowerdescr00tiss: {
    pageConfidence: 30,
    matches: { Eiffel: [[33, "15", "The work was begun in January 1887; Eiffel's firm completed it in 1889, at a cost of six and a half million francs."]] },
  },
};

/** The Worker's answer for a search inside, merged across terms as it merges them. */
function insideReply(url: string, opts: WorldOptions): Response {
  const u = new URL(url);
  const id = u.searchParams.get("id") ?? "";
  const status = opts.insideStatus?.[id];
  if (status) return Response.json({ error: { code: "upstream_error", message: "x" } }, { status });
  const book = PAGES[id];
  if (!book) return Response.json({ error: { code: "no_text", message: "no searchable text" } }, { status: 404 });
  const q = u.searchParams.getAll("q");
  const seen = new Map<string, { text: string; terms: number[]; leaf: number; page: string | null }>();
  q.forEach((term, i) => {
    for (const [leaf, page, text] of book.matches[term] ?? []) {
      const key = `${leaf} ${text}`;
      const m = seen.get(key) ?? { text, terms: [], leaf, page };
      m.terms.push(i);
      seen.set(key, m);
    }
  });
  const matches = [...seen.values()].sort((a, b) => b.terms.length - a.terms.length || a.leaf - b.leaf);
  return Response.json({
    id,
    doc: u.searchParams.get("doc") ?? book.doc ?? id,
    q,
    counts: q.map((t) => (book.matches[t] ?? []).length),
    pageConfidence: book.pageConfidence,
    matches,
  });
}

/** What a search inside finds, by book and term. */
const INSIDE: Record<string, Record<string, string[]>> = {
  "eiffeltowertour0000loyr_b2c3": {
    "1889": ["When it was completed in 1889 the tower stood 300 metres tall, the tallest structure in the world."],
    Eiffel: ["Gustave Eiffel's firm designed and built the tower."],
  },
  tourdetroiscents00eiff: { "1889": ["Inauguration of the tower, 31 March 1889."] },
  eiffeltower0000pezz: { "300 metres": ["The tower is 300 metres tall without its antennas."] },
};

export interface WorldOptions {
  /** The judge's reply, or a status to fail with. */
  judge?: unknown;
  judgeStatus?: number;
  /** Fail the planner call with this status. */
  plannerStatus?: number;
  /** Fail the search inside page by page of these books with these statuses. */
  insideStatus?: Record<string, number>;
}

export interface Sent {
  url: string;
  body?: Record<string, unknown>;
}

/** A `fetch` answering for the whole world; every request is recorded in `sent`. */
export function worldFetch(sent: Sent[], opts: WorldOptions = {}): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    sent.push({ url, body });
    const reply = (content: string) => Response.json({ choices: [{ message: { content } }] });

    if (url.endsWith("/hf")) {
      const system = (body?.messages as { content: string }[])[0].content;
      if (system === PLAN_SYSTEM) {
        if (opts.plannerStatus) return Response.json({ error: { message: "no provider" } }, { status: opts.plannerStatus });
        return reply(`Here is the plan:\n${JSON.stringify(PLAN)}`);
      }
      if (system === BOOKS_SYSTEM) return reply(JSON.stringify(BOOKS));
      if (system === JUDGE_SYSTEM) {
        if (opts.judgeStatus) return Response.json({ error: { message: "judge down" } }, { status: opts.judgeStatus });
        return reply(JSON.stringify(opts.judge ?? { books: [] }));
      }
      throw new Error(`unexpected prompt: ${system.slice(0, 60)}`);
    }
    if (url.includes("/archive/inside?")) return insideReply(url, opts);
    if (url.includes("/metadata/")) return Response.json({ metadata: {} });
    if (url.includes("/advancedsearch.php")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      const author = /creator:\(([^)]+)\)/.exec(q)?.[1] ?? "";
      return Response.json({ response: { docs: CATALOGUE[author] ?? [] } });
    }
    if (url.includes("/services/search/")) {
      const q = new URL(url).searchParams.get("user_query") ?? "";
      if (PLAN.queries.includes(q)) return Response.json(PLANNED);
      const inside = /^"([^"]+)" identifier:\((.*)\)$/.exec(q);
      if (inside) {
        const [, term, list] = inside;
        const ids = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        const hits = ids
          .filter((id) => INSIDE[id]?.[term])
          .map((id) => hit(id, id, null, ["americana"], INSIDE[id][term]));
        return Response.json({ response: { body: { hits: { total: hits.length, hits } } } });
      }
      return Response.json(SEARCH);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

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

    if (url.endsWith("/hf") || url.endsWith("/liftwing")) {
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

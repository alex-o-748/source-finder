# Source quality and cost: directions and a plan

**Status:** exploratory — no implementation yet. Written up so the thinking
doesn't have to be redone before work starts.

## The two problems

1. **Source quality.** Web search too often surfaces Wikipedia mirrors,
   user-generated content, or topically-related-but-non-substantiating pages,
   instead of the reliable secondary sources WP:RS calls for (newspaper
   articles from reputable outlets, open-access scientific papers, official
   statistics, etc).
2. **Cost.** Running the pipeline is expensive enough that it can't be made
   free for end users. The user script currently requires a bring-your-own
   API key (Claude, Gemini, or OpenAI), which is a real adoption barrier.

These aren't independent. Today, one model call does discovery, filtering,
reading, and judgement in a single turn (`web_search_20250305`,
`max_uses: 6`, no domain filtering — see `userscript/cnfirmed.js` and
`src/core/findSources.ts`). Quality control can only be phrased as prompt
guidance, and every low-quality page the model reads before the
26-domain blocklist (`src/policy/unreliable_sources.ts`) discards it is
billed at full rate. Splitting discovery from judgement addresses both
problems at once.

## Hard constraint: free at the point of use

The free infrastructure available to a Wikimedia tool — Toolforge, Cloud
VPS, LiftWing, open-weight models on Hugging Face — has no web-search tool.
Requiring an API key is the actual adoption ceiling, so **retrieval has to
become deterministic code**, and any model in the loop has to be small
enough to run for free (in-browser, or on free/donated compute), not a
frontier model billed per call.

This reframes the task: once nobody pays per claim, the model's job stops
being "search the web and judge" and becomes "read this passage and judge
whether it supports this sentence" — textual entailment, which is a much
smaller task than open-ended research.

## What's already true in the code (found while reading)

- The WP:RSP blocklist is applied **after** search — the deprecated domain
  is searched, read, and billed for, then discarded.
- `callClaude` in the userscript discards `usage` entirely, so there is
  currently no visibility into what a run costs.
- The result cache key is `lang:title:revid` (`userscript/cnfirmed.js`) —
  any edit to the article invalidates every previously-verified claim on
  the page, and the next run re-pays for all of them.
- `medium.com` / `substack.com` are hard-blocked, though some outlets
  Wikipedia treats as reliable now publish there.
- A claim is never checked against sources the article already cites, or
  against Wikidata, or against other-language editions — all of which can
  resolve a claim for free, without touching the open web.

## Direction 1: mine Wikimedia's own data before touching the web

All free, unlimited for reasonable use, and need no model at all.

- **Wikidata, including its references.** Many `{{cn}}` tags are
  entity-attribute facts (founding years, populations, dates, awards).
  Wikidata often has the same statement *with a reference already
  attached*. The paragraph's wikilinks give you the QID directly — no NER
  step needed.
- **Other-language editions.** Other Wikipedias are often stricter about
  inline citation. Following the interlanguage link to find the
  corresponding sentence and lifting its reference is pure API work and
  targets exactly the "sources that exist but a web search won't surface"
  case.
- **The article's own reference list.** A tagged sentence is often already
  supported by a citation elsewhere in the same article. Cheap to check
  (one entailment pass over text already in hand) and worth doing first.
- **Citoid** for turning a URL/DOI into correct `{{cite ...}}` metadata,
  instead of having a model write citation fields (a source of invented
  volume/issue numbers today).

## Direction 2: route the rest to open corpora by claim type

Each corpus contains *only* citable material, so quality becomes a
property of where you searched rather than something to prompt for.

| Claim type | Corpus | Needs a key? |
|---|---|---|
| Scientific / medical | OpenAlex, Crossref (metadata + DOI), Europe PMC (full-text) | no |
| Historical / biographical | Internet Archive full-text search, HathiTrust | no / partial |
| Historical news | Chronicling America, Trove, national libraries | varies |
| Contemporary news | GDELT document API, domain-restricted to a WP:RSP-derived allowlist | no |
| Statistics | The issuing body directly (national stats offices, Eurostat, World Bank) | no |
| Dead links | Wayback CDX API | no |

Query construction doesn't need a model either: wikilinks are pre-resolved
entities (with QIDs), dates/numbers/proper nouns extract with regexes, and
the section heading plus infobox type give topical scope and a cheap
claim-type signal.

## Direction 3: where the (small) model runs

| Option | Notes |
|---|---|
| No model | Wikidata value comparison, date/number matching, exact-quote search. Zero cost, covers only factoid claims. |
| In-browser | A quantised cross-encoder (ONNX/WebGPU) on the reader's machine. Zero marginal cost, keeps the no-backend design — but Wikipedia's CSP may block loading third-party weights from a userscript; needs an early check. |
| Toolforge | Small entailment model behind an HTTP endpoint. Free Wikimedia hosting; enables a shared cache and can hold API keys a browser can't. |
| LiftWing | WMF's model-serving platform. The natural long-term home, but needs the ML team's buy-in to deploy to. |

Worth evaluating existing work before training anything: **FEVER** is a
Wikipedia-derived fact-verification benchmark whose labels (supported /
refuted / not enough info) map closely onto this tool's verdict taxonomy,
and Meta's **SIDE** project specifically tackled finding Wikipedia
citations that fail to verify their claim.

## The idea that changes the economics: precompute, don't compute per-click

The `{{citation needed}}` backlog is finite, enumerable from a maintenance
category, and changes slowly. The pipeline doesn't need to run when a user
clicks — it can run offline over the whole backlog, publish an index, and
the user script just does a lookup.

This decouples *which model does the work* from *what the user pays*: a
batch job can use whatever is affordable to whoever runs it (including a
frontier model at batch pricing, e.g. under a Foundation grant), while
staying free forever at the point of use. Newly-tagged claims enter a
queue; the script falls back to live (free, in-browser) computation only
for claims the index hasn't seen yet — which is also where an optional
user-supplied API key could be offered as an upgrade, not a requirement.

## Change what the tool promises

A smaller model gives a less reliable *verdict* but is nearly as good at
*locating the relevant passage*. So: stop promising a verdict, promise
evidence — the source, the exact sentence in it, a ready `<ref>` — and let
the editor decide. This matches what WP:V actually asks of the editor,
degrades honestly (a retrieval miss shows as "nothing found," not a
fluent wrong answer), and lowers the bar the model has to clear.

## Phased plan

1. **Build an evaluation set first.** A few hundred real `{{cn}}` claims
   with hand-checked correct sources, spanning claim types. Everything
   after this is a comparison against it. (The current Claude pipeline is
   a reasonable one-off way to help assemble it.)
2. **Zero-inference layer** (1–2 weeks): Wikidata lookup via wikilink QIDs,
   sister-language reference mining, check-existing-references-first,
   Citoid formatting. Measure coverage on the eval set — this sizes how
   much of the problem never needed a model.
3. **Deterministic retrieval + a free reader** (2–4 weeks): a retriever
   interface with one implementation per corpus (start with scholarly and
   Internet Archive), query construction from wikilinks/entities/dates,
   evaluate existing FEVER/NLI cross-encoders and pick the smallest that
   holds up, ship behind a toggle next to the existing key-based path for
   head-to-head comparison.
4. **Host it, then precompute:** Toolforge deployment (retrieval proxy,
   keyed APIs, shared cache), a batch runner over the citation-needed
   category writing to the index, and a conversation with the WMF ML team
   about LiftWing.

## Open questions to verify before committing

- **No API access was available to verify any of this live** (OpenAlex,
  Crossref, Europe PMC, GDELT, Wikidata, Citoid, the WP:RSP page) — the
  environment this plan was written in blocked all outbound network access
  except Anthropic's own docs. Endpoints, rate limits, and CORS behavior
  all need a live check before Phase 3 is scoped.
- **Wikipedia's CSP.** Whether a userscript can fetch third-party APIs and
  model weights at all decides between userscript / browser-extension /
  backend architectures. Test this first — it constrains more than
  anything else here.
- **Toolforge terms and LiftWing access** are both free but both have a
  process; worth starting that conversation early.
- **Does the small model actually hold up?** The whole plan rests on
  entailment being tractable at small scale. The Phase 1 eval set answers
  this before too much is built on the assumption.
- **Community reception.** An AI sourcing tool on Wikipedia will get
  scrutiny. Being deterministic, transparent about sourcing, evidence-first
  (never auto-editing), and open source is most of the defense, and is
  easier to build in now than retrofit later.

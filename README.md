# CNfirmed

Find and verify sources for Wikipedia `{{citation needed}}` claims using Claude.

CNfirmed fetches a Wikipedia article, locates every `{{citation needed}}`-family tag, extracts the claim being cited (plus surrounding context), uses Claude's `web_search` tool to discover candidate sources, and then runs each candidate through a separable verifier that judges whether the source *actually substantiates the specific claim* — not just mentions the topic. Supporting sources are returned ranked, each with a ready-to-paste Wikipedia cite template.

## Why

Topical similarity isn't the same as substantiation. Existing citation-finders point at pages that sound related; CNfirmed asks Claude to read the candidate and answer: "does this passage support this specific claim?"

## Install

```sh
npm install
npm run build
```

Set your API key:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# optional:
export CNFIRMED_MODEL=claude-opus-4-6
```

## Usage

```sh
# End-to-end on a Wikipedia article.
node dist/cli/index.js find "Eiffel Tower"
node dist/cli/index.js find "https://en.wikipedia.org/wiki/Eiffel_Tower" --max-claims 3

# Just the verifier — useful as its own service.
node dist/cli/index.js verify \
  --claim "The Eiffel Tower was 300 metres tall when first built." \
  --source "https://www.britannica.com/topic/Eiffel-Tower-Paris-France"

# Just the extractor (no API calls; debugging).
node dist/cli/index.js extract "Eiffel Tower"
```

Add `--json` to any command for machine-readable output.

## Architecture

```
src/
  core/                # framework-agnostic library
    fetchArticle.ts    # Wikipedia API → wikitext + metadata
    extractClaims.ts   # wikitext → [{ claim, context, section, offset }]
    findSources.ts     # Claude + web_search → candidate sources
    verifySource.ts    # (claim, source) → verdict  — separable
    formatCitation.ts  # source → {{cite web|...}} / {{cite news|...}}
    runArticle.ts      # orchestrator
    anthropic.ts       # shared client + prompt-caching helper
  cli/                 # thin Commander wrapper over core
  prompts/             # verify_source.md (placeholder), find_sources.md
  policy/              # WP:RSP unreliable-source blocklist
```

The core library has no CLI dependencies. Cloudflare Workers, a web UI, an MCP server, or a browser-extension backend can wrap it directly.

## The verifier is separable

`verifySource(claim, sourceUrl)` is exposed both as a library function and as the `cnfirmed verify` subcommand. It uses the prompt at `src/prompts/verify_source.md`, which is intended to be replaced with your own source-checking prompt. The function contract is stable.

The verifier grades **two independent axes**:

- **Substantiation** — `verdict ∈ {SUPPORTED, PARTIALLY SUPPORTED, NOT SUPPORTED, SOURCE UNAVAILABLE}`, `confidence 0-100`, `comments` (usually including the relevant quote). Pure reading comprehension: does the source actually state the specific claim?
- **Reliability for this claim** — `reliability ∈ {high, medium, low, n/a}`, `reliabilityReason`. WP:RS judgment *for the kind of claim being made* (context-sensitive: BLP, medical, SPS-for-author-bio, primary-vs-secondary).

These are kept separate so callers can distinguish "doesn't say it" from "says it, but wrong kind of source". A suggestion with `verdict: "SUPPORTED"` and `reliability: "low"` is still surfaced — flagged — so a human editor can see the source does say it but needs a better one. A cite template and `<ref>` snippet are emitted for every candidate; the verdict, confidence, and reliability shown alongside are what a human editor uses to decide whether to paste it.

## Policy handling (three layers)

1. **Hard domain blocklist** — `src/policy/unreliable_sources.ts`, applied in `findSources` after web_search returns. Catches WP:RSP-deprecated outlets deterministically before spending verifier tokens.
2. **Discovery-time prompt guidance** — `src/prompts/find_sources.md` steers the model toward WP:RS-compliant sources during search.
3. **Verifier reliability axis** — the context-sensitive judgment the domain blocklist cannot express.

## Testing

```sh
npx tsx --test test/extractClaims.test.ts
```

Fixture-based tests cover the wikitext claim extractor (the trickiest piece). Add more fixtures in `test/fixtures/*.wikitext` as edge cases appear.

## Wikipedia user script

A user script + thin backend lets editors run CNfirmed inline on Wikipedia: a 🔍 badge appears next to every `[citation needed]` superscript, and a sidebar portlet lists every CN tag with live status.

### Backend: choose Node (local) or Cloudflare Worker (hosted)

Same Hono app, two deploy targets.

#### Option A — Local Node server

```sh
ANTHROPIC_API_KEY=sk-ant-... npm run server
# cnfirmed: listening on http://localhost:3939
```

Works in Chrome and Edge (which allowlist HTTPS-page → HTTP-localhost). **Firefox blocks this as mixed content** — for Firefox use a tunnel (`cloudflared tunnel --url http://localhost:3939`) or Option B.

#### Option B — Cloudflare Worker (recommended)

Free tier handles everything we need (subrequests, SSE, runtime). Stable HTTPS URL works in every browser.

```sh
npm install
npx wrangler login                            # one-time
npx wrangler secret put ANTHROPIC_API_KEY     # paste your key when prompted
npm run worker:deploy                         # → https://cnfirmed.<your-account>.workers.dev
```

Local dev against the deployed config:

```sh
npm run worker:dev                            # http://localhost:8787
```

#### Endpoints

- `GET /scan?article=<title-or-url>` — `{ article, claims }`, no Claude calls.
- `POST /verify-claim` — SSE stream for one claim by index.
- `POST /verify-article` — SSE stream wrapping `runArticle`.

CORS is restricted to `*.wikipedia.org` and `localhost`. API key stays in the Worker secret / server env.

### Install the user script

Copy `userscript/cnfirmed.js` to `User:Yourname/cnfirmed.js` on en.wikipedia.org, then add to `User:Yourname/common.js`:

```js
window.cnfirmedBackend = 'https://cnfirmed.your-account.workers.dev';
importScript('User:Yourname/cnfirmed.js');
```

(Use `http://localhost:3939` instead if you're running the Node server.) Reload any article with `{{citation needed}}` tags. Click a 🔍 badge or a sidebar row to verify a single claim; use "Verify all" to run the whole article.

The user script reuses [`User:Polygnotus/Helpers/Sidebar.js`](https://en.wikipedia.org/wiki/User:Polygnotus/Helpers/Sidebar.js) for sidebar portlet plumbing.

## Status

v1 ships the CLI + core library + user script + Node and Worker backends. Deferred:

- BYO-key proxy mode on the Worker (so multiple users can share one deployment without sharing the operator's API budget)
- Edit-mode integration (one-click insert `<ref>` into wikitext)
- Browser extension (inline on Wikipedia, no backend needed)
- MCP server wrapper
- Bot / talk-page integration
- Non-Wikipedia wikis

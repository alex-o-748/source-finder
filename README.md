# CNfirmed

Find and verify sources for Wikipedia `{{citation needed}}` claims.

CNfirmed locates every `{{citation needed}}`-family tag in a Wikipedia article, extracts the claim being cited (plus surrounding context), uses an LLM with web search to discover candidate sources, and judges whether the source *actually substantiates the specific claim* — not just mentions the topic. Supporting sources are returned ranked, each with a ready-to-paste Wikipedia cite template.

This repo ships two things:

- A **Wikipedia user script** (`userscript/cnfirmed.js`) — bring-your-own-key, runs entirely in the browser. Talks directly to Anthropic, Google (Gemini), or OpenAI using a key you store in your own browser's `localStorage`. No backend, no proxy.
- A **Node CLI** (`cnfirmed`) — for running the same pipeline from the terminal against the Anthropic API.

## Why

Topical similarity isn't the same as substantiation. Existing citation-finders point at pages that sound related; CNfirmed asks the model to read the candidate and answer: "does this passage support this specific claim?"

## User script (recommended)

The user script is the primary way to use CNfirmed. It runs entirely on the Wikipedia page — no server, no Cloudflare Worker, no allowlist. You provide an API key for Claude, Gemini, or OpenAI; it's kept in your browser's `localStorage` and only sent to the provider you chose.

### Install

1. Copy `userscript/cnfirmed.js` to `User:Yourname/cnfirmed.js` on en.wikipedia.org.
2. Add to `User:Yourname/common.js`:
   ```js
   importScript('User:Yourname/cnfirmed.js');
   ```
3. Reload any article that has `{{citation needed}}` tags.

Need an article to test on? [Category:All articles with unsourced statements](https://en.wikipedia.org/wiki/Category:All_articles_with_unsourced_statements) lists every article on en.wikipedia with at least one `{{citation needed}}` tag.

### Usage

- A 🔍 badge appears next to every `[citation needed]` superscript.
- A **CNfirmed** portlet appears in the sidebar with a provider dropdown, an API-key control, and one row per citation-needed claim.
- The first time you click a 🔍 badge or the **Verify all** button, you'll be prompted for an API key for the selected provider. Keys are stored in `localStorage`.
- Click a 🔍 badge or a sidebar row to verify a single claim.
- Click **Verify all** to run every unverified claim on the page (one API call per claim — cost scales linearly).

The script reuses [`User:Polygnotus/Helpers/Sidebar.js`](https://en.wikipedia.org/wiki/User:Polygnotus/Helpers/Sidebar.js) for the sidebar portlet.

### Providers

| Provider | Default model           | Override (set on `window.…` before the script loads) |
| -------- | ----------------------- | ---------------------------------------------------- |
| Claude   | `claude-sonnet-4-6`     | `cnfirmedModelClaude`                                |
| Gemini   | `gemini-2.5-flash`      | `cnfirmedModelGemini`                                |
| OpenAI   | `gpt-4o`                | `cnfirmedModelOpenAI`                                |

Each provider is invoked with its built-in web-search tool (Anthropic `web_search`, Google `googleSearch`+`urlContext`, OpenAI `web_search`) so source discovery and verification happen in a single round-trip per claim.

### Output

For each claim the script renders a popover with:

- **Substantiation verdict** — `SUPPORTED` / `PARTIALLY SUPPORTED` / `NOT SUPPORTED` / `SOURCE UNAVAILABLE`, with a 0–100 confidence score.
- **Reliability** — `high` / `medium` / `low` / `n/a`, judged in context (BLP, medical, news, history…).
- The relevant quote from the source.
- A **Copy `<ref>`** button that puts a ready-to-paste `<ref>{{cite ...}}</ref>` snippet on the clipboard.

## Node CLI

A standalone command-line tool against the Anthropic API. Useful for batch runs or scripting; the user script doesn't depend on it.

### Install

```sh
npm install
npm run build
```

Set your API key:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# optional:
export CNFIRMED_MODEL=claude-sonnet-4-6
```

### Usage

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
userscript/
  cnfirmed.js          # self-contained user script (no backend)

src/
  core/                # framework-agnostic library, used by the CLI
    fetchArticle.ts    # Wikipedia API → wikitext + metadata
    extractClaims.ts   # wikitext → [{ claim, context, section, offset }]
    findSources.ts     # Claude + web_search → candidate sources
    verifySource.ts    # (claim, source) → verdict — separable
    formatCitation.ts  # source → {{cite web|...}} / {{cite news|...}}
    runArticle.ts      # orchestrator
    anthropic.ts       # shared client + prompt-caching helper
    prompts.ts         # disk-backed prompt loader
  cli/                 # thin Commander wrapper over core
  prompts/             # verify_source.md, find_sources.md
  policy/              # WP:RSP unreliable-source blocklist
```

The user script is intentionally standalone: it inlines its own prompt, blocklist, and citation formatter so it has no build step and no dependency on `src/`. The CLI continues to use the `src/` library.

## The verifier is separable (CLI)

`verifySource(claim, sourceUrl)` is exposed both as a library function and as the `cnfirmed verify` subcommand. It uses the prompt at `src/prompts/verify_source.md`. The function contract is stable.

The verifier grades **two independent axes**:

- **Substantiation** — `verdict ∈ {SUPPORTED, PARTIALLY SUPPORTED, NOT SUPPORTED, SOURCE UNAVAILABLE}`, `confidence 0-100`, `comments` (usually including the relevant quote). Pure reading comprehension: does the source actually state the specific claim?
- **Reliability for this claim** — `reliability ∈ {high, medium, low, n/a}`, `reliabilityReason`. WP:RS judgment *for the kind of claim being made* (context-sensitive: BLP, medical, SPS-for-author-bio, primary-vs-secondary).

These are kept separate so callers can distinguish "doesn't say it" from "says it, but wrong kind of source". A suggestion with `verdict: "SUPPORTED"` and `reliability: "low"` is still surfaced — flagged — so a human editor can see the source does say it but needs a better one. A cite template and `<ref>` snippet are emitted for every candidate; the verdict, confidence, and reliability shown alongside are what a human editor uses to decide whether to paste it.

## Policy handling (three layers)

1. **Hard domain blocklist** — `src/policy/unreliable_sources.ts` for the CLI, mirrored inline in `userscript/cnfirmed.js`. Catches WP:RSP-deprecated outlets deterministically.
2. **Discovery-time prompt guidance** — `src/prompts/find_sources.md` (CLI) and the inlined system prompt (user script) steer the model toward WP:RS-compliant sources during search.
3. **Verifier reliability axis** — the context-sensitive judgment the domain blocklist cannot express.

## Testing

```sh
npx tsx --test test/extractClaims.test.ts
```

Fixture-based tests cover the wikitext claim extractor (the trickiest piece in the CLI). Add more fixtures in `test/fixtures/*.wikitext` as edge cases appear.

## Status

v1 ships the user script + the CLI + core library. Deferred:

- Edit-mode integration (one-click insert `<ref>` into wikitext)
- Browser extension wrapper (no install via common.js)
- MCP server wrapper
- Bot / talk-page integration
- Non-Wikipedia wikis

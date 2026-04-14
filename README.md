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

These are kept separate so callers can distinguish "doesn't say it" from "says it, but wrong kind of source". A suggestion with `verdict: "SUPPORTED"` and `reliability: "low"` is still surfaced — flagged — so a human editor can see the source does say it but needs a better one. A cite template is emitted only when both axes clear (`SUPPORTED` + reliability `high` or `medium`).

## Policy handling (three layers)

1. **Hard domain blocklist** — `src/policy/unreliable_sources.ts`, applied in `findSources` after web_search returns. Catches WP:RSP-deprecated outlets deterministically before spending verifier tokens.
2. **Discovery-time prompt guidance** — `src/prompts/find_sources.md` steers the model toward WP:RS-compliant sources during search.
3. **Verifier reliability axis** — the context-sensitive judgment the domain blocklist cannot express.

## Testing

```sh
npx tsx --test test/extractClaims.test.ts
```

Fixture-based tests cover the wikitext claim extractor (the trickiest piece). Add more fixtures in `test/fixtures/*.wikitext` as edge cases appear.

## Status

v1 ships the CLI + core library. Deferred:

- Browser extension (inline on Wikipedia)
- Web UI / Cloudflare Pages deployment
- MCP server wrapper
- Bot / talk-page integration
- Non-Wikipedia wikis

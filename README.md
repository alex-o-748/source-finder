# CNfirmed

Find and verify sources for Wikipedia `{{citation needed}}` claims.

CNfirmed locates every `{{citation needed}}`-family tag in a Wikipedia article and extracts the claim being cited, plus surrounding context. It then looks for a source in two stages:

1. **On wiki, free.** Citations this article already carries, and citations other language editions attach to the same fact. No model, no API key, no cost.
2. **On the web, paid.** Only for the claims stage 1 could not answer: an LLM with web search discovers candidates and judges whether each *actually substantiates the specific claim* — not just mentions the topic.

Results are returned ranked, each with a ready-to-paste Wikipedia cite template.

This repo ships two things:

- A **Wikipedia user script** (`userscript/cnfirmed.js`) — runs entirely in the browser. The wiki-local stage needs no key at all; the web search talks directly to Anthropic, Google (Gemini), or OpenAI using a key you store in your own browser's `localStorage`. No backend, no proxy.
- A **Node CLI** (`cnfirmed`) — for running the same pipeline from the terminal against the Anthropic API.

## Why

Topical similarity isn't the same as substantiation. Existing citation-finders point at pages that sound related; CNfirmed asks the model to read the candidate and answer: "does this passage support this specific claim?"

And a lot of the time nobody needs to search at all. A tagged sentence often sits beside sourced text whose citation covers it too, and other Wikipedias — frequently stricter about inline citation — have already sourced the same fact. Those citations are free to find, were vetted by a human editor, and are exactly what a web search will not surface.

## User script (recommended)

The user script is the primary way to use CNfirmed. It runs entirely on the Wikipedia page — no server, no Cloudflare Worker, no allowlist.

The wiki-local stage works with no API key at all. For the web search you provide a key for Claude, Gemini, or OpenAI; it's kept in your browser's `localStorage` and only sent to the provider you chose.

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
- A **CNfirmed** portlet appears in the sidebar with a provider dropdown, an API-key control, a free **Find sources on Wikipedia** button, and one row per citation-needed claim.
- Click a 🔍 badge or a sidebar row to work on a single claim. The free wiki-local stage runs first; if it finds a citation, you get it without an API call. If it finds nothing and you have a key set, the web search runs as before.
- Click **Verify all** to scan every claim on wiki for free, then confirm a web search for whatever is left — the dialog tells you how many claims Wikipedia already answered and how many API calls the rest would cost.
- An API key is only needed for the web search. Keys are stored in `localStorage` and you're prompted the first time you ask for one.

The script reuses [`User:Polygnotus/Helpers/Sidebar.js`](https://en.wikipedia.org/wiki/User:Polygnotus/Helpers/Sidebar.js) for the sidebar portlet.

### Providers

| Provider | Default model           | Override (set on `window.…` before the script loads) |
| -------- | ----------------------- | ---------------------------------------------------- |
| Claude   | `claude-sonnet-4-6`     | `cnfirmedModelClaude`                                |
| Gemini   | `gemini-flash-latest`   | `cnfirmedModelGemini`                                |
| OpenAI   | `gpt-5-mini`            | `cnfirmedModelOpenAI`                                |

Each provider is invoked with its built-in web-search tool (Anthropic `web_search`, Google `googleSearch`+`urlContext`, OpenAI `web_search`) so source discovery and verification happen in a single round-trip per claim.

### Output

For each claim the script renders a popover in two parts.

**Already on Wikipedia** — the free stage's leads, each with:

- Where it came from: `this article` (with the sentence it is already cited for) or `de.wiki` / `fr.wiki` (with the sentence on that wiki, and the anchors that matched).
- A **Copy `<ref>`** / **Insert `<ref>` in editor** pair. A same-article lead pastes as `<ref name="existing" />`, re-using the citation already on the page — the smallest possible edit.

These are *leads, not verdicts*: a human editor cited that source for a sentence like yours. Read it before you paste it.

**From the web** — the model's verified candidates (run on demand, or automatically when the free stage found nothing):

- **Substantiation verdict** — `SUPPORTED` / `PARTIALLY SUPPORTED` / `NOT SUPPORTED` / `SOURCE UNAVAILABLE`, with a 0–100 confidence score.
- **Reliability** — `high` / `medium` / `low` / `n/a`, judged in context (BLP, medical, news, history…).
- The relevant quote from the source.
- A **Copy `<ref>`** button that puts a ready-to-paste `<ref>{{cite ...}}</ref>` snippet on the clipboard.
- An **Insert `<ref>` in editor** button that opens the section's source editor with the chosen `<ref>` already substituted in for the `{{citation needed}}` tag, and a pre-filled edit summary linking to [[User:Alaexis/CNfirmed]]. Review the diff and save.

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
# End-to-end on a Wikipedia article: wiki-local sources first, web search for
# whatever is left.
node dist/cli/index.js find "Eiffel Tower"
node dist/cli/index.js find "https://en.wikipedia.org/wiki/Eiffel_Tower" --max-claims 3

# Just the free stage: what can be sourced from wiki alone. No API key needed.
node dist/cli/index.js wiki "Eiffel Tower"

# Just the verifier — useful as its own service.
node dist/cli/index.js verify \
  --claim "The Eiffel Tower was 300 metres tall when first built." \
  --source "https://www.britannica.com/topic/Eiffel-Tower-Paris-France"

# Just the extractor (no API calls; debugging).
node dist/cli/index.js extract "Eiffel Tower"
```

`find` flags for the two-stage pipeline:

| Flag | Effect |
| --- | --- |
| `--sister-wikis <n>` | Language editions to mine (default 4; `0` uses only this article's own references). |
| `--no-wiki` | Skip the wiki-local stage entirely and go straight to web search. |
| `--wiki-only` | Never run the web search, whatever the wiki stage finds. |
| `--always-web` | Run the web search even when a wiki-local source already substantiates. |

Add `--json` to any command for machine-readable output.

## Architecture

```
userscript/
  cnfirmed.js          # self-contained user script (no backend)

src/
  core/                # framework-agnostic library, used by the CLI
    fetchArticle.ts    # Wikipedia API → wikitext + metadata
    extractClaims.ts   # wikitext → [{ claim, context, section, offset }]
    mediawiki.ts       # shared api.php client (wikitext, interlanguage links)
    wikitext.ts        # wikitext → prose, sentences, sections, wikilinks
    wikitextRefs.ts    # <ref> parsing → url, title, work, quote, reusable name
    relevance.ts       # deterministic scoring: token overlap + translation anchors
    wikiSources.ts     # stage 1 — citations already on wiki (no model)
    findSources.ts     # stage 2 — Claude + web_search → candidate sources
    verifySource.ts    # (claim, source) → verdict — separable
    formatCitation.ts  # source → {{cite web|...}} / {{cite news|...}}
    runArticle.ts      # orchestrator: stage 1, then stage 2 only if needed
    anthropic.ts       # shared client + prompt-caching helper
    prompts.ts         # disk-backed prompt loader
  cli/                 # thin Commander wrapper over core
  prompts/             # verify_source.md, find_sources.md
  policy/              # WP:RSP unreliable-source blocklist
```

The user script is intentionally standalone: it inlines its own prompt, blocklist, citation formatter and wiki-local stage so it has no build step and no dependency on `src/`. The CLI continues to use the `src/` library. `test/userscriptWikiSources.test.ts` loads the shipped user script with browser globals stubbed and asserts it finds the same candidates, with the same scores and ranking, as the TypeScript core — so the two copies cannot drift apart silently.

## The verifier is separable (CLI)

`verifySource(claim, sourceUrl)` is exposed both as a library function and as the `cnfirmed verify` subcommand. It uses the prompt at `src/prompts/verify_source.md`. The function contract is stable.

The verifier grades **two independent axes**:

- **Substantiation** — `verdict ∈ {SUPPORTED, PARTIALLY SUPPORTED, NOT SUPPORTED, SOURCE UNAVAILABLE}`, `confidence 0-100`, `comments` (usually including the relevant quote). Pure reading comprehension: does the source actually state the specific claim?
- **Reliability for this claim** — `reliability ∈ {high, medium, low, n/a}`, `reliabilityReason`. WP:RS judgment *for the kind of claim being made* (context-sensitive: BLP, medical, SPS-for-author-bio, primary-vs-secondary).

These are kept separate so callers can distinguish "doesn't say it" from "says it, but wrong kind of source". A suggestion with `verdict: "SUPPORTED"` and `reliability: "low"` is still surfaced — flagged — so a human editor can see the source does say it but needs a better one. A cite template and `<ref>` snippet are emitted for every candidate; the verdict, confidence, and reliability shown alongside are what a human editor uses to decide whether to paste it.

## Sources already on Wikipedia (the free stage)

Before anything is billed, CNfirmed looks for a citation Wikimedia already holds. Two passes, both deterministic code with no model in the loop:

**The article's own references.** A tagged sentence usually sits beside sourced text, and the neighbouring citation often covers it too. Each existing `<ref>` is scored on proximity to the tag (same paragraph, same section, elsewhere) plus weighted token overlap with the reference's own title, publisher and `quote=`. Outside the claim's section, proximity counts for nothing and the reference has to earn its place on what it is actually about. A hit pastes as `<ref name="existing" />`, re-using the citation already on the page.

**Other language editions.** Their references are precisely the sources a web search will not surface. The corresponding sentence is located without a translation model, using anchors that survive translation:

- **Numbers and dates** — normalised across numeral systems, so `١٨٨٩` and `1889` are the same anchor.
- **Proper nouns** — folded for case and diacritics, and only used between wikis that share a script.
- **Wikilink targets** — resolved to the counterpart title on the target wiki through interlanguage links. This is what makes a claim locatable on a wiki whose script shares nothing with ours.

A match on the exact sentence is the real signal; the same anchors elsewhere in the paragraph count for less. Both passes deduplicate by URL, drop blocklisted domains, and rank by match strength.

What comes out is **evidence, not a verdict**: a human editor cited that source for a sentence that looks like your claim. The CLI's `find` still verifies these leads with the model before ranking them alongside web results; `cnfirmed wiki` and the user script's free stage present them unverified, with the sentence and the matched anchors, and leave the judgment to the editor.

Deliberately out of scope for now: Wikidata statements and their references, which need entity-attribute matching rather than sentence matching. See the plan doc.

## Policy handling (three layers)

1. **Hard domain blocklist** — `src/policy/unreliable_sources.ts` for the CLI, mirrored inline in `userscript/cnfirmed.js`. Catches WP:RSP-deprecated outlets deterministically, and is applied to wiki-local candidates too (so a `wikipedia.org` URL cited on another wiki never comes back — WP:CIRCULAR).
2. **Discovery-time prompt guidance** — `src/prompts/find_sources.md` (CLI) and the inlined system prompt (user script) steer the model toward WP:RS-compliant sources during search.
3. **Verifier reliability axis** — the context-sensitive judgment the domain blocklist cannot express.

## Testing

```sh
npm test                                  # everything
npx tsx --test test/wikiSources.test.ts   # one file
```

Fixture-based and fully offline — no network, no API key. Coverage: the wikitext claim extractor, `<ref>` parsing (named refs, list-defined refs, identifiers, archive fallback), the relevance scoring, the two wiki-local passes end to end (including a cross-script Japanese fixture), and the user-script parity test. Add fixtures in `test/fixtures/` as edge cases appear.

## Status

v1 ships the user script + the CLI + core library, with the wiki-local stage
in front of the web search in both. Deferred:

- Wikidata statements and their references
- Citoid for citation metadata, instead of formatting templates by hand
- Browser extension wrapper (no install via common.js)
- MCP server wrapper
- Bot / talk-page integration
- Non-Wikipedia wikis

See `docs/source-quality-and-cost-plan.md` for the wider plan on source
quality and making the tool free to run without an API key. The wiki-local
stage is phase 2 of that plan; the MediaWiki API calls it makes have not yet
been exercised against the live API (the environment it was built in had no
outbound network access to wikipedia.org), so that wants a live check.

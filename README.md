# CNfirmed

Find and verify sources for Wikipedia `{{citation needed}}` claims.

CNfirmed locates every `{{citation needed}}`-family tag in a Wikipedia article and extracts the claim being cited, plus surrounding context. It then looks for a source in two stages:

1. **On wiki, free.** Citations this article already carries, and citations other language editions attach to the same fact. No model, no API key, no cost.
2. **On the web, paid.** Only for the claims stage 1 could not answer: an LLM with web search discovers candidates and judges whether each *actually substantiates the specific claim* — not just mentions the topic.

Results are returned ranked, each with a ready-to-paste Wikipedia cite template.

This repo ships two things:

- A **Wikipedia user script** (`userscript/cnfirmed.js`) — runs entirely in the browser. The wiki-local stage needs no key at all; the web search talks directly to Anthropic, Google (Gemini), or OpenAI using a key you store in your own browser's `localStorage`. The one backend it calls is the Verify API, which checks Internet Archive passages against the claim and needs no key.
- A **Node CLI** (`cnfirmed`) — for running the same pipeline from the terminal. Web search uses the Anthropic API; checking a candidate against the claim uses the [Verify API](#the-verifier-is-separable-cli).

## Why

Topical similarity isn't the same as substantiation. Existing citation-finders point at pages that sound related; CNfirmed asks the model to read the candidate and answer: "does this passage support this specific claim?"

And a lot of the time nobody needs to search at all. A tagged sentence often sits beside sourced text whose citation covers it too, and other Wikipedias — frequently stricter about inline citation — have already sourced the same fact. Those citations are free to find, were vetted by a human editor, and are exactly what a web search will not surface.

## User script (recommended)

The user script is the primary way to use CNfirmed. It runs on the Wikipedia page — no server of its own, no Cloudflare Worker, no allowlist. The only service it calls besides the model provider is the Verify API, for the Internet Archive check.

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

- A small badge appears next to every `[citation needed]` superscript. Its colour is the claim's status: green when a source supports it, blue when there are leads to check.
- Click a badge to open that claim in a panel docked to the right edge of the page (the article moves over to make room; drag the panel's edge to resize it). Both free searches start at once: citations already on Wikipedia, and Internet Archive books, whose passages the Verify API then checks. The web search starts by itself only when both find nothing and you have a key set; otherwise it waits for a click.
- The **CNfirmed (N)** link beside the page tabs (in the tools menu on other skins) opens the list of all the page's claims with their status. **Find sources for all (free)** runs both free searches for every claim; when they are done, a button offers a web search for the claims still left with nothing, and says how many searches that is. **‹ 1 of N ›** in the panel's header steps through the claims, and clicking the count opens the list.
- The provider and API key are behind the panel's gear. A key is only needed for the web search, and is kept in `localStorage`.

### Providers

| Provider | Default model           | Override (set on `window.…` before the script loads) |
| -------- | ----------------------- | ---------------------------------------------------- |
| Claude   | `claude-sonnet-5`     | `cnfirmedModelClaude`                                |
| Gemini   | `gemini-flash-latest`   | `cnfirmedModelGemini`                                |
| OpenAI   | `gpt-5-mini`            | `cnfirmedModelOpenAI`                                |

Each provider is invoked with its built-in web-search tool (Anthropic `web_search`, Google `googleSearch`+`urlContext`, OpenAI `web_search`) so source discovery and verification happen in a single round-trip per claim.

### Output

For each claim, the panel shows one list of sources, best first, whatever search found it:

- **Supports the claim** / **Supports part of the claim**: something read the source against the claim (the Verify API for a book's passages, the model for a web page).
- **Lead, not checked**: a citation an editor attached to a sentence like yours, in this article (`already cited in this article`, with that sentence) or on another language edition (`cited on de.wikipedia`, with the sentence there). *Leads, not verdicts*: read the source before you paste it.
- **Probably copied from Wikipedia**: a web page whose quote repeats the article's sentence word for word (WP:CIRCULAR). Listed last, with a warning. Pages on sites anyone can upload to (Scribd and the like) carry a warning too, as does a web source the model judged of low reliability for the claim.

Sources checked and found not to state the claim are not listed, only counted. Click a source to open it: the passage or quote, any warning, and

- **Insert in editor**, which opens the section's source editor with the `<ref>` in place of the `{{citation needed}}` tag and a pre-filled edit summary linking to [[User:Alaexis/CNfirmed]]. Review the diff and save. A same-article lead inserts as `<ref name="existing" />`, re-using the citation already on the page — the smallest possible edit.
- **Copy `<ref>`**, which puts the same `<ref>` on the clipboard.

Under the list, **Searched** says what each search (Wikipedia, books, web) found, or that it is still running, and holds the button for any search not yet run or failed.

## Node CLI

A standalone command-line tool. Useful for batch runs or scripting; the user script doesn't depend on it. The web search runs against the Anthropic API; every candidate is then checked by the Verify API, which needs no key.

### Install

```sh
npm install
npm run build
```

Set your API key:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# optional:
export CNFIRMED_MODEL=claude-sonnet-5          # web search model
export CNFIRMED_VERIFY_URL=http://localhost:8080  # Verify API base (default: https://citation-verifier.toolforge.org)
```

`verify` and `wiki` need no Anthropic key; `find` needs one only for the web search.

### Usage

```sh
# End-to-end on a Wikipedia article: wiki-local sources first, web search for
# whatever is left.
node dist/cli/index.js find "Eiffel Tower"
node dist/cli/index.js find "https://en.wikipedia.org/wiki/Eiffel_Tower" --max-claims 3

# Just the free stage: what can be sourced from wiki alone. No API key needed.
node dist/cli/index.js wiki "Eiffel Tower"

# Books on the Internet Archive — open, or borrowable with a free account — whose
# text carries each claim.
# No API key. Prints how many books survive each step of the funnel.
node dist/cli/index.js archive "Eiffel Tower" --max-claims 5
node dist/cli/index.js archive "Eiffel Tower" --record fixtures-out/  # save raw responses
node dist/cli/index.js archive "Eiffel Tower" --full-text  # read open books' whole text too (slower)

# Just the verifier (the Verify API) — no API key needed.
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
    internetArchive.ts # Internet Archive client: full-text search, metadata, book text
    archiveSources.ts  # Internet Archive books whose text carries the claim (no model)
    findSources.ts     # stage 2 — Claude + web_search → candidate sources
    verifySource.ts    # (claim, source) → verdict, via the Verify API — separable
    formatCitation.ts  # source → {{cite web|...}} / {{cite news|...}}
    runArticle.ts      # orchestrator: stage 1, then stage 2 only if needed
    anthropic.ts       # shared client + prompt-caching helper
    prompts.ts         # disk-backed prompt loader
  cli/                 # thin Commander wrapper over core
  prompts/             # find_sources.md
  policy/              # WP:RSP unreliable-source blocklist
```

The user script is intentionally standalone: it inlines its own prompt, blocklist, citation formatter and wiki-local stage so it has no build step and no dependency on `src/`. The CLI continues to use the `src/` library. `test/userscriptWikiSources.test.ts` loads the shipped user script with browser globals stubbed and asserts it finds the same candidates, with the same scores and ranking, as the TypeScript core — so the two copies cannot drift apart silently.

## The verifier is separable (CLI)

`verifySource(claim, sourceUrl)` is exposed both as a library function and as the `cnfirmed verify` subcommand. The function contract is stable.

It does not call a model itself. It posts the claim and the source to the **Verify API** — `POST /v1/verify` from [alex-o-748/citation-checker-script](https://github.com/alex-o-748/citation-checker-script/blob/main/docs/verify-api.md), hosted at `https://citation-verifier.toolforge.org` (override with `CNFIRMED_VERIFY_URL`). That service runs the same benchmarked prompt, parser and quote check as the citation-checker userscript, so CNfirmed does not maintain a second verifier prompt. It fetches `source_url` itself; pass `{ sourceText }` to send text you already have as `source_content` instead.

What comes back:

- `verdict ∈ {SUPPORTED, PARTIALLY SUPPORTED, NOT SUPPORTED, SOURCE UNAVAILABLE}`, `confidence 0-100` (the API's `support_score`), `comments`.
- `quote` — the API's `verified_text`: the part of the model's quote actually found in the source. The model's unverified quote is never passed on.
- `reliability` is `"n/a"`: the Verify API grades substantiation only. Candidates are still screened against the WP:RSP blocklist before they reach the verifier, and judging reliability for the claim is left to the editor.

The service allows 30 requests a minute across all callers. On a 429, `verifySource` waits out `Retry-After` (up to three times) rather than failing the candidate; a source the API cannot fetch (422) becomes a `SOURCE UNAVAILABLE` verdict.

A cite template and `<ref>` snippet are emitted for every candidate; the verdict, confidence and quote shown alongside are what a human editor uses to decide whether to paste it.

## Sources already on Wikipedia (the free stage)

Before anything is billed, CNfirmed looks for a citation Wikimedia already holds. Two passes, both deterministic code with no model in the loop:

**The article's own references.** A tagged sentence usually sits beside sourced text, and the neighbouring citation often covers it too. Each existing `<ref>` is scored on proximity to the tag (same paragraph, same section, elsewhere) plus weighted token overlap with the reference's own title, publisher and `quote=`. Outside the claim's section, proximity counts for nothing and the reference has to earn its place on what it is actually about. A hit pastes as `<ref name="existing" />`, re-using the citation already on the page.

**Other language editions.** Their references are precisely the sources a web search will not surface. The corresponding sentence is located without a translation model, using anchors that survive translation:

- **Numbers and dates** — normalised across numeral systems, so `١٨٨٩` and `1889` are the same anchor.
- **Proper nouns** — folded for case and diacritics, and only used between wikis that share a script.
- **Wikilink targets** — resolved to the counterpart title on the target wiki through interlanguage links. This is what makes a claim locatable on a wiki whose script shares nothing with ours.

A match on the exact sentence is the real signal; the same anchors elsewhere in the paragraph count for less. Both passes deduplicate by URL, drop blocklisted domains, and rank by match strength.

What comes out is **evidence, not a verdict**: a human editor cited that source for a sentence that looks like your claim. The CLI's `find` still verifies these leads with the model before ranking them alongside web results; `cnfirmed wiki` and the user script's free stage present them unverified, with the sentence and the matched anchors, and leave the judgment to the editor.

Deliberately out of scope: **Wikidata statements and their references.** This was built, shipped and then removed — it found nothing on real articles. See the plan doc for why, before building it again.

## Books on the Internet Archive (experimental)

A second free stage, in both the user script (it runs whenever a claim is opened, alongside the Wikipedia search) and the CLI (`cnfirmed archive`). It looks for the claim in the OCR text of digitised books, with no model. A book counts if an editor can read the passage: an open one, or one in the lending library, which anyone with a free archive.org account can borrow.

The search matches words, so on its own it cannot tell a passage that states the claim from one that only shares its words, and most do not state it (18% of its leads do, on the evaluation set). In the user script, the passages it finds are then checked against the claim by the Verify API (step 6), which needs no key.

1. **Search** — two families of full-text queries, run side by side, each strictest first until it has ten books:
   - *numbers and names*: the article's subject with every number and name in the claim, then with the numbers only, then with the strongest anchor;
   - *key phrases*: the subject's words with the claim's key phrases — runs of words between punctuation, function words and common verbs, a longer run split into pairs ("digestive enzymes", "father died", "Ptolemy II Philadelphus") — then fewer phrases, and last two phrases without the subject, since a Wikipedia title is often not how a book names its subject. An exact phrase comes back highlighted as one passage, which is the only way this search can ask for words that stand together. These also give a claim with no number or name something to search on.

   Terms are joined by a space, which the endpoint reads as AND. An explicit `AND` is not safe: between two terms it is taken for the word "and" (`"Feodora" AND "Leiningen"` returns exactly what `"Feodora" "Leiningen" "and"` does), and each book's few passages are then spent highlighting "and". A claim with neither a number, a name nor a key phrase is skipped.
2. **Access gate** — on each hit's own fields: lending-library books (`inlibrary`) are kept as *borrowable*; books only certified print-disabled readers can open (`printdisabled` without `inlibrary`) are dropped; everything else is *open*.
3. **Score** — each hit arrives with its matching passages, and each is scored on its own (two passages from one book may be pages apart), two ways:
   - with the sister-wiki scoring: it must contain one of the claim's numbers and mention the subject, then anchors and weighted token coverage decide;
   - by *claim units*: the claim's key phrases, numbers, names and longer words that a passage contains. Two units, one of them a phrase, number or name, are enough — the passage need not carry the claim's number ("The acini secrete several digestive enzymes"). It must still mention one of the subject's words, unless the book's title is about the subject ("Prince of Leiningen, who died in 1814" for "Feodora's father died in 1814" names Leiningen). Without that rule, two phrases of the claim were enough on their own: "working-class housing" and "middle-class housing" in a history of Nottingham housing, for a claim that Gothic details appeared in working-class housing. The three books with the most units are kept.

   The two rankings are taken in turn.
4. **Dedupe and look up** — one book per work: the same main title and a creator sharing a name (scans spell creators differently; a different author under the same title is a different work). On a tie, an open book ranks above a borrowable one. Then item metadata for the four kept: publisher and ISBN for the citation, and whether the book has been withdrawn.
5. **Whole text (CLI only for now)** — with `--full-text`, the CLI reads the whole OCR text of up to five open books (`archive.org/stream/{id}/{file}_djvu.txt`, the volume that matched) and shows the best ~450-character stretch — most claim units, centred — instead of the ~100-character highlights, adding up to two books whose highlights showed nothing. Lending-library texts are not public. The user script has the same code behind `window.cnfirmedArchiveFullText = true`, off by default: archive.org sends no CORS header on that page, so a browser refuses to hand the text to a script on a Wikipedia page. It can also be set to the URL prefix of a proxy that relays those pages.
6. **Check (user script, free)** — each lead's passages go to the Verify API (`POST /v1/verify` at `citation-verifier.toolforge.org`, the same claim-vs-source check `cnfirmed verify` uses) as the source text, with the claim: one call per book, one after another. Each book gets a verdict — *states the claim*, *states part of it*, *does not state it* — with a comment and, when the API located one, the words from the passage that back it (its `verified_text`), judged on the passages alone. The panel lists the books that state the claim or part of it, and only counts the rest. It runs by itself after the search; if it fails, the leads are shown marked *not checked*, with a button to try again. The service allows 30 requests a minute across all its callers, and a 429 is waited out. `npx tsx eval/run.ts --check` measures the check against the hand labels in `eval/labels.json`. The CLI does not run it. Set `window.cnfirmedVerifyUrl` before the script loads to use another host.

That is two to seven searches (two families in parallel) and at most six metadata requests per claim, plus up to five whole texts with `--full-text`, and one Verify API call per lead to check them. Each lead comes with its passages, the anchors they matched, a link that opens the book with the match searched, and a `{{cite book … |via=Internet Archive}}` — with `|url-access=registration` for a borrowable book, as InternetArchiveBot writes it. The page number is not known: the editor adds `|page=` after checking the passage. Old sources can be outdated or primary (WP:AGEMATTERS).

**Endpoints.** Only `https://archive.org` is on Wikipedia's CSP allowlist, so both front ends use the full-text search archive.org's own search page uses (`/services/search/beta/page_production/?service_backend=fts`) and `/metadata/{id}`; both were checked from a Wikipedia page. The `ia` package's `be-api.us.archive.org`, search-inside-the-book and OCR downloads are refused there, and are not used anywhere, so the CLI and the user script see the same data. The response shape is recorded in `test/fixtures/archive/`. Checked live: a space is AND; an exact `"phrase"` works and is highlighted as one passage; `identifier:x` and field ranges such as `year:[1800 TO 1930]` work. `AND` between two terms is read as the word "and"; `OR`, `NEAR` and proximity (`"a b"~20`, which reads `20` as a term) do not work. Each book comes back with at most five highlights of about 100 characters, each around one term.

**Periodicals.** The search surfaces many digitised magazines and journal volumes (*Scientific American*, *Engineering*), which are good sources, but every page of an 1889 issue prints "1889" in its masthead. For an item in the `periodicals` collection, its own year is therefore not counted as a matched number: a claim whose only number is that year gets nothing from that issue. Without this rule, an *Engineering* index line — "JULY 19, 1889 … Electricity on the Eiffel Tower, 702, 703" — scored 0.85 for "The tower opened to visitors in 1889", higher than any genuine passage.

**Measuring it.** The funnel line — `4 queries → 41 books → 38 readable (29 to borrow) (dropped: 3 print-disabled readers only) → 4 with a matching passage, 3 by claim phrases → 4 lead(s)` — is shown when you hover over the panel's Books line, logged to the browser console, and printed by the CLI, which can also save the raw responses with `--record <dir>`. It is not part of the CLI's `find` until those numbers say it earns its place.

## Policy handling (three layers)

1. **Hard domain blocklist** — `src/policy/unreliable_sources.ts` for the CLI, mirrored inline in `userscript/cnfirmed.js`. Catches WP:RSP-deprecated outlets deterministically, and is applied to wiki-local candidates too (so a `wikipedia.org` URL cited on another wiki never comes back — WP:CIRCULAR).
2. **Discovery-time prompt guidance** — `src/prompts/find_sources.md` (CLI) and the inlined system prompt (user script) steer the model toward WP:RS-compliant sources during search.
3. **Verifier reliability axis** — the context-sensitive judgment the domain blocklist cannot express. The user script's web search still grades it; the CLI's verifier (the Verify API) does not, so there it is the editor's call.

## Testing

```sh
npm test                                  # everything
npx tsx --test test/wikiSources.test.ts   # one file
npm run eval                              # the free stages on 100 real {{cn}} claims
```

`npm run eval` measures what the tests cannot: the shipped user script, run
over 100 real `{{citation needed}}` claims drawn from Category:All articles with
unsourced statements, replayed offline from recorded responses in a few
seconds, and scored against hand-checked answers. See `eval/README.md`.

The unit tests are fixture-based and fully offline — no network, no API key. Coverage: the wikitext claim extractor, `<ref>` parsing (named refs, list-defined refs, identifiers, archive fallback), the relevance scoring, the two wiki-local passes end to end (including a cross-script Japanese fixture), and the user-script parity test. Add fixtures in `test/fixtures/` as edge cases appear.

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
stage is phase 2 of that plan.

Both passes have been exercised against the live API from a user script on
en.wikipedia.org. The page's CSP is an allowlist: every Wikimedia project,
Toolforge, the three model providers, `archive.org` and `doi.org` are on it,
but most third-party APIs are not, and a request to one is refused before it
leaves the browser. A new retrieval source has to be checked against that list
first (see the plan doc); what is not on it needs a Toolforge proxy.

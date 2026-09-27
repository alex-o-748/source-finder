# Evaluation set

About 100 real `{{citation needed}}` claims, frozen, so a change to CNfirmed can be
measured in seconds without anyone opening a browser.

## What's here

| File | What it is |
| --- | --- |
| `claims.json` | The claims: article, revision, the tag's offset in that revision, and the subject stratum it was drawn from. |
| `strata.ts` | How the set is spread across subjects. |
| `cassettes/` | Every response the pipeline needs, recorded once (gzipped): the rendered article, its wikitext, interlanguage links, sister wikis' wikitext, Internet Archive searches and metadata. |
| `gold.json` | Per claim, by hand: the sentence the tag is really on, and whether a digitised book is a plausible source. |
| `labels.json` | Per claim and lead, by hand: does the lead's evidence state the claim? (`supports` / `partial` / `topic` / `unrelated` / `unknown`) |
| `results/` | What each run proposed. `baseline.json` is the reference; `latest.json` is the last run. |

## How the claims were drawn

From [Category:All articles with unsourced statements](https://en.wikipedia.org/wiki/Category:All_articles_with_unsourced_statements),
at random within each subject (CirrusSearch `articletopic:`), one claim per article.
About 60 come from subjects where a digitised book is a plausible source (history,
war, religion, literature, architecture, places, science), about 40 from subjects
where it mostly is not (sport, music, film and TV, games, business, politics,
medicine), so the Internet Archive stage has enough to find and the set still
shows what the tool does elsewhere. `gold.json` records per claim whether a book
is really plausible, which is what the scores are split on.

Lists, disambiguation pages and articles over 300 kB were skipped, and so were
tags whose claim was under 30 characters, table markup, or under five words.

## Running it

```sh
npm run eval                              # replay the free stages, then score
npx tsx eval/score.ts --against baseline  # what a change gained and lost
npx tsx eval/score.ts --unlabelled        # leads nobody has judged yet
# The first table is the headline: per method, how often a source is found.
npx tsx eval/run.ts --engine core         # the Node core (CLI) instead of the user script
npx tsx eval/run.ts --only military       # one stratum
npx tsx eval/run.ts --full-text --name fulltext  # also read open books' whole text (see below)
```

Replay needs no network. The default engine is the shipped user script, run over
the rendered article as in a browser (`eval/lib/userscript.ts`), so what is
scored is what an editor sees.

When a change makes a request nobody recorded (a new query, another sister
wiki), that claim fails with "not recorded". Record the gap, which needs access
to `*.wikipedia.org` and `archive.org`:

```sh
npm run eval:record
```

Wikipedia rate-limits API traffic from shared cloud addresses hard: recording
goes one request at a time per host and waits out every 429, so a full
re-record takes the better part of an hour. Replay is instant.

## When a change lands

1. `npm run eval` and `npx tsx eval/score.ts --against baseline`.
2. Judge any new leads (`--unlabelled`) and add them to `labels.json`: a
   lead is judged once, keyed by claim and source, and stays judged.
3. If the change is kept, copy `results/latest.json` to `results/baseline.json`
   and put the before/after table in the PR.

## Baseline (September 2026)

The user script on all 100 claims. "Found" means at least one lead whose
evidence states the claim's fact; "or partly" also counts one that states part
of it.

| Method | Found | Found or partly | Claims with any lead | Precision of leads |
| --- | --- | --- | --- | --- |
| Same article | 0% | 1% | 7% | 14% (of 7) |
| Other language editions | 2% | 3% | 9% | 21% (of 28) |
| Internet Archive | 3% | 17% | 74% | 14% (of 221) |
| Any | 5% | 20% | 76% | 15% (of 256) |

On the 46 claims where a book is a plausible source, the Archive finds 4% and
finds or partly finds 22%.

**How the Archive stage got there.** The previous baseline found 0%, or partly
5% (4% of the book-plausible claims), from 48 leads on 24 claims. Three changes:

- *Queries joined by spaces.* Between two terms, the endpoint reads `AND` as
  the word "and", so 62 of the 83 claims with a query spent their highlights
  on "and". On its own, in a hand-judged probe of the 46 book-plausible
  claims, this took "found or partly" from 4% to 20%.
- *Queries from the claim's key phrases*, beside the ones from its numbers and
  names. Claims with neither now get a query ("The acini secrete digestive
  enzymes" found "The acini secrete several digestive enzymes").
- *A second ranking by claim units*, which does not require the passage to
  name the subject or carry the number ("Prince of Leiningen, who died in
  1814" for "Feodora's father died in 1814").

The cost is noise: three claims in four now get Archive leads, and six in
seven of those leads do not state the claim. What still caps it is the
evidence: each book comes back with at most five highlights of about 100
characters, each around one term, so the right book often cannot show the
sentence. See `--full-text` below.

Before the same-sentence rule, same-article leads looked far better (53%
precision): 7 of its 8 good leads were references already attached to the
tagged sentence.

Claim extraction: the user script reads the tagged sentence right for 89 of
100 claims (the CLI's wikitext extractor, 74). The misses: a tag mid-sentence
cuts the claim short, an initial ("Franz A. Bischoff") is taken for a
sentence end, and twice the rendered tag is paired with the wrong wikitext tag.

What most bad leads have in common: they matched on numbers or names that are
in the paragraph but not in the claim (five Ju 52 accident reports matched
"52, 230"; four Belgium–Luxembourg sources matched years from neighbouring
sentences), or on a single common word ("Roman", "gulf", "10"), or, from the
key-phrase queries, on a date and a common word ("January 2010").

## Whole book texts (`--full-text`)

`npx tsx eval/run.ts --full-text` also reads the whole OCR text of up to five
open books per claim, as the CLI's `archive --full-text` does and as the user
script would with `window.cnfirmedArchiveFullText` set. The texts run to a
megabyte each, so they are recorded to `eval/cassettes-fulltext/`, which is
not committed: replaying this run needs a local recording (`--record`). A
lead read from a whole text is labelled separately (`ia:<id>#text`).

Run in September 2026 (`results/fulltext.json`): 355 whole texts read, 233
with a passage, 198 of those shown as leads.

| Internet Archive | Found | Found or partly | Claims with any lead | Precision of leads |
| --- | --- | --- | --- | --- |
| Highlights only (baseline) | 3% | 17% | 74% | 14% (of 221) |
| With whole texts | 4% | 18% | 79% | 11% (of 288) |
| …book-plausible claims | 7% | 24% | | |

A modest gain, at the cost of precision: a longer passage turns some partial
leads into ones that state the claim ("following the murder of Paul, Tsar
Alexander revived his grandmother's policy and began Russia's fourth and final
attempt to conquer the Caucasus"), but most books in the lending library,
where modern secondary sources are, have no public text.

## The web search (paid)

The user script's Claude web search runs with `--web`. Recording it needs a key
in the environment as `CNFIRMED_ANTHROPIC_API_KEY` (not `ANTHROPIC_API_KEY`,
which Claude Code reads itself); replaying a recorded call needs none. Each
call is recorded by a hash of its request body, so a prompt change is a new
recording. The key is sent in a header and never written to disk.

```sh
# Probe cost first: 5 claims spread across subjects, then all 100.
NODE_USE_ENV_PROXY=1 npx tsx eval/run.ts --record --web --limit 5 --name web-probe
NODE_USE_ENV_PROXY=1 npx tsx eval/run.ts --record --web
```

The run prints the calls, web searches and tokens it used. Web leads are
judged like the others, but from the model's own quote unless the page itself
can be read: with network access limited to Wikipedia and archive.org, it
cannot.

## What this set does not measure yet

- **Recall against a known answer.** The labels say whether a lead is right,
  not whether the right source was missed. Wikipedia's history can supply
  that: edits that replaced a `{{citation needed}}` with a `<ref>` give the
  claim and the source an editor chose.
- **The user interface** itself: badges, panel, insertion into the editor.

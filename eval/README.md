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

The user script on all 100 claims, after references already cited in the
tagged sentence stopped being offered (an editor saw those and still asked for
a citation). "Found" means at least one lead whose evidence states the claim's
fact; "or partly" also counts one that states part of it.

| Method | Found | Found or partly | Claims with any lead | Precision of leads |
| --- | --- | --- | --- | --- |
| Same article | 0% | 1% | 7% | 14% (of 7) |
| Other language editions | 2% | 3% | 9% | 21% (of 28) |
| Internet Archive | 0% | 5% | 24% | 10% (of 48) |
| Any | 2% | 8% | 33% | 14% (of 83) |

On the 46 claims where a book is a plausible source: found 2%, found or
partly 9%. The Archive stage offers a book for a third of them, but only 2 of
its 33 books state even part of the claim.

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
sentences), or on a single common word ("Roman", "gulf", "10").

Six Archive searches fail on every attempt (the service reports its search
backend failing, as HTTP 400) and are not recorded; those claims show
"not recorded" on replay.

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

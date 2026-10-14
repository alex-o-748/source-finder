# Finding a claim in the Internet Archive: searching like a librarian

**Status:** experiment, October 2026. Nothing here is in the user script yet.
The harness is `eval/experiments/archive-ideas.ts`; it runs on the eval set's
46 claims where a book is a plausible source.

## Why the current search finds the wrong books

The Archive stage takes the words of the claim, searches the OCR of every book
on archive.org for books containing them, and hopes the passage that states the
claim is among the five ~100-character highlights each book comes back with.
Three things defeat it:

1. **The claim as written cannot be searched, or checked.** "Feodora's father
   died in 1814", "His reign is a common delineation…", "It feeds on worms":
   the subject is in the paragraph, not the sentence. A book about Feodora's
   father calls him "Emich Charles, Prince of Leiningen" or "Prince Charles",
   never "Feodora's father". The same holds for the check afterwards: given
   only the claim, GPT-OSS said "In July 1814, however, Prince Charles died,
   leaving his wife…" does not support it.
2. **It asks the whole Archive instead of a shelf.** Forty million texts
   contain almost any three words together. Matching words is not reading,
   and nothing in the query says *which kind of book* would state the fact.
3. **It reads 100 characters.** Each highlight is centred on one search term,
   so a book that states the claim usually cannot show it.

## What a person does instead

A reference librarian asked to source "Feodora's father died in 1814":

1. **Reads the paragraph** and restates the claim: Emich Carl, Prince of
   Leiningen, died in 1814.
2. **Picks a shelf**: the books the article already cites; biographies of
   Queen Victoria and of the Duchess of Kent (Feodora's mother); a history of
   the Leiningen family. Catalogue subject headings find these
   ("Victoria, Queen of Great Britain, 1819-1901").
3. **Searches inside those books** for the one telling term, the year or the
   name, or goes to the index: "Leiningen, Emich Charles, Prince of, death".
4. **Reads the page.**

Every step has an equivalent the tool can call:

| Step | Capability | Checked here |
| --- | --- | --- |
| Restate the claim | a small model, from the paragraph | yes: GPT-OSS-20b and a strong-model stand-in |
| Shelf: cited books | the article's `{{cite book}}`s, found on archive.org by ISBN, else title and author | yes |
| Shelf: books about the subject | archive.org catalogue search on `title:` / `subject:` (Library of Congress headings) | yes |
| Shelf: a search engine's idea of the right book | Tavily (or any web search) limited to archive.org | yes |
| Search inside the shelf | full-text search with `identifier:(a OR b OR …)`: one query searches every book on the shelf, lending library included | yes, new |
| Read the page | an open book's whole text, best windows by concept coverage | yes |

`identifier:(a OR b OR c)` inside the full-text search is the enabling
discovery: `OR` does not work between search terms, but it does inside a field.
So one query per telling term returns the highlights around that term in every
book on a shelf, borrowable ones included, whose text is not otherwise public.
That is "search inside" for a whole shelf at the cost of one request.

## What was measured

`eval/experiments/archive-ideas.ts` runs each strategy on the 46 book-plausible
claims. Every strategy proposes up to five books; then, the same for all:

- **Shelf search**: every proposed book is searched inside for the claim's
  three most telling terms, one query per term, with `identifier:(…)`.
- **Reader**: an open book's whole text is scanned for the 1,000-character
  windows holding the most claim concepts (weighted by how rare each is in that
  book, a number or name required); the best two are kept.
- **Judge**: GPT-OSS-20b, through the Worker, decides whether the passages
  state the claim, given the claim, its paragraph, and the restated claim.
  The Verify API then gives a second opinion on every book GPT-OSS keeps.
- **By hand**: every book either judge said *states the claim* was read
  (`eval/experiments/verified.json`).

The planner, which restates the claim and writes the queries, is either
GPT-OSS-20b (free, through the Worker) or a strong model. The Anthropic key
here had no credit, so the strong-model plans were written by Claude in the
session, in the same JSON shape and from the same inputs
(`eval/experiments/plans-manual.json`); they stand in for Haiku or Sonnet.

The strategies:

| Strategy | Books from |
| --- | --- |
| baseline | today's user script (the leads in `eval/results/baseline.json`) |
| baseline+r | the same books, with the shelf search, reader and judge above |
| llm-fts | the Archive's full-text search, three queries written by the planner |
| tavily | Tavily limited to archive.org, queried with the claim |
| tavily-llm | the same, queried with the restated claim |
| topic | catalogue search on `title:`/`subject:` for books *about* the subject, planner's queries |
| cited | the article's own `{{cite book}}`s, found on the Archive by ISBN or title and author |

### Results

**Claims with a book that states the claim, checked by hand:**

| | Claims (of 46) |
| --- | --- |
| Today's search (hand labels, `eval/labels.json`) | 2 (4%) |
| All strategies, GPT-OSS-20b planner (free) | 6 (13%) |
| All strategies, strong-model planner | 7 (15%) |
| Either planner | 9 (20%) |

The nine: Feodora's father (ten books, from an 1873 memoir to a 1988
biography), the Senate's votes (Abbott, *Roman Political Institutions*, 1901,
which the Wikipedia paragraph closely follows), Ostoja's war on Ragusa (Dedić,
*The Bosnian Kingdom and the Serbian Despotate*), Elena Aiello and the
Freemason, the Vipakasutra's ten and ten stories (three books), the pancreatic
acini, Philoteria named for Ptolemy II's sister (Freyne, *Galilee from
Alexander the Great to Hadrian*, 1980, lending library), the otter civet's
webbed feet (*Raffles Bulletin of Zoology*), and average 1930s ticket prices
(the *Film Daily Year Book*'s table: "1935, 25 cents; 1934, 24 cents; 1933,
23 cents", in five editions). Only Feodora and the acini were found today.
Forty-six claims is a small sample: a claim or two either way is noise, the
step from 2 to 9 is not.

**Which strategy found them** (claims among the nine, either planner):
llm-fts 7, tavily or tavily-llm 4 (one only through Tavily: the Senate),
topic 3 (one only through it: the otter civet), baseline+r 2 (the two found
today), cited 0.

**By judge** (any lead the judge keeps; "both" = GPT-OSS keeps it and the
Verify API agrees):

| Planner | Strategy | States it (GPT-OSS) | …or part | States it (both) | …or part (both) |
| --- | --- | --- | --- | --- | --- |
| — | baseline (today's books and highlights) | 9% | 24% | | |
| strong | baseline+r | 7% | 24% | 9% | 17% |
| strong | llm-fts | 30% | 50% | 26% | 41% |
| strong | tavily | 13% | 30% | 11% | 15% |
| strong | topic | 4% | 22% | 9% | 15% |
| strong | cited | 0% | 4% | 0% | 0% |
| strong | all | 33% | 70% | 30% | 46% |
| GPT-OSS | llm-fts | 24% | 39% | 22% | 33% |
| GPT-OSS | all | 28% | 57% | 28% | 46% |

The judges are generous on "states it": of the 15 claims GPT-OSS said a book
states (strong planner), 7 hold up by hand; most of the rest state part of the
claim (a deposit dated "upper Cenomanian, ~95 Mya" for "the Upper Cenomanian
starts around 95 Mya"). Once GPT-OSS invented its quote. Read the judge columns
as "worth showing an editor", not as found.

### What the numbers say

1. **The queries are the lever.** The same books as today, read more fully
   and judged in context (baseline+r), find no more than today. Different
   books, from queries written the way a book would put it, account for 7 of
   the 9. "Feodora's father died in 1814" becomes `"Prince of Leiningen" 1814`;
   "the average price for a movie ticket hovered between 23 and 25 cents" becomes
   `"average admission" 1930s cents movie`, which reaches the trade annual that
   tabulated it.
2. **A free model writes nearly as good queries**, once told to take names only
   from the paragraph (unprompted, GPT-OSS-20b gave Feodora's father as "Prince
   August of Hesse-Kassel, who died in 1830"). Its weakness is copying
   Wikipedia's wording into over-long queries (`"No. 3 (Devonport) Division"
   "Royal Marine Police" 1934 "pulled out"`); a few examples in the prompt
   should fix most of that. Once in 46 it returned no usable plan.
3. **Restating the claim matters for the check too, and name variants are
   the hard part.** "In July 1814, however, Prince Charles died, leaving his
   wife Regent of Leiningen and guardian of their two children, … and Princess
   Feodora": given only the claim, GPT-OSS rejected it; told the father was
   Emich Carl, it rated it partial ("does not name him Emich Carl"), and the
   Verify API still rejected it. The restated claim should carry the variants
   a book may use ("Emich Carl, also Emich Charles, Prince Charles of
   Leiningen").
4. **The Verify API is strict on partial support.** Calibrated on today's leads
   against the hand labels, it kept 6 of the 19 good ones (GPT-OSS-20b: 13), and
   passed 5 of the 77 bad ones (GPT-OSS: 7). It drops 13 of 17 "partial" leads.
5. **A web search engine is a useful second opinion, not a replacement.**
   Tavily ranks whole books by relevance and found the Senate's source, which
   word matching could not. It also returns many books about the topic that
   do not state the fact (about one lead in ten judged good).
6. **Books about the subject, alone, rarely show the fact** (topic: 3 claims),
   and the article's own cited books never did (cited: 0; at least one cited
   book was found on the Archive for 43% of claims). A topical book has the
   fact on one page of three hundred, and five highlights per search term
   rarely land on it. These shelves need page-level search inside (below).

### A shortlist named by the model

A librarian also knows which books to open. The `llm-books` strategy asks the
model for up to six books likely to state the fact (title, author, year), finds
each on the Archive by title and author, and searches inside them as above.
It was tried on 12 claims where nothing else found anything, so these are the
hard cases (`results/books-*.json`; the strong-model lists, written for claims
whose sources had not been seen, are in `books-manual.json`).

| Lists by | Books named | On the Archive | Claims with a book that states it |
| --- | --- | --- | --- |
| a strong model | 55 | 30 | 1, and 1 partly |
| GPT-OSS-20b | 6 | 2 | 0 |

The find: Caroline Ticknor's *May Alcott: A Memoir* (1928) — after the death of
"her much beloved brother-in-law", "Louisa decided that she must return home in
the spring, but that May should remain for a year longer, in order to complete
her lessons… Concord was calling to Louisa, but not to May." The partial: Anna
Seward's *Memoirs of the Life of Dr. Darwin* (1804), the primary source for the
bridge and terrace at the Lichfield house.

GPT-OSS-20b cannot do this. Told to name only books it is sure exist, it
reasoned for some 15,000 tokens and returned an empty list for 11 of the 12;
without that instruction it invents ("The Ottoman Empire: A Short History", by
five different authors). Naming books takes a model's recall of the
literature, which a 20B model does not have. A name that does not exist costs
only a catalogue lookup, so a strong model's occasional mistake is cheap.

### Open models that can be free to the user

Through the Worker, three kinds of open model are reachable: Hugging Face
Inference Providers on `/hf` (an allowlist; the Worker's account pays), Wikimedia's
Lift Wing on `/liftwing` (free), and PublicAI on any other path (free). The
book shortlist above was rerun with each that answered, on the same 12 claims,
everything else unchanged (`results/books-{glm,apertus,qwen36}.json`).

| Model | Route | Books named | With any Archive record | Readable | States it / partly |
| --- | --- | --- | --- | --- | --- |
| strong model (stand-in) | — | 55 | — | 30 | 1 / 1 |
| GLM-5.2 | `/hf` | 70 | 40 | 30 | 0 / 2 |
| Apertus v1.5 70B | PublicAI | 51 | 7 | 4 | 0 / 0 |
| Qwen3.6 27B | Lift Wing | 72 | 9 | 8 | 0 / 0 |
| GPT-OSS 20B | `/hf` | 6 | — | 2 | 0 / 0 |

GLM-5.2 names the books a librarian would (Teixidor's two Palmyra books for
Baalshamin, Peirce and Uluçay for the Ottoman harem, Groueff's life of Boris
III, Sablinsky's *The Road to Bloody Sunday*, Shealy's *Little Women Abroad*
for the Alcott sisters in Europe); its titles without an Archive record are
real books that were never digitised. Apertus and Qwen3.6 mostly invent: one
title in seven has any record ("Florence Scovel Shinn, *The Life of Louisa May
Alcott*"). A one-question probe (Feodora's father and the year he died) told
the same story: GLM-5.2 and Apertus 70B right; Qwen3-32B, Qwen3.6-27B,
Qwen3-14B and Apertus 8B wrong.

GLM-5.2 is also the best judge measured. On today's 97 hand-labelled leads:

| Judge | Good leads kept (of 19) | Bad leads passed (of 77) | Precision |
| --- | --- | --- | --- |
| Verify API | 6 | 5 | 55% |
| GPT-OSS-20b | 13 | 7 | 65% |
| GLM-5.2 | 13 | 2 | 87% |

At about $1.40 / $4.40 per million tokens (input / output; first-party and most
hosts), GLM-5.2 costs the Worker about $0.007 per claim to name books
(~300 tokens in, ~1,500 out) and about a third of a cent per book judged on
whole-text windows (~900 in, ~500 out); judging every book on a 15-book
shortlist would be some 5 cents a claim, so GPT-OSS should sift and GLM-5.2
confirm the few it keeps.

Not tested, for lack of an allowlist entry or an enabled provider: the
strongest open models this month (Kimi K3, DeepSeek V4, GLM-5.3, MiMo-V2.6;
rankings disagree). `deepseek-ai/DeepSeek-V3.2-Exp` is on the allowlist but no
provider enabled on the Worker's Hugging Face account serves it.

## Recommendations

In order of gain per effort:

1. **Restate the claim and write the queries with a small model.** One call
   per claim, before any search: the restated claim, three full-text queries
   in a book's wording, the claim's telling terms (numbers and names first).
   GPT-OSS-20b through the Worker does this at no cost to the user; Claude
   Haiku 5.5 would cost about a tenth of a cent a claim. Keep today's
   deterministic queries alongside.
2. **Search inside the shortlist with one query per telling term**
   (`"1814" identifier:(a OR b OR …)`). Plain archive.org, already reachable
   from the user script.
3. **Send the restated claim to the check**, not the bare sentence, and keep
   only quotes found verbatim in the passages (`verified_text` already does).
4. **Read open books' whole text** through the Worker (archive.org sends no
   CORS header on `/stream/`), and show the best window.
5. **Add Tavily on archive.org** as a second source of books, for users with a
   Tavily key or through the Worker.
6. **Ask GLM-5.2 (via `/hf`) to name the books** and add them to the
   shortlist; and let it confirm what GPT-OSS keeps. Not GPT-OSS-20b, Apertus
   or the Lift Wing Qwens for naming books: they invent them.
7. **Then** subject shelves and cited books, once page-level search inside is
   available (the BookReader search below).

## In production (October 2026)

Items 1, 2, 3 and 6 above are in both front ends (README, "Books on the
Internet Archive"), with GLM-5.2 for all three model steps (plan, name books,
check) rather than GPT-OSS-20b: it plans better, it names real books, and as
the only judge it beats GPT-OSS sifting plus a second opinion. The check is
one call per claim, every lead at once, and a verdict counts only when its
quote is in the passages. On all 100 evaluation claims (`eval/README.md`), the
Archive's "found or partly" went from 17% to 28% (book-plausible: 22% to
39%), and the leads the panel shows, the checked ones, are 55% good (18%
before), at about 2.4 US cents a claim of GLM-5.2 paid by the Worker.

Not built yet: whole texts through the Worker (item 4), Tavily as a source of
books (item 5), page-level search inside (item 7). Two things the production
run taught: archive.org's full-text backend fails some 1 query in 8 under
load and serves the failure again for the same URL, so a failed search is
asked again for one more hit; and GLM-5.2 now and then reasons until it runs
out of tokens, past the Worker's 60-second limit to Hugging Face, so the
calls are capped and tried once more. Raising the Worker's upstream timeout
would let the check think longer on claims with many leads.

## Cost, and the path to free

Per claim, as measured here:

| Step | Calls | Cost |
| --- | --- | --- |
| Planner | 1 GPT-OSS-20b call, ~650 tokens in, ~1,500 out | free to the user (Worker); about $0.001 on Claude Haiku 5.5 |
| Archive.org | 3 searches + ~6 shelf searches, metadata, a few whole texts | free; ~25 s per full-text query, so a minute or two per claim |
| Tavily (optional) | 1–2 advanced searches | 2 credits each: about 250 claims a month on the free 1,000 credits, then paid per credit |
| Judge | ~14 GPT-OSS-20b calls, ~13k tokens in, ~7k out | free to the user (Worker); about $0.005 on Haiku 5.5 |
| Second opinion | Verify API on the 2–3 books kept | free, 30 requests a minute shared |

Everything but Tavily is free at the point of use today, through archive.org
and the Worker. The cost that remains is time: the Archive's full-text search
takes ~25 seconds a query. That is the case for running it ahead of time
(the "precompute" idea in `source-quality-and-cost-plan.md`): a nightly job
over Category:All articles with unsourced statements, results on Toolforge,
the user script looking them up. At under a cent a claim on Haiku 5.5, or
the Worker's cost on GPT-OSS, the whole backlog is affordable.

## Capabilities not tested here, worth a look

This sandbox could not reach them (network policy, no key, or no credit), so
they are leads, not results. Each is reachable from the user script through
the Worker, which is on Wikipedia's CSP allowlist.

- **Search inside one book, page by page.** The BookReader's own search
  (`{server}/fulltext/inside.php?item_id=…&q=…`, on the item's numbered
  `ia8xxxxx.us.archive.org` server, server and path from `/metadata/{id}`)
  returns every hit in a book with its page number and longer context,
  lending-library books included. That is the page an editor needs for
  `|page=`, and the "read the page" step for books whose text is not public.
- **Open Library's search inside** (`openlibrary.org/search/inside.json?q=`):
  the same full-text index presented per edition, which should bring edition
  records (publisher, ISBN) for a better `{{cite book}}`; whether it also gives
  page numbers needs checking.
- **Google Books full-text search** (`www.googleapis.com/books/v1/volumes?q=`):
  much better relevance ranking than the Archive's, phrase search, snippets;
  free with an API key, within a daily quota (the keyless quota is zero). Use
  it to *find* the book, then look the ISBN up on the Archive (`isbn:`) to get
  a readable copy; or cite Google Books, as editors routinely do. Both are
  now strategies in the harness (`gbooks`, `gbooks-direct`), waiting on a key.
- **HathiTrust full-text search** reports the pages where terms occur even in
  books it cannot show. No API; the HTML would have to be read through the
  Worker.
- **Claude with web search limited to archive.org** (`allowed_domains`), the
  agentic version of the librarian. Built into the harness
  (`--skip ''` runs it) but not run: the key here had no credit.
- **Back-of-book indexes.** The highlights often land on index pages ("Feodora,
  Princess, see Leiningen", "Charles Prince Leiningen, and her sister Feodora,
  i. 95"). An index entry
  gives the page; with page-level text (the BookReader search, or `_djvu.xml`
  for open books) the tool could read exactly that page, the way a person does.
- **Wikidata for the shelf.** The subject's Library of Congress heading
  (P244) makes the `subject:` search exact, and books with "main subject"
  (P921) set to the article's item and an Internet Archive ID (P724) are a
  ready-made shelf.

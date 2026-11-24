# Hints API (for Citation Hunt and other tools)

A lookup service on Toolforge (`cnfirmed.toolforge.org`) that tells a tool
whether a `{{citation needed}}` claim has an Internet Archive book a model
checked and found to state it. Citation Hunt can show it as a hint beside a
snippet ("A book may back this up").

The book search takes a minute or more per claim, so nothing is computed when
someone asks. A batch job computes articles ahead of time and stores one JSON
file per article; the web service only reads those files.

```
src/hints/
  match.ts    which claim a snippet's text is about
  compute.ts  the book search + the model check, per article
  store.ts    one JSON file per article on the tool's NFS share
  server.ts   GET /v1/hints
  web.ts      starts the web service (Procfile: web)
  batch.ts    the batch job (Procfile: batch)
  chat.ts     Hugging Face with the tool's own token, else the Worker
```

## The API

```
GET https://cnfirmed.toolforge.org/v1/hints?wiki=en&page_id=21073&text=<snippet>
```

| Parameter | |
| --- | --- |
| `wiki` | Language code, default `en`. |
| `page_id` | The article's page id (Citation Hunt's `articles.page_id`). |
| `text` | The snippet, as HTML or plain text. Optional: without it, every claim in the article is returned. |

Claims are matched by text, not by Citation Hunt's snippet id, which is a hash
of the snippet's HTML and changes with any edit to the paragraph. A claim
matches when its sentence is in `text`, or, for a claim of six words or more,
when 85% of its words are.

**200**: the article was computed. `claims` holds the matched claims;
`books: []` means it was looked for and nothing passed the check.

```json
{
  "wiki": "en", "page_id": 21073, "title": "Mad (magazine)",
  "rev_id": 1386652561, "computed_at": "2026-11-24T20:50:40.979Z",
  "claims": [{
    "claim": "Another publisher's comic was Trash (1978)",
    "section": "Other satiric-comics magazines",
    "status": "checked",
    "books": [{
      "verdict": "supports",
      "quote": "TRASH Trash Publ. Co.: Mar, 1978 - No. 4, Oct, 1978",
      "title": "Official Overstreet comic book price guide",
      "year": 2002, "access": "borrow",
      "url": "https://archive.org/details/officialoverstre00robe?q=…",
      "cite": "<ref>{{cite book |…|via=Internet Archive}}</ref>"
    }]
  }]
}
```

`status` is `checked`, `no_leads` (the search found no book to check) or
`error` (the batch job will try again). Show a hint only when `books` is not
empty. `verdict` is `supports` or `partial`; `quote` is words from the book's
passage, checked to be in its OCR text. `access: "borrow"` needs a free
archive.org account.

**404** `{"error": "not_checked"}`: the article has not been computed.
**400**: a bad parameter.

Responses carry `Access-Control-Allow-Origin: *` and `Cache-Control: public,
max-age=300`, so a page can call the API from the browser after the snippet
has rendered. Give it a short timeout and show nothing on failure: the hint is
never worth delaying the page for.

## Deploying on Toolforge

Check these commands against Toolforge's current documentation
(wikitech.wikimedia.org, Help:Toolforge/Build Service); they are written
from memory.

```bash
ssh login.toolforge.org
become cnfirmed

# Where the hints are kept, seen by both the web service and the job.
mkdir -p ~/hints
toolforge envvars create HINTS_DIR /data/project/cnfirmed/hints

# Optional: the tool's own Hugging Face token. Without it, model calls go
# through the CNfirmed Worker, which allows 20 requests a minute per address,
# and Toolforge's tools share a few addresses.
toolforge envvars create HF_TOKEN

# Build from GitHub (the Node buildpack runs `npm run build`), then start.
toolforge build start https://github.com/alex-o-748/source-finder --ref <branch>
toolforge webservice buildservice start --mount=all
curl https://cnfirmed.toolforge.org/healthz
```

A pilot run, 50 random articles about military history with a `{{cn}}` tag:

```bash
toolforge jobs run pilot --image tool-cnfirmed/tool-cnfirmed:latest --mount=all \
  --command "batch --search 'incategory:\"All articles with unsourced statements\" articletopic:military-and-warfare' --limit 50 --random"
toolforge jobs logs pilot
```

`batch` takes `--title <t>` (repeatable), `--titles <file>` (one title a
line) or `--search <CirrusSearch query> --limit <n> [--random]`. An article
stored at its current revision, by the current pipeline version, with no
failed claim, is skipped; `--force` recomputes it.

## Measuring before announcing

Each stored claim keeps every book the check read and its verdict
(`verdicts`, not served by the API), so a pilot can be labelled by hand:
of the books the API would show, how many really state the claim. That
precision is the number to give before Citation Hunt turns the hint on.

The search is not deterministic. On Mad (magazine), one run found the
*Trash* (1978) entry in an Overstreet price guide; two later runs were
given another edition of the guide, whose passages did not hold it, and
showed nothing. A miss stays stored until the article is edited, so a
later version of the job may want to retry claims that found nothing.

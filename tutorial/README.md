# Tutorial video

Scripts that record `CNfirmed_tutorial.webm`, the tutorial on Commons: the user
script running on English Wikipedia in a headless browser, with captions, a
drawn cursor and title cards, assembled with ffmpeg into a 1920×1080 VP9 WebM.
The style follows the Source Verifier tutorial
(`File:Source_Verifier_tutorial.webm`).

Re-record it when the panel changes enough that the video no longer matches.

## What it shows

The examples are the author's own CNfirmed edits, replayed on the revisions
before them:

| Scene | Page | What happens |
| --- | --- | --- |
| `install` | User:Alaexis/CNfirmed | the importScript line |
| `article` | Battle of France (rev 1381720666) | badges, the Abbeville claim, the Internet Archive search, Forczyk's *Case Red*, Insert in editor |
| `diff-bof` | Special:Diff/1381725946 | the edit as saved |
| `all` | Battle of France | the claims list, Find sources for all (free), the web-search offer |
| `web` | Battle of France | the Basque-coast claim, a web search (Tavily + GPT-OSS) |
| `airbus` | Airbus (rev 1380076173) | a same-article lead, Remove sentence |
| `diff-airbus` | Special:Diff/1380103475 | the sentence removed |
| `pick` | Battle of France | Tools → Find sources for a claim on untagged text |
| `settings` | Battle of France | provider and key |

## How it works

- `harness.mjs` launches Chromium at 1280×720 CSS px with a device scale of
  1.5 (so frames are 1920×1080), captures frames with the DevTools screencast,
  and draws the cursor, click ripples and captions in the page.
- Every request goes through a disk cache (`cache/`). The first run of a scene
  fetches for real, honouring `Retry-After` on Wikimedia's 429s; later runs
  replay the same responses with shortened delays, so a take can be redone
  with the same results. A model reply with no answer is never cached, so the
  script's own retry reaches the model.
- An article in `PAGES` is served as the revision before the author's edit:
  that revision's HTML (with the current page's section [edit] links, which
  MediaWiki leaves off old revisions, put back and the "old revision" notice
  hidden), its wikitext for the API, and its text in the editor.
- The user script is loaded from `../userscript/cnfirmed.js`, at the URL
  `importScript('User:Alaexis/CNfirmed.js')` would load.
- The editor is not shown: the recording machine's IP range was blocked from
  editing, so the scenes click Insert in editor / Remove sentence (with
  `window.open` stubbed) and cut to the edit as it was saved.

## Running it

Needs Node 18+, Playwright with Chromium, ffmpeg with libvpx-vp9, Python 3,
and the Inter font for the cards.

```sh
cd tutorial
node scenes.mjs install article diff-bof all web airbus diff-airbus pick settings
node cards.mjs out
python3 compose.py plan.json out/CNfirmed_tutorial.webm
python3 preview.py takes/article 3   # contact sheet of one take, for checking
```

Run a scene twice when it is new: the first run fills the cache at the speed
of the real services (the Internet Archive's full-text search takes about 25
seconds a query), the second is the take. `warm.mjs`, `warm-all.mjs` and
`warm-pages.mjs` fill the cache for one claim, a whole page's free searches,
or plain pages, without recording.

`cache/`, `takes/`, `work/` and `out/` are not committed.

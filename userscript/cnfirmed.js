// {{Wikipedia:USync |repo=https://github.com/alex-o-748/source-finder |ref=refs/heads/main |path=userscript/cnfirmed.js}}

/**
 * CNfirmed user script — finds and verifies sources for {{citation needed}}
 * claims by calling Claude / Gemini / OpenAI directly from the browser using
 * the user's own API key (stored in localStorage) — or by searching with
 * Tavily through the publicai-proxy Worker (Wikipedia's CSP blocks Tavily
 * itself) and judging the results with an open-weight model. Tavily searches
 * are free, on the Worker's own key, while its credits last; after that they
 * need the user's Tavily key. Internet Archive books are found and checked
 * with the same open-weight model, which needs no key: Qwen 3.8 on Lift Wing
 * through the llm-router tool on Toolforge, or models on Hugging Face through
 * the Worker, as chosen in Settings (the Verify API,
 * https://citation-verifier.toolforge.org, when the model cannot).
 *
 * Add to User:Yourname/common.js:
 *
 *   importScript('User:Alaexis/cnfirmed.js');
 *
 * A web search with Claude, Gemini or OpenAI asks for an API key for that
 * provider the first time. Keys are kept in localStorage on the
 * Wikipedia origin and never leave your browser except in the request to the
 * provider you chose.
 *
 * UX:
 *   - A small badge appears next to every [citation needed] superscript.
 *     Click it to open that claim in a panel docked to the right edge. Both
 *     free searches start at once (citations already on Wikipedia, and
 *     Internet Archive books); the paid web search starts by itself only when
 *     both find nothing and a key is set.
 *   - The panel lists every source found, best first, whatever found it, and
 *     under it what was searched, with a button for each search not yet run.
 *   - A "CNfirmed (N)" link opens the list of all claims, with "Find sources
 *     for all (free)" and, for the claims left with nothing, a web search.
 *     "All claims" above a claim goes back to it. On a page without tags the
 *     link is just "CNfirmed", and opens the panel on selecting text to find
 *     sources for, as "Find sources for a claim" in Tools does everywhere.
 *   - Provider and key are behind the panel's gear.
 *
 */
/* eslint-disable */
(function () {
  'use strict';

  // ---- Boot guards ------------------------------------------

  if (window.cnfirmedLoaded) return;
  window.cnfirmedLoaded = true;

  if (mw.config.get('wgNamespaceNumber') !== 0) return;
  var WG_ACTION = mw.config.get('wgAction');
  if (WG_ACTION !== 'view' && WG_ACTION !== 'edit' && WG_ACTION !== 'submit') return;
  if (!/wikipedia\.org$/.test(mw.config.get('wgServer') || '')) return;

  // ---- Providers --------------------------------------------------------

  var PROVIDERS = {
    claude: {
      name: 'Claude',
      keyStorage: 'cnfirmed-key-claude',
      defaultModel: 'claude-sonnet-5',
      modelOverride: 'cnfirmedModelClaude',
      // web_search_20260209 filters result pages with code before the model
      // reads them; web_search_20250305 hands them over as they are.
      defaultSearchTool: 'web_search_20260209',
      searchToolOverride: 'cnfirmedSearchToolClaude',
      run: callClaude
    },
    gemini: {
      name: 'Gemini',
      keyStorage: 'cnfirmed-key-gemini',
      defaultModel: 'gemini-flash-latest',
      modelOverride: 'cnfirmedModelGemini',
      run: callGemini
    },
    openai: {
      name: 'OpenAI',
      keyStorage: 'cnfirmed-key-openai',
      defaultModel: 'gpt-5-mini',
      modelOverride: 'cnfirmedModelOpenAI',
      run: callOpenAI
    },
    // Tavily does the searching and the open-weight model chosen in Settings
    // reads what it found; the model never searches on its own. The search
    // goes through the Worker (Wikipedia's CSP blocks Tavily itself), which
    // pays for it while its Tavily credits last. After that the user's own
    // Tavily key pays for it.
    tavilyhf: {
      name: 'Tavily + open-weight model',
      keyStorage: 'cnfirmed-key-tavily',
      keyLabel: 'Tavily API key',
      keyService: 'Tavily',
      freeSearches: true,
      // The reader of the chosen open-weight model, unless overridden.
      openModel: true,
      modelOverride: 'cnfirmedModelHf',
      run: callTavilyGptOss
    }
  };

  // ---- Open-weight models -----------------------------------------------
  // The Tavily reader and the Internet Archive librarian run on open-weight
  // models that need no key, from one of two hosts chosen in Settings:
  //   hf        Hugging Face Inference Providers, through the Worker, which
  //             pays for them while its credits last. The default: GLM-5.2
  //             names real books and checks passages better than Qwen 3.8.
  //   liftwing  Wikimedia's Lift Wing, through the llm-router tool on
  //             Toolforge (the Worker does not allow Qwen 3.8). Free.
  // A request goes to the host that serves its model: Lift Wing's model ids
  // all start with "llm-". So a model set on window (cnfirmedModelHf, or
  // cnfirmedArchive*Model below) goes where it is served, whichever is chosen.

  var LLM_ROUTER_BASE = String(window.cnfirmedLlmRouterUrl || 'https://llm-router.toolforge.org')
    .replace(/\/+$/, '');
  var OPEN_MODEL_STORAGE = 'cnfirmed-open-model';

  var OPEN_MODELS = {
    // Must be in the Worker's HF_ALLOWED_MODELS.
    hf: {
      name: 'Hugging Face',
      blurb: 'GPT-OSS reads web results, GLM-5.2 finds and checks books. Paid for by the CNfirmed Worker ' +
        'while its credits last.',
      reader: 'openai/gpt-oss-20b',
      planner: 'zai-org/GLM-5.2',
      books: 'zai-org/GLM-5.2',
      judge: 'zai-org/GLM-5.2'
    },
    // Must be in llm-router's LIFTWING_ALLOWED_MODELS.
    liftwing: {
      name: 'Qwen 3.8 on Lift Wing',
      blurb: 'Wikimedia’s own model hosting, through the llm-router tool on Toolforge. Free.',
      reader: 'llm-qwen38-27b',
      planner: 'llm-qwen38-27b',
      books: 'llm-qwen38-27b',
      judge: 'llm-qwen38-27b'
    }
  };

  function getOpenModel() {
    var m = localStorage.getItem(OPEN_MODEL_STORAGE);
    return OPEN_MODELS[m] ? m : 'hf';
  }

  function setOpenModel(m) {
    if (!OPEN_MODELS[m]) return;
    localStorage.setItem(OPEN_MODEL_STORAGE, m);
  }

  function onLiftWing(model) {
    return /^llm-/.test(model);
  }

  // Where a chat completion for this model goes, and what to call the host.
  function openModelUrl(model) {
    return onLiftWing(model) ? LLM_ROUTER_BASE + '/liftwing' : PROXY_BASE + '/hf';
  }

  function openModelHost(model) {
    return onLiftWing(model) ? 'Lift Wing' : 'Hugging Face';
  }

  function keyLabel(providerId) {
    var p = PROVIDERS[providerId];
    return p.keyLabel || p.name + ' API key';
  }

  // Someone who never picked a provider gets the one that needs no key,
  // unless they already saved a Claude key under the old default.
  function getProvider() {
    var p = localStorage.getItem('cnfirmed-provider') || (getKey('claude') ? 'claude' : 'tavilyhf');
    return PROVIDERS[p] ? p : 'claude';
  }

  function setProvider(p) {
    if (!PROVIDERS[p]) return;
    localStorage.setItem('cnfirmed-provider', p);
  }

  function getKey(providerId) {
    return localStorage.getItem(PROVIDERS[providerId].keyStorage) || '';
  }

  function setKey(providerId, value) {
    var key = (value || '').trim();
    if (key) localStorage.setItem(PROVIDERS[providerId].keyStorage, key);
    else localStorage.removeItem(PROVIDERS[providerId].keyStorage);
  }

  // ---- Free web searches ------------------------------------------------
  // The Worker answers 402 free_credits_exhausted once its Tavily credits are
  // spent. That is remembered for a while, so every claim does not have to
  // fail first to find out, and checked again with the Worker when a panel
  // opens on a later page.

  var FREE_SPENT_STORAGE = 'cnfirmed-free-searches-spent';
  var FREE_SPENT_FOR_MS = 6 * 60 * 60 * 1000;
  var NO_FREE_SEARCHES = 'No free web searches left. Add your own Tavily key to keep searching ' +
    'the web, or switch to Claude, Gemini or OpenAI, which search the web themselves (with your key).';

  function freeSearchesSpent() {
    var at = Number(localStorage.getItem(FREE_SPENT_STORAGE)) || 0;
    return at > 0 && Date.now() - at < FREE_SPENT_FOR_MS;
  }

  function setFreeSearchesSpent(spent) {
    if (spent) localStorage.setItem(FREE_SPENT_STORAGE, String(Date.now()));
    else localStorage.removeItem(FREE_SPENT_STORAGE);
  }

  // Searching on the Worker's credits: no key of the user's own.
  function onFreeSearches(providerId) {
    return !!PROVIDERS[providerId].freeSearches && !getKey(providerId);
  }

  function canSearchWeb(providerId) {
    return !!getKey(providerId) || (onFreeSearches(providerId) && !freeSearchesSpent());
  }

  // Once a page: does the Worker still have credits? Redraws if it changed.
  var freeSearchesChecked = false;
  function checkFreeSearches() {
    if (freeSearchesChecked) return;
    freeSearchesChecked = true;
    fetch(PROXY_BASE + '/tavily').then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      if (!data || typeof data.shared !== 'boolean') return;
      var was = freeSearchesSpent();
      setFreeSearchesSpent(!data.shared);
      // Not under someone typing a key.
      if (was !== !data.shared && panelView !== 'settings') renderPanel();
    }).catch(function () { /* the next search finds out */ });
  }

  function noFreeSearchesError() {
    var err = new Error(NO_FREE_SEARCHES);
    err.noFreeSearches = true;
    return err;
  }

  function modelFor(providerId) {
    var p = PROVIDERS[providerId];
    return window[p.modelOverride] || (p.openModel ? OPEN_MODELS[getOpenModel()].reader : p.defaultModel);
  }

  function searchToolFor(providerId) {
    var p = PROVIDERS[providerId];
    return window[p.searchToolOverride] || p.defaultSearchTool;
  }

  // ---- WP:RSP blocklist (in-script) -------------------------------------
  // Sourced from src/policy/unreliable_sources.ts. Kept short on purpose;
  // the prompt also instructs the model to avoid these.

  var UNRELIABLE_DOMAINS = [
    'dailymail.co.uk', 'thesun.co.uk', 'mirror.co.uk', 'rt.com',
    'sputniknews.com', 'breitbart.com', 'infowars.com', 'naturalnews.com',
    'occupydemocrats.com', 'thegatewaypundit.com', 'zerohedge.com',
    'theepochtimes.com', 'presstv.com', 'globalresearch.ca', 'veteranstoday.com',
    'wnd.com', 'newsmax.com', 'oann.com',
    'wikipedia.org', 'wikia.com', 'fandom.com', 'reddit.com', 'quora.com',
    'answers.com', 'medium.com', 'substack.com'
  ];
  var UNRELIABLE_SET = (function () {
    var s = Object.create(null);
    UNRELIABLE_DOMAINS.forEach(function (d) { s[d] = true; });
    return s;
  })();
  function isUnreliableDomain(url) {
    try {
      var host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      if (UNRELIABLE_SET[host]) return true;
      for (var i = 0; i < UNRELIABLE_DOMAINS.length; i++) {
        var d = UNRELIABLE_DOMAINS[i];
        if (host === d || host.endsWith('.' + d)) return true;
      }
      return false;
    } catch (e) { return false; }
  }

  // ---- Combined find+verify prompt --------------------------------------
  // Browser flow collapses the two-call CLI pipeline (findSources +
  // verifySource) into one model call: the model uses its provider's web
  // search tool to discover candidates and verify them in the same loop.

  var SYSTEM_PROMPT = [
    'You find and verify sources for a Wikipedia claim that needs a citation',
    '(usually one tagged {{citation needed}}). You will receive a CLAIM,',
    'surrounding CONTEXT, and',
    'the SECTION heading.',
    '',
    'Use web search (and URL retrieval where available) to find up to 3 candidate',
    'sources that DIRECTLY substantiate the specific claim — not just the topic.',
    '',
    'Source-quality rules (per WP:RS):',
    '- Prefer secondary, independent, published sources: reputable news orgs',
    '  with editorial oversight; peer-reviewed journals; reputable books;',
    '  official statistical/governmental sources for their own statistics.',
    '- Prefer the original publisher\'s article over portals, aggregators,',
    '  syndications, or pages that merely embed the original.',
    '- Prefer text articles over video-only or media-player pages, since the',
    '  text is what supports the claim.',
    '- AVOID deprecated WP:RSP outlets: Daily Mail, The Sun, Mirror, RT,',
    '  Sputnik, Breitbart, Infowars, Natural News, Gateway Pundit, Zero Hedge,',
    '  Epoch Times, PressTV, Global Research, VeteransToday, WND, Newsmax,',
    '  OAN.',
    '- AVOID user-generated content (Wikipedia itself, Wikia/Fandom, Reddit,',
    '  Quora, random Medium/Substack posts) unless the post is by a',
    '  subject-matter expert.',
    '',
    'For each candidate, evaluate TWO INDEPENDENT axes:',
    '',
    '1. SUBSTANTIATION — does the source actually state (or directly imply) the',
    '   specific claim?',
    '   - Use only the source\'s own words.',
    '   - Accept paraphrasing and straightforward implications, but not',
    '     speculative inferences.',
    '   - Distinguish definitive statements from hedged language. Claims stated',
    '     as facts require sources that are likewise definitive.',
    '   - Verdict values:',
    '     - SUPPORTED          (confidence 80-100)',
    '     - PARTIALLY SUPPORTED (confidence 50-79)',
    '     - NOT SUPPORTED      (confidence 1-49)',
    '     - SOURCE UNAVAILABLE (confidence 0) — only when you cannot read the',
    '       source content (paywall, login wall, library catalog, 404, etc.).',
    '',
    '2. RELIABILITY (per WP:RS) — context-sensitive grade for the *kind of',
    '   claim* being made. A magazine profile is fine for a pop-culture fact;',
    '   a peer-reviewed paper is required for a medical claim; anything about',
    '   living people (BLP) demands strong sourcing.',
    '   - high   — clearly appropriate for the claim',
    '   - medium — usable with caveats (trade press, primary sources used as',
    '              primary, opinion pieces for attributed opinion, SPS for',
    '              author\'s own uncontroversial bio)',
    '   - low    — inappropriate for this claim (UGC, deprecated outlets,',
    '              tabloids for factual news, primary used for contentious',
    '              interpretation, fails BLP)',
    '   - n/a    — ONLY when verdict is SOURCE UNAVAILABLE',
    '',
    'Respond ONLY with valid JSON, no prose, no Markdown fences:',
    '',
    '{',
    '  "suggestions": [',
    '    {',
    '      "url": "https://...",',
    '      "title": "...",',
    '      "verdict": "SUPPORTED",',
    '      "confidence": 90,',
    '      "comments": "Brief quote from the source plus one-line explanation.",',
    '      "reliability": "high",',
    '      "reliability_reason": "Brief WP:RS-grounded rationale."',
    '    }',
    '  ]',
    '}',
    '',
    'If no suitable sources are found, return {"suggestions": []}.'
  ].join('\n');

  // ---- CSS --------------------------------------------------------------
  // Colours are tokens on :root, redefined under the skin's own night-mode
  // classes, so the panel and the badges follow the reader's theme. Every
  // control is styled here rather than left to the browser, which in night
  // mode draws native buttons dark on whatever background they sit on.

  var LIGHT_TOKENS = [
    '--cnf-bg:#ffffff', '--cnf-bg2:#f8f9fa', '--cnf-ink:#202122', '--cnf-ink2:#404244',
    '--cnf-ink3:#54595d', '--cnf-line:#dadde3', '--cnf-line2:#eaecf0', '--cnf-line3:#a2a9b1',
    '--cnf-link:#3366cc', '--cnf-hdr:#3056a9', '--cnf-pri:#3366cc', '--cnf-ok:#177860',
    '--cnf-warn:#7a5a1c', '--cnf-warnbg:#fdf2d5', '--cnf-err:#bf3c2c', '--cnf-hl:#fdf2d5',
    '--cnf-toast:#202122', '--cnf-toastink:#ffffff'
  ].join(';');
  var DARK_TOKENS = [
    '--cnf-bg:#101418', '--cnf-bg2:#1b1f24', '--cnf-ink:#eaecf0', '--cnf-ink2:#c8ccd1',
    '--cnf-ink3:#a2a9b1', '--cnf-line:#353a40', '--cnf-line2:#262a2f', '--cnf-line3:#5f656c',
    '--cnf-link:#88a3e8', '--cnf-hdr:#2a4b8d', '--cnf-pri:#3a65c9', '--cnf-ok:#4cb593',
    '--cnf-warn:#e2b45c', '--cnf-warnbg:#3a2d12', '--cnf-err:#fd7865', '--cnf-hl:#3d3317',
    '--cnf-toast:#eaecf0', '--cnf-toastink:#101418'
  ].join(';');

  mw.util.addCSS([
    ':root{' + LIGHT_TOKENS + '}',
    'html.skin-theme-clientpref-night{' + DARK_TOKENS + '}',
    '@media (prefers-color-scheme: dark){html.skin-theme-clientpref-os{' + DARK_TOKENS + '}}',
    '@keyframes cnfirmed-spin{to{transform:rotate(360deg)}}',
    '.cnfirmed-spin{animation:cnfirmed-spin 0.9s linear infinite}',


    // The badge after each [citation needed]. An SVG, not an emoji: CSS
    // cannot recolour an emoji, so its status colour never showed.
    '.cnfirmed-badge{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;' +
      'margin-left:2px;padding:0;vertical-align:-3px;border:1px solid var(--cnf-line);border-radius:4px;' +
      'background:var(--cnf-bg);color:var(--cnf-ink3);cursor:pointer;line-height:1}',
    '.cnfirmed-badge:hover,.cnfirmed-badge:focus-visible{border-color:var(--cnf-link);outline:none}',
    '.cnfirmed-badge svg{display:block;width:12px;height:12px}',
    '.cnfirmed-badge[data-status="found"]{color:var(--cnf-ok)}',
    '.cnfirmed-badge[data-status="partial"]{color:var(--cnf-warn)}',
    '.cnfirmed-badge[data-status="leads"],.cnfirmed-badge[data-status="running"]{color:var(--cnf-link)}',
    '.cnfirmed-badge[data-status="error"]{color:var(--cnf-err)}',
    '.cnfirmed-badge-picked{border-style:dashed;border-color:var(--cnf-link)}',
    '.cnfirmed-badge.cnfirmed-active{box-shadow:0 0 0 2px var(--cnf-hl)}',
    '::highlight(cnfirmed-claim){background-color:var(--cnf-hl)}',
    'sup.cnfirmed-active{background:var(--cnf-hl);box-shadow:0 0 0 2px var(--cnf-hl);border-radius:2px}',
    '.cnfirmed-flash{background:var(--cnf-hl) !important;transition:background 0.4s}',

    '#cnfirmed-panel{position:fixed;top:0;right:0;z-index:10001;display:flex;flex-direction:column;' +
      'width:400px;height:100vh;box-sizing:border-box;background:var(--cnf-bg);color:var(--cnf-ink);' +
      'border-left:1px solid var(--cnf-line);box-shadow:-2px 0 8px rgba(0,0,0,0.12);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue","Liberation Sans",sans-serif;' +
      'font-size:14px;line-height:1.45}',
    '#cnfirmed-panel[hidden],#cnfirmed-panel [hidden]{display:none !important}',
    'html.cnfirmed-panel-open body{margin-right:var(--cnfirmed-panel-width,400px) !important}',
    '#cnfirmed-panel *{box-sizing:border-box}',
    '#cnfirmed-panel button{font:inherit;color:inherit}',
    '#cnfirmed-panel a{color:var(--cnf-link)}',
    '#cnfirmed-panel :focus-visible{outline:2px solid var(--cnf-link);outline-offset:1px}',
    '#cnfirmed-panel .cnf-resize{position:absolute;left:-3px;top:0;width:6px;height:100%;cursor:ew-resize;z-index:1}',
    '#cnfirmed-panel .cnf-resize:hover{background:var(--cnf-link);opacity:0.4}',

    '#cnfirmed-panel .cnf-head{flex:none;display:flex;align-items:center;gap:2px;height:48px;' +
      'padding:0 6px 0 16px;background:var(--cnf-hdr);color:#fff}',
    '#cnfirmed-panel .cnf-brand{font-size:15px;font-weight:700;color:#fff;text-decoration:none}',
    '#cnfirmed-panel .cnf-brand:hover{text-decoration:underline}',
    '#cnfirmed-panel .cnf-spacer{flex:1}',
    '#cnfirmed-panel .cnf-title{padding:0 8px;font-size:13px;font-weight:600}',
    '#cnfirmed-panel .cnf-ib{display:inline-flex;align-items:center;justify-content:center;min-width:32px;' +
      'height:36px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:#fff;cursor:pointer;' +
      'font-size:13px;font-weight:600;white-space:nowrap}',
    '#cnfirmed-panel .cnf-ib:hover,#cnfirmed-panel .cnf-ib[aria-pressed="true"]{background:rgba(255,255,255,0.18)}',
    '#cnfirmed-panel .cnf-ib:disabled{opacity:0.4;cursor:default;background:transparent}',
    '#cnfirmed-panel .cnf-ib svg{display:block;width:16px;height:16px}',
    '#cnfirmed-panel .cnf-ib svg.cnf-gear{width:18px;height:18px}',

    '#cnfirmed-panel .cnf-claim{flex:none;padding:14px 16px 12px;background:var(--cnf-bg2);border-bottom:1px solid var(--cnf-line)}',
    '#cnfirmed-panel .cnf-section,#cnfirmed-panel .cnf-label{font-size:11.5px;font-weight:600;' +
      'letter-spacing:0.06em;text-transform:uppercase;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-label{margin:0 0 4px;padding:0;border:0;font-family:inherit;line-height:1.45}',
    '#cnfirmed-panel .cnf-claim-text{margin:4px 0 6px;max-height:6.5em;overflow:auto;font-size:14.5px;line-height:1.5}',
    '#cnfirmed-panel .cnf-linkbtn{padding:0;border:0;background:none;color:var(--cnf-link);font-size:12.5px;' +
      'cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
    '#cnfirmed-panel .cnf-claim-acts{display:flex;flex-wrap:wrap;gap:4px 16px}',
    '#cnfirmed-panel .cnf-claim-top{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}',
    '#cnfirmed-panel .cnf-chip{padding:0 7px;border:1px dashed var(--cnf-link);border-radius:999px;' +
      'font-size:11.5px;font-weight:600;line-height:18px;color:var(--cnf-link)}',
    '#cnfirmed-panel .cnf-cites{margin:0 0 8px;font-size:12.5px;line-height:1.45;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-pick .cnf-quote{margin-bottom:12px}',
    '#cnfirmed-panel .cnf-pick .cnf-actions{margin-top:0}',
    '#cnfirmed-panel .cnf-pick-reason{color:var(--cnf-warn) !important}',
    '#cnfirmed-panel .cnf-group-label{margin-top:14px}',
    '#cnfirmed-panel .cnf-ov-foot{padding-top:12px;border-top:1px solid var(--cnf-line2)}',
    '#cnfirmed-panel .cnf-back{display:inline-flex;align-items:center;gap:2px;margin:-4px 0 8px -4px;padding:2px 6px 2px 2px;' +
      'border:0;border-radius:4px;background:none;color:var(--cnf-link);font:inherit;font-size:13px;font-weight:600;cursor:pointer}',
    '#cnfirmed-panel .cnf-back:hover{background:var(--cnf-line)}',
    '#cnfirmed-panel .cnf-back svg{width:14px;height:14px}',
    '#cnfirmed-panel .cnf-body{flex:1 1 auto;min-height:0;overflow-y:auto}',
    '#cnfirmed-panel .cnf-pad{display:flex;flex-direction:column;gap:18px;padding:16px 16px 72px}',
    '#cnfirmed-panel .cnf-headline{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}',
    '#cnfirmed-panel .cnf-headline svg{flex:none;width:16px;height:16px;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-headline[data-busy] svg{color:var(--cnf-link)}',

    // One shape for every source, whatever found it. --cnf-v is the verdict colour.
    '#cnfirmed-panel .cnf-item{--cnf-v:var(--cnf-link);border-top:1px solid var(--cnf-line2)}',
    '#cnfirmed-panel .cnf-item[data-tier="supports"]{--cnf-v:var(--cnf-ok)}',
    '#cnfirmed-panel .cnf-item[data-tier="partial"],#cnfirmed-panel .cnf-item[data-tier="flag"]{--cnf-v:var(--cnf-warn)}',
    '#cnfirmed-panel .cnf-item[data-open]{margin:6px 0;border:1px solid var(--cnf-line);border-radius:8px;' +
      'box-shadow:0 1px 3px rgba(0,0,0,0.08)}',
    '#cnfirmed-panel .cnf-row{display:flex;align-items:flex-start;gap:10px;width:100%;padding:10px 8px;border:0;' +
      'border-radius:6px;background:transparent;text-align:left;cursor:pointer}',
    '#cnfirmed-panel .cnf-row:hover{background:var(--cnf-bg2)}',
    '#cnfirmed-panel .cnf-glyph{flex:none;display:inline-flex;margin-top:2px;color:var(--cnf-v)}',
    '#cnfirmed-panel .cnf-glyph svg,#cnfirmed-panel .cnf-chev svg{display:block;width:16px;height:16px}',
    '#cnfirmed-panel .cnf-row-main{flex:1;min-width:0}',
    '#cnfirmed-panel .cnf-row-title{display:block;font-size:14px;font-weight:600;line-height:1.35;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#cnfirmed-panel .cnf-item[data-open] .cnf-row-title{white-space:normal;overflow-wrap:anywhere}',
    '#cnfirmed-panel .cnf-row-meta{display:block;margin-top:2px;font-size:12.5px;line-height:1.4;' +
      'color:var(--cnf-ink3);overflow-wrap:anywhere}',
    '#cnfirmed-panel .cnf-verdict{font-weight:600;color:var(--cnf-v)}',
    '#cnfirmed-panel .cnf-chev{flex:none;display:inline-flex;margin-top:2px;color:var(--cnf-ink3);transition:transform 0.15s}',
    '#cnfirmed-panel .cnf-item[data-open] .cnf-chev{transform:rotate(90deg)}',
    '#cnfirmed-panel .cnf-detail{padding:0 12px 14px 34px}',
    '#cnfirmed-panel .cnf-quote{padding:10px 12px;border-radius:6px;background:var(--cnf-bg2);font-size:13.5px;' +
      'line-height:1.5;color:var(--cnf-ink2);overflow-wrap:anywhere;unicode-bidi:plaintext}',
    '#cnfirmed-panel .cnf-quote-label{display:block;margin-bottom:2px;font-size:12px;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-warnbox{display:flex;gap:8px;margin-top:10px;padding:9px 11px;border-radius:6px;' +
      'background:var(--cnf-warnbg);color:var(--cnf-warn);font-size:12.5px;line-height:1.45}',
    '#cnfirmed-panel .cnf-warnbox svg{flex:none;width:16px;height:16px;margin-top:1px}',
    '#cnfirmed-panel .cnf-note{margin:8px 0 0;font-size:12.5px;line-height:1.45;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}',
    '#cnfirmed-panel .cnf-btn{display:inline-flex;align-items:center;min-height:34px;padding:0 12px;' +
      'border:1px solid var(--cnf-line3);border-radius:6px;background:transparent;color:var(--cnf-ink);' +
      'font-size:13.5px;font-weight:600;cursor:pointer}',
    '#cnfirmed-panel .cnf-btn:hover{background:var(--cnf-bg2)}',
    '#cnfirmed-panel .cnf-btn:disabled{opacity:0.6;cursor:default}',
    '#cnfirmed-panel .cnf-btn-pri{border-color:var(--cnf-pri);background:var(--cnf-pri);color:#fff}',
    '#cnfirmed-panel .cnf-btn-pri:hover{background:var(--cnf-pri);filter:brightness(1.1)}',
    '#cnfirmed-panel .cnf-btn-sm{flex:none;min-height:30px;padding:0 10px;font-size:12.5px}',
    '#cnfirmed-panel .cnf-open{display:inline-flex;align-items:center;gap:4px;margin-left:auto;font-size:13px}',
    '#cnfirmed-panel .cnf-open svg{width:13px;height:13px}',

    // Where it looked: one row per search, with its state.
    '#cnfirmed-panel .cnf-src{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--cnf-line2)}',
    '#cnfirmed-panel .cnf-src-icon{flex:none;display:inline-flex;margin-top:2px;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-src-icon svg{display:block;width:16px;height:16px}',
    '#cnfirmed-panel .cnf-src[data-state="done"] .cnf-src-icon{color:var(--cnf-ok)}',
    '#cnfirmed-panel .cnf-src[data-state="running"] .cnf-src-icon{color:var(--cnf-link)}',
    '#cnfirmed-panel .cnf-src[data-state="error"] .cnf-src-icon,' +
      '#cnfirmed-panel .cnf-src[data-state="error"] .cnf-src-result{color:var(--cnf-err)}',
    '#cnfirmed-panel .cnf-src-main{flex:1;min-width:0}',
    '#cnfirmed-panel .cnf-src-name{display:block;font-size:13.5px}',
    '#cnfirmed-panel .cnf-src-name b{font-weight:600}',
    '#cnfirmed-panel .cnf-src-where{color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-src-result{display:block;margin-top:1px;font-size:12.5px;line-height:1.4;' +
      'color:var(--cnf-ink3);overflow-wrap:anywhere}',

    '#cnfirmed-panel .cnf-ov-title{font-size:16px;font-weight:600}',
    '#cnfirmed-panel .cnf-ov-summary,#cnfirmed-panel .cnf-box p{margin:2px 0 0;font-size:12.5px;line-height:1.45;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-ov-row{--cnf-v:var(--cnf-ink3);display:flex;align-items:flex-start;gap:10px;width:100%;' +
      'padding:12px 8px;border:0;border-top:1px solid var(--cnf-line2);background:transparent;text-align:left;cursor:pointer}',
    '#cnfirmed-panel .cnf-ov-row:hover,#cnfirmed-panel .cnf-ov-row[aria-current="true"]{background:var(--cnf-bg2)}',
    '#cnfirmed-panel .cnf-ov-row[data-kind="found"]{--cnf-v:var(--cnf-ok)}',
    '#cnfirmed-panel .cnf-ov-row[data-kind="partial"]{--cnf-v:var(--cnf-warn)}',
    '#cnfirmed-panel .cnf-ov-row[data-kind="leads"],#cnfirmed-panel .cnf-ov-row[data-kind="running"]{--cnf-v:var(--cnf-link)}',
    '#cnfirmed-panel .cnf-ov-row[data-kind="error"]{--cnf-v:var(--cnf-err)}',
    '#cnfirmed-panel .cnf-ov-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;' +
      'overflow:hidden;font-size:13.5px;line-height:1.45}',
    '#cnfirmed-panel .cnf-ov-status{display:block;margin-top:3px;font-size:12.5px;font-weight:600;color:var(--cnf-v)}',
    '#cnfirmed-panel .cnf-box{padding:14px;border:1px solid var(--cnf-line);border-radius:8px}',
    '#cnfirmed-panel .cnf-box p{margin-bottom:10px}',
    '#cnfirmed-panel .cnf-box-title{font-size:14px;font-weight:600}',

    '#cnfirmed-panel .cnf-field{margin:0;padding:0;border:0;min-width:0}',
    '#cnfirmed-panel .cnf-field-label{display:block;margin:0 0 8px;padding:0;font-size:14px;font-weight:600}',
    '#cnfirmed-panel .cnf-radio{display:flex;align-items:flex-start;gap:10px;margin-bottom:6px;padding:10px 12px;' +
      'border:1px solid var(--cnf-line);border-radius:8px;cursor:pointer}',
    '#cnfirmed-panel .cnf-radio[data-checked]{border-color:var(--cnf-link);background:var(--cnf-bg2)}',
    '#cnfirmed-panel .cnf-radio input{margin:3px 0 0}',
    '#cnfirmed-panel .cnf-radio-name{display:block;font-size:13.5px;font-weight:600}',
    '#cnfirmed-panel .cnf-radio-desc{display:block;font-size:12.5px;line-height:1.4;color:var(--cnf-ink3)}',
    '#cnfirmed-panel .cnf-keyrow{display:flex;gap:8px}',
    '#cnfirmed-panel .cnf-input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid var(--cnf-line3);' +
      'border-radius:6px;background:var(--cnf-bg);color:var(--cnf-ink);font:inherit;font-size:13.5px}',
    '#cnfirmed-panel .cnf-free{padding:12px 14px;border-radius:8px;background:var(--cnf-bg2)}',
    '#cnfirmed-panel .cnf-free b{display:block;font-size:13.5px}',
    '@media (max-width:720px){#cnfirmed-panel{width:100% !important}}',

    '.cnfirmed-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10002;' +
      'max-width:80vw;padding:8px 14px;border-radius:6px;background:var(--cnf-toast);color:var(--cnf-toastink);' +
      'font-size:0.9em;opacity:0;transition:opacity 0.2s}',
    '.cnfirmed-toast.cnfirmed-toast-visible{opacity:1}'
  ].join('\n'));

  // ---- State ------------------------------------------------------------

  var lang = mw.config.get('wgContentLanguage') || 'en';
  var pageTitle = mw.config.get('wgPageName');
  var revid = mw.config.get('wgCurRevisionId');
  var cacheKey = 'cnfirmed:' + lang + ':' + pageTitle + ':' + revid;
  var wikiCacheKey = 'cnfirmed:wiki:' + lang + ':' + pageTitle + ':' + revid;
  // ia2: books cached before a bundled item's book was told apart from the item.
  var archiveCacheKey = 'cnfirmed:ia2:' + lang + ':' + pageTitle + ':' + revid;

  var cnSups = [];        // rendered <sup> nodes, in document order
  var badges = [];        // matching <button class="cnfirmed-badge"> nodes
  var claimContexts = []; // { claim, context, section, links } per CN
  var state = {};         // { [index]: { status, result?, error?, provider? } }
  var wikiState = {};     // { [index]: { status, candidates?, warnings?, error? } }
  var archiveState = {};  // { [index]: { status, candidates?, funnel?, error? } }
  var booted = false;     // claims extracted and caches read; see bootstrap()
  // Claims picked from a selection come after the tagged ones: claim i is
  // cnSups[i] while i < cnSups.length, then pickedAnchors[i - cnSups.length]
  // (its badge). They last until the page is reloaded.
  var pickedAnchors = [];
  var pickedRanges = [];  // the text each covers, for the highlight

  // ---- Boot sequence ----------------------------------------------------

  $(function () {
    if (WG_ACTION === 'edit' || WG_ACTION === 'submit') {
      handlePendingEditorInsertion();
      return;
    }

    cnSups = Array.prototype.slice.call(
      document.querySelectorAll('sup.Template-Fact')
    );
    if (cnSups.length) insertBadges();

    // A page without tags gets its two links and nothing else, until one is
    // clicked: the script is meant to stay on, and most articles have none.
    mw.loader.using(['mediawiki.util'])
      .then(function () {
        if (cnSups.length) bootstrap();
        addEntryLink();
        addPickToolLink();
      })
      .catch(function (err) {
        console.error('[CNfirmed] failed to load:', err);
      });
  });

  function addPickToolLink() {
    if (!mw.util || typeof mw.util.addPortletLink !== 'function') return;
    if (!document.getElementById('mw-content-text')) return;
    var link = mw.util.addPortletLink('p-tb', '#', 'Find sources for a claim', 't-cnfirmed-pick',
      'Select text in the article and find sources for it (CNfirmed)');
    if (!link) return;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      bootUntagged();
      startPicking();
    });
  }

  // What a page without tags skipped at load, done when it is first asked for.
  function bootUntagged() {
    if (booted) return;
    insertBadges();
    bootstrap();
  }

  // Inline icons. Constants only: nothing from a page or a response is ever
  // put through innerHTML.
  var ICONS = {
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.4 3.4"/></svg>',
    supports: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.9 8.2 7 10.3 11.2 5.9" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--cnf-bg)"/></svg>',
    partial: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg>',
    lead: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    nothing: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M5.3 8h5.4"/></svg>',
    flag: '<svg viewBox="0 0 16 16"><path d="M8 1.5 15.2 14.2H0.8z" fill="currentColor"/><path d="M8 6.2v3.7M8 11.9v.1" fill="none" stroke-width="1.7" stroke-linecap="round" style="stroke:var(--cnf-bg)"/></svg>',
    info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v3.9M8 4.9v.2"/></svg>',
    spin: '<svg class="cnfirmed-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6" opacity="0.25"/><path d="M14 8a6 6 0 0 0-6-6"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.4 6.5 11.6 12.8 4.6"/></svg>',
    prev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8 10 12.5"/></svg>',
    next: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    gear: '<svg class="cnf-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h8.6M17.4 6H20M4 12h2.6M11.4 12H20M4 18h10.6M19.4 18H20"/><circle cx="15" cy="6" r="2.4"/><circle cx="9" cy="12" r="2.4"/><circle cx="17" cy="18" r="2.4"/></svg>',
    external: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>'
  };

  function icon(name) {
    var holder = document.createElement('span');
    holder.innerHTML = ICONS[name] || ICONS.lead;
    var svg = holder.firstChild;
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
  }

  function makeBadge(i) {
    var badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'cnfirmed-badge';
    badge.setAttribute('data-cn-index', String(i));
    badge.setAttribute('aria-label', 'Find sources for this claim (CNfirmed)');
    badge.title = 'Find sources with CNfirmed';
    badge.appendChild(icon('search'));
    return badge;
  }

  function insertBadges() {
    cnSups.forEach(function (sup, i) {
      var badge = makeBadge(i);
      sup.parentNode.insertBefore(badge, sup.nextSibling);
      badges.push(badge);
    });

    document.addEventListener('click', onBadgeActivate);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (picking) cancelPicking();
      else if (panelVisible()) closePanel();
    });
  }

  function claimCount() { return cnSups.length + pickedAnchors.length; }
  function isPicked(i) { return i >= cnSups.length; }
  function anchorOf(i) { return i < cnSups.length ? cnSups[i] : pickedAnchors[i - cnSups.length]; }

  function onBadgeActivate(e) {
    var t = e.target && e.target.closest ? e.target.closest('.cnfirmed-badge') : null;
    if (!t) return;
    var idx = parseInt(t.getAttribute('data-cn-index'), 10);
    if (isNaN(idx)) return;
    e.preventDefault();
    openClaim(idx);
  }

  function bootstrap() {
    hydrateFromCache();
    hydrateWikiCache();
    hydrateArchiveCache();
    extractAllClaims();
    booted = true;
    for (var i = 0; i < cnSups.length; i++) renderBadge(i);
  }

  // Results saved for claims picked on an earlier visit: those claims are
  // gone, and a new pick would take their index.
  function dropPickedResults(saved) {
    Object.keys(saved).forEach(function (k) {
      if (!(Number(k) < cnSups.length)) delete saved[k];
    });
    return saved;
  }

  // One link to open the panel on the list of claims, where Source Verifier
  // puts its own: beside the page tabs, or in the tools menu on other skins.
  // It is on every article, so the panel can always be found: on a page
  // without tags it goes straight to picking text, there being no list.
  function addEntryLink() {
    if (!mw.util || typeof mw.util.addPortletLink !== 'function') return;
    if (!document.getElementById('mw-content-text')) return;
    var portlet = {
      'vector-2022': 'p-associated-pages', vector: 'p-cactions',
      monobook: 'p-cactions', timeless: 'p-associated-pages'
    }[mw.config.get('skin')] || 'p-tb';
    var label = cnSups.length ? 'CNfirmed (' + cnSups.length + ')' : 'CNfirmed';
    var tip = cnSups.length
      ? 'Find sources for the ' + cnSups.length + ' citation-needed tag(s) on this page'
      : 'No citation-needed tags here: select text in the article and find sources for it';
    var link = mw.util.addPortletLink(portlet, '#', label, 'ca-cnfirmed', tip) ||
      mw.util.addPortletLink('p-tb', '#', label, 'ca-cnfirmed', tip);
    if (!link) {
      console.warn('[CNfirmed] nowhere to put the panel link; the badges and the Tools item still open it');
      return;
    }
    link.addEventListener('click', function (e) {
      e.preventDefault();
      bootUntagged();
      if (!claimCount() && !panelVisible()) startPicking();
      else togglePanel();
    });
  }

  function hydrateFromCache() {
    try {
      var raw = localStorage.getItem(cacheKey);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') state = dropPickedResults(parsed);
    } catch (e) { /* ignore */ }
    // A search still running when another claim's result was saved is not
    // running any more.
    Object.keys(state).forEach(function (k) {
      if (state[k] && state[k].status === 'running') delete state[k];
    });
  }

  function persist() {
    try { localStorage.setItem(cacheKey, JSON.stringify(state)); } catch (e) {}
  }

  // ---- Claim extraction from rendered DOM -------------------------------

  function extractAllClaims() {
    claimContexts = cnSups.map(function (sup) {
      try { return extractClaimContext(sup); }
      catch (e) {
        console.warn('[CNfirmed] claim extraction failed:', e);
        return { claim: '', context: '', section: null };
      }
    });
  }

  function extractClaimContext(supEl) {
    var block = supEl.closest('p, li, dd, dt, td, th') || supEl.parentElement;
    if (!block) return { claim: '', context: '', section: null, links: [] };

    // Clone the block, replace our sup with a unique marker so we can locate
    // its position in the rendered text after stripping noise.
    var clone = block.cloneNode(true);
    var origSups = block.querySelectorAll('sup.Template-Fact');
    var cloneSups = clone.querySelectorAll('sup.Template-Fact');
    var idx = Array.prototype.indexOf.call(origSups, supEl);
    var marker = 'CNMARK';
    if (cloneSups[idx]) {
      cloneSups[idx].parentNode.replaceChild(document.createTextNode(marker), cloneSups[idx]);
    }
    // Strip footnote refs, edit links, our own badges, all other sups.
    Array.prototype.forEach.call(
      clone.querySelectorAll('sup, .reference, .mw-editsection, .cnfirmed-badge'),
      function (n) { n.parentNode && n.parentNode.removeChild(n); }
    );
    var text = (clone.textContent || '').replace(/\s+/g, ' ').trim();

    var section = nearestSection(block);
    // Wikilinks in the paragraph are pre-resolved entities: their titles can be
    // translated through interlanguage links, which is what lets a claim be
    // located on a wiki that does not share our script.
    var links = wikilinkTargets(block);
    var pos = text.indexOf(marker);
    if (pos < 0) {
      return { claim: text, context: text, section: section, links: links };
    }
    var before = text.slice(0, pos).replace(/\s+$/, '');
    var after = text.slice(pos + marker.length).replace(/^\s+/, '');
    var claim = lastSentenceOf(before) || before;
    var context = (before + ' ' + after).replace(/\s+/g, ' ').trim();
    return { claim: claim, context: context, section: section, links: links };
  }

  // Article titles linked from a rendered block, read straight off the DOM so
  // this works whether or not the wikitext offsets line up.
  function wikilinkTargets(block) {
    var out = [];
    var anchors = block.querySelectorAll('a[href]');
    var prefix = (mw.config.get('wgArticlePath') || '/wiki/$1').replace('$1', '');
    Array.prototype.forEach.call(anchors, function (a) {
      var href = a.getAttribute('href') || '';
      if (href.indexOf(prefix) !== 0) return;
      if (a.classList.contains('new') || a.classList.contains('external')) return;
      var title;
      try { title = decodeURIComponent(href.slice(prefix.length).split('#')[0]); }
      catch (e) { return; }
      title = title.replace(/_/g, ' ').trim();
      if (!title || /^(?:File|Image|Category|Help|Special|Template|Wikipedia):/i.test(title)) return;
      if (out.indexOf(title) === -1) out.push(title);
    });
    return out;
  }

  function lastSentenceOf(text) {
    if (!text) return '';
    var lastBoundary = -1;
    for (var i = 0; i < text.length - 1; i++) {
      var ch = text[i];
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      var rest = text.slice(i + 1);
      var ws = rest.match(/^\s+/);
      if (!ws) continue;
      var afterWs = rest.slice(ws[0].length);
      // Sentence boundary if next chunk starts with capital letter or
      // open paren/quote — guards against abbreviations like "U.S." or "Dr.".
      if (afterWs && /^[A-Z(“"]/.test(afterWs)) {
        lastBoundary = i;
      }
    }
    if (lastBoundary === -1) return text.trim();
    return text.slice(lastBoundary + 1).trim();
  }

  function nearestSection(start) {
    var node = start;
    while (node && node !== document.body) {
      var sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return sectionText(sib);
        var nested = sib.querySelector && sib.querySelector('h1, h2, h3, h4, h5, h6');
        if (nested) return sectionText(nested);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  function sectionText(h) {
    var c = h.cloneNode(true);
    Array.prototype.forEach.call(
      c.querySelectorAll('.mw-editsection, sup'),
      function (n) { n.parentNode && n.parentNode.removeChild(n); }
    );
    return (c.textContent || '').trim() || null;
  }

  // ---- A claim picked from a selection -----------------------------------
  // Started from the Tools item, the list of claims or, on a page without
  // tags, the CNfirmed link; never by selecting alone: people select text
  // for many reasons. While it is on, the panel shows what is selected, and
  // Find sources turns it into a claim. The last usable selection is kept,
  // since a tap on the panel can clear it on iOS.

  var PICK_BLOCKS = 'p, li, dd, dt';
  var PICK_EXCLUDED = 'table, .infobox, .navbox, .vertical-navbox, .sidebar, .metadata, .ambox, ' +
    '.hatnote, .reflist, .references, .mw-references-wrap, figure, .thumb, .gallery, .toc, ' +
    '.mw-heading, h1, h2, h3, h4, h5, h6, #cnfirmed-panel';
  var PICK_MIN_WORDS = 3;
  var PICK_CLOSERS = /[.,;:!?)"”’'»\]]/;
  var picking = null; // while on: { pick, reason, timer }

  function startPicking() {
    if (!picking) {
      picking = { pick: null, reason: null, timer: null };
      document.addEventListener('selectionchange', onPickSelection);
      readPickSelection();
    }
    panelView = 'pick';
    showPanel();
    setActive(null);
    drawPanel();
  }

  function stopPicking() {
    if (!picking) return;
    clearTimeout(picking.timer);
    document.removeEventListener('selectionchange', onPickSelection);
    picking = null;
    if (panelView === 'pick') panelView = 'overview';
  }

  function cancelPicking() {
    stopPicking();
    if (claimCount()) openOverview();
    else closePanel();
  }

  function onPickSelection() {
    clearTimeout(picking.timer);
    picking.timer = setTimeout(function () {
      if (picking && readPickSelection() && panelView === 'pick') drawPanel();
    }, 150);
  }

  // A selection elsewhere, or none, leaves what was there.
  function readPickSelection() {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    var found = pickFromRange(sel.getRangeAt(0));
    if (!found) return false;
    picking.pick = found.reason ? null : found;
    picking.reason = found.reason || null;
    return true;
  }

  function pickBlockOf(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    var block = el && el.closest(PICK_BLOCKS);
    return block && !block.closest(PICK_EXCLUDED) ? block : null;
  }

  // The text a reader sees: footnote markers, edit links and badges left out.
  function readableText(node) {
    var copy = node.cloneNode(true);
    Array.prototype.forEach.call(
      copy.querySelectorAll('sup, .reference, .mw-editsection, .cnfirmed-badge, style'),
      function (n) { n.parentNode && n.parentNode.removeChild(n); }
    );
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function rangeText(range) {
    var holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    return readableText(holder);
  }

  // The selection grown to whole words, without the space after it.
  function wordRange(range) {
    var r = range.cloneRange();
    var isWord = function (ch) { return /[\p{L}\p{N}]/u.test(ch); };
    if (r.startContainer.nodeType === 3) {
      var a = r.startOffset;
      var d = r.startContainer.data;
      while (a > 0 && isWord(d.charAt(a - 1))) a--;
      r.setStart(r.startContainer, a);
    }
    if (r.endContainer.nodeType === 3) {
      var b = r.endOffset;
      var e = r.endContainer.data;
      while (b < e.length && isWord(e.charAt(b))) b++;
      while (b > 0 && /\s/.test(e.charAt(b - 1))) b--;
      r.setEnd(r.endContainer, b);
    }
    return r;
  }

  function nextOutside(node, block) {
    while (node && node !== block) {
      if (node.nextSibling) return node.nextSibling;
      node = node.parentNode;
    }
    return null;
  }

  // Where the badge goes on the page, as the <ref> does in the wikitext:
  // after the selection's closing punctuation and the footnotes already
  // there. A [citation needed] there means the text is a tagged claim.
  function pagePointAfter(range, block) {
    var at = document.createRange();
    var cites = [];
    var node = range.endContainer;
    var offset = range.endOffset;
    if (node.nodeType !== 3) {
      node = node.childNodes[offset] || nextOutside(node, block);
      offset = 0;
    }
    var last = range.endContainer;
    while (node) {
      if (node.nodeType === 3) {
        var o = offset;
        while (o < node.data.length && PICK_CLOSERS.test(node.data.charAt(o))) o++;
        if (o < node.data.length) {
          at.setStart(node, o);
          return { at: at, cites: cites, tag: -1 };
        }
      } else if (node.nodeType === 1 && node.matches('sup.Template-Fact')) {
        return { at: at, cites: cites, tag: cnSups.indexOf(node) };
      } else if (node.nodeType === 1 && node.matches('sup.reference')) {
        cites.push(node.textContent.trim());
      } else if (node.nodeType === 1 && !node.matches('.cnfirmed-badge')) {
        at.setStartBefore(node);
        return { at: at, cites: cites, tag: -1 };
      }
      last = node;
      node = nextOutside(node, block);
      offset = 0;
    }
    if (last === block || !block.contains(last)) {
      at.setStart(block, block.childNodes.length);
    } else {
      while (last.parentNode !== block) last = last.parentNode;
      at.setStartAfter(last);
    }
    return { at: at, cites: cites, tag: -1 };
  }

  function lastProseText(block) {
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var found = null;
    var node;
    while ((node = walker.nextNode())) {
      if (/\S/.test(node.data) && !node.parentElement.closest('sup, .cnfirmed-badge')) found = node;
    }
    return found;
  }

  // What a selection would make: { reason } when it cannot be used, or the
  // claim. Null for a selection outside the article, which is ignored.
  function pickFromRange(range) {
    var root = document.getElementById('mw-content-text');
    if (!root || !root.contains(range.commonAncestorContainer)) return null;
    var block = pickBlockOf(range.startContainer);
    var endBlock = pickBlockOf(range.endContainer);
    // A triple-click selects a paragraph up to the start of the next one.
    if (block && endBlock !== block && range.endOffset === 0) {
      var lastText = lastProseText(block);
      if (lastText) {
        range = range.cloneRange();
        range.setEnd(lastText, lastText.data.length);
        endBlock = block;
      }
    }
    if (!block || !endBlock) return { reason: 'Select text in the article’s paragraphs or lists.' };
    if (block !== endBlock) return { reason: 'Select text within one paragraph.' };
    var r = wordRange(range);
    var claim = rangeText(r);
    if (wordsWithOffsets(claim).length < PICK_MIN_WORDS) return { reason: 'Select at least three words.' };
    var lead = document.createRange();
    lead.setStart(block, 0);
    lead.setEnd(r.startContainer, r.startOffset);
    return {
      range: r,
      block: block,
      claim: claim,
      before: rangeText(lead).slice(-200),
      tag: pagePointAfter(r, block).tag
    };
  }

  function addPickedClaim(p) {
    var i = claimCount();
    var point = pagePointAfter(p.range, p.block);
    var badge = makeBadge(i);
    badge.classList.add('cnfirmed-badge-picked');
    point.at.insertNode(badge);
    pickedAnchors.push(badge);
    pickedRanges.push(p.range);
    badges[i] = badge;
    claimContexts[i] = {
      claim: p.claim,
      context: readableText(p.block),
      section: nearestSection(p.block),
      links: wikilinkTargets(p.block),
      picked: true,
      before: p.before,
      cites: point.cites
    };
    renderBadge(i);
    return i;
  }

  function usePick() {
    var p = picking && picking.pick;
    if (!p) return;
    stopPicking();
    try { window.getSelection().removeAllRanges(); } catch (e) { /* not needed */ }
    if (p.tag >= 0) openClaim(p.tag, true);
    else openClaim(addPickedClaim(p));
  }

  // ---- Finding sources --------------------------------------------------

  // Free first, paid second. Opening a claim runs both free searches at once:
  // the citations Wikipedia already holds, and Internet Archive books (whose
  // passages a model then checks). The paid web search only starts by
  // itself when both came back empty and a key is set; otherwise it waits for
  // a click.
  var autoWebConsidered = {};

  // Opening a claim runs what has not run yet; a search that failed waits
  // for its Retry (`retry`), so going back to a claim does not start it again.
  function startClaim(i, retry) {
    var wiki = runWiki(i, retry);
    var books = runBooks(i, retry);
    renderPanel(i);
    return Promise.all([wiki, books]).then(function () {
      renderPanel(i);
      maybeAutoWeb(i);
    });
  }

  // A claim with no word to search on still has the librarian, which reads
  // its paragraph.
  function archiveNothingToSearch(i) {
    var models = libModels();
    return archiveQueriesFor(i).length === 0 && !(IA_LIBRARIAN && (models.planner || models.books));
  }

  function runBooks(i, retry) {
    if (archiveNothingToSearch(i)) return Promise.resolve(null);
    return runArchiveStage(i, retry).then(function (a) {
      // Leads cached before their check finished are checked now.
      if (a && a.status === 'done' && (a.candidates || []).length && !a.check) {
        return checkArchiveStage(i);
      }
      return a;
    });
  }

  function maybeAutoWeb(i) {
    if (autoWebConsidered[i]) return;
    autoWebConsidered[i] = true;
    var s = state[i];
    if (s && s.status !== 'idle') return;
    if (collectItems(i).items.length > 0) return;
    // Free searches are shared, so they wait for a click.
    if (!getKey(getProvider())) return;
    runOne(i);
  }

  function runOne(i) {
    var providerId = getProvider();
    var key = getKey(providerId);
    if (!canSearchWeb(providerId)) {
      toast(onFreeSearches(providerId) ? NO_FREE_SEARCHES : 'Add your ' + keyLabel(providerId) + ' first');
      openSettings();
      return;
    }

    var ctx = claimContexts[i];
    if (!ctx || !ctx.claim) {
      var msg = 'Could not extract a claim from the surrounding text.';
      state[i] = { status: 'error', error: msg, provider: providerId };
      persist(); renderPanel(i);
      return;
    }

    state[i] = { status: 'running', provider: providerId };
    renderPanel(i);

    PROVIDERS[providerId].run(ctx, key)
      .then(function (suggestions) {
        var ranked = rankSuggestions(suggestions);
        var result = { claim: ctx, suggestions: ranked, provider: providerId };
        state[i] = { status: 'done', result: result, provider: providerId };
        persist(); renderPanel(i);
      })
      .catch(function (err) {
        if (err && err.noFreeSearches) {
          // Not this claim's failure: it is left unsearched, and the panel
          // says why and asks for a key.
          delete state[i];
          toast(NO_FREE_SEARCHES);
          persist(); renderPanel(i);
          return;
        }
        var msg = (err && err.message) ? err.message : String(err);
        state[i] = { status: 'error', error: msg, provider: providerId };
        persist(); renderPanel(i);
      });
  }

  // "Find sources for all": both free searches for every claim, one claim at
  // a time — the Wikipedia corpus is fetched once, and the Archive's models
  // share the Worker's 20 requests a minute (the Verify API's 30 a minute,
  // shared with everyone, when it is the fallback).
  var batch = null; // { done, total, promise } while it runs

  function findAllFree() {
    if (batch) return batch.promise;
    var indexes = [];
    for (var i = 0; i < claimCount(); i++) indexes.push(i);
    batch = { done: 0, total: indexes.length };
    renderPanel();
    batch.promise = indexes.reduce(function (chain, index) {
      return chain.then(function () {
        return runWiki(index, true)
          .then(function () { return runBooks(index, true); })
          .catch(function (err) { console.error('[CNfirmed] search failed for claim', index, ':', err); })
          .then(function () { batch.done++; renderPanel(index); });
      });
    }, Promise.resolve()).then(function () {
      batch = null;
      renderPanel();
      toast('CNfirmed: free search finished');
    });
    return batch.promise;
  }

  // Claims both free searches came back empty for, not yet searched on the web.
  function claimsForWeb() {
    var out = [];
    for (var i = 0; i < claimCount(); i++) {
      var ctx = claimContexts[i];
      var s = state[i];
      if (!ctx || !ctx.claim || (s && s.status !== 'idle')) continue;
      if (claimStatus(i).kind === 'nothing') out.push(i);
    }
    return out;
  }

  function searchWebForNothing() {
    var providerId = getProvider();
    if (!canSearchWeb(providerId)) {
      openSettings();
      return;
    }
    var queue = claimsForWeb();
    if (queue.length) runWebSearchQueue(queue, providerId);
  }

  function runWebSearchQueue(queue, providerId) {
    var concurrency = 2;
    var inFlight = 0;
    var idx = 0;
    return new Promise(function (resolve) {
      function next() {
        while (inFlight < concurrency && idx < queue.length) {
          var i = queue[idx++];
          inFlight++;
          state[i] = { status: 'running', provider: providerId };
          renderPanel(i);
          (function (k) {
            PROVIDERS[providerId].run(claimContexts[k], getKey(providerId))
              .then(function (suggestions) {
                var ranked = rankSuggestions(suggestions);
                state[k] = {
                  status: 'done',
                  result: { claim: claimContexts[k], suggestions: ranked, provider: providerId },
                  provider: providerId
                };
              })
              .catch(function (err) {
                if (err && err.noFreeSearches) {
                  delete state[k];
                  return;
                }
                state[k] = {
                  status: 'error',
                  error: (err && err.message) ? err.message : String(err),
                  provider: providerId
                };
              })
              .then(function () {
                inFlight--;
                persist(); renderPanel(k);
                // Free searches running out leaves the rest unsearched.
                if (!canSearchWeb(providerId)) idx = queue.length;
                if (idx >= queue.length && inFlight === 0) {
                  toast(canSearchWeb(providerId) ? 'CNfirmed: web search finished' : NO_FREE_SEARCHES);
                  renderPanel();
                  resolve();
                } else {
                  next();
                }
              });
          })(i);
        }
      }
      next();
    });
  }

  // ---- Suggestion ranking + filtering -----------------------------------

  function rankSuggestions(suggestions) {
    var filtered = suggestions.filter(function (s) {
      return s && s.source && s.source.url && !isUnreliableDomain(s.source.url);
    });
    function bucket(s) {
      var v = s.verdict.verdict;
      if (v === 'SUPPORTED') return s.verdict.reliability === 'low' ? 1 : 0;
      if (v === 'PARTIALLY SUPPORTED') return 2;
      return 3;
    }
    filtered.sort(function (a, b) {
      var ba = bucket(a), bb = bucket(b);
      if (ba !== bb) return ba - bb;
      return b.verdict.confidence - a.verdict.confidence;
    });
    return filtered;
  }

  // ---- Wiki-local source finding ----------------------------------------
  // Runs before (and often instead of) the paid web search: look for a citation
  // Wikimedia already holds — in this article's own reference list, or attached
  // to the same fact on another language edition.
  //
  // Free, unmetered, and needs no API key, so it runs on a plain badge click
  // even when no provider key is set. Mirrors
  // src/core/{wikitext,wikitextRefs,relevance,wikiSources}.ts. The leads from
  // other language editions are then checked by the open-weight judge model
  // (see "Checking other-language leads" below), which the core does not do.
  //
  // What it produces is evidence, not a verdict: "a human editor cited this
  // source for a sentence that looks like your claim". Read it before pasting.

  var WIKI_SISTER_LANGS = [
    'en', 'de', 'fr', 'es', 'it', 'ru', 'ja', 'nl', 'pl', 'pt',
    'sv', 'cs', 'uk', 'ca', 'fi', 'no', 'da', 'he', 'hu', 'tr',
    'ko', 'zh', 'ar', 'id', 'fa', 'vi'
  ];
  var WIKI_MAX_SISTERS = 4;
  // The subdomain, not wgContentLanguage: on simple.wikipedia the latter is
  // "en", which would send every local lookup to the wrong wiki.
  var WIKI_CODE = ((mw.config.get('wgServer') || '')
    .replace(/^https?:/, '').replace(/^\/\//, '').split('.')[0]) || lang;
  var WIKI_MIN_SCORE = 0.3;
  var WIKI_MIN_ANCHOR_SCORE = 0.5;
  var WIKI_MAX_CANDIDATES = 5;
  var REF_MARK = String.fromCharCode(1);

  // -- MediaWiki API --

  function mwApiGet(code, params) {
    var query = ['format=json', 'formatversion=2', 'origin=*'];
    Object.keys(params).forEach(function (k) {
      query.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    });
    var url = 'https://' + code + '.wikipedia.org/w/api.php?' + query.join('&');
    return fetch(url, {
      credentials: 'omit',
      headers: { accept: 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error(code + '.wikipedia.org: HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (data && data.error) {
        throw new Error(code + '.wikipedia.org: ' + data.error.info);
      }
      return data;
    });
  }

  function wikiFetchWikitext(code, title) {
    return mwApiGet(code, {
      action: 'query', prop: 'revisions', rvprop: 'content|ids',
      rvslots: 'main', titles: title, redirects: '1'
    }).then(function (data) {
      var page = data && data.query && data.query.pages && data.query.pages[0];
      if (!page || page.missing) throw new Error('no article "' + title + '" on ' + code);
      var rev = page.revisions && page.revisions[0];
      var content = rev && rev.slots && rev.slots.main && rev.slots.main.content;
      if (typeof content !== 'string') throw new Error('no wikitext for "' + title + '"');
      return { title: page.title, lang: code, wikitext: content };
    });
  }

  // Returns { requestedTitle: { langCode: foreignTitle } }, batched 50 at a time.
  function wikiFetchLangLinks(code, titles, langs) {
    var unique = [];
    var seen = Object.create(null);
    titles.forEach(function (t) {
      var key = String(t || '').trim();
      if (key && !seen[key]) { seen[key] = true; unique.push(key); }
    });
    var out = {};
    var batches = [];
    for (var i = 0; i < unique.length; i += 50) batches.push(unique.slice(i, i + 50));
    // lllang filters server-side but takes a single code, and asking for every
    // language at once can exceed lllimit and truncate without saying so. One
    // request per wanted language keeps each response bounded by the batch.
    var targets = (langs && langs.length) ? langs.slice() : [null];
    var jobs = [];
    targets.forEach(function (target) {
      batches.forEach(function (batch) { jobs.push({ target: target, batch: batch }); });
    });

    return jobs.reduce(function (chain, job) {
      var batch = job.batch;
      return chain.then(function () {
        var params = {
          action: 'query', prop: 'langlinks', lllimit: 'max',
          titles: batch.join('|'), redirects: '1'
        };
        if (job.target) params.lllang = job.target;
        return mwApiGet(code, params).then(function (data) {
          var q = (data && data.query) || {};
          // Fold normalisation and redirects back so callers can look up the
          // title they asked for, not the one MediaWiki resolved it to.
          var alias = {};
          (q.normalized || []).concat(q.redirects || []).forEach(function (step) {
            alias[step.from] = step.to;
          });
          var byTitle = {};
          (q.pages || []).forEach(function (page) {
            var links = {};
            (page.langlinks || []).forEach(function (l) {
              if (!langs || langs.indexOf(l.lang) !== -1) links[l.lang] = l.title;
            });
            byTitle[page.title] = links;
          });
          batch.forEach(function (requested) {
            var current = requested;
            for (var hop = 0; hop < 4 && alias[current]; hop++) current = alias[current];
            var links = byTitle[current];
            if (!links || !Object.keys(links).length) return;
            if (!out[requested]) out[requested] = {};
            Object.keys(links).forEach(function (k) { out[requested][k] = links[k]; });
          });
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  // -- Wikitext to plain prose --

  var INLINE_TEMPLATES = {
    convert: [0, 1], cvt: [0, 1], val: [0], formatnum: [0],
    nowrap: 'all', nobr: 'all', lang: [1], langx: [1],
    transliteration: [1], transl: [1], circa: 'all', c: 'all',
    'as of': [0], asof: [0], 'start date': 'all', 'end date': 'all',
    'birth date': 'all', 'death date': 'all', sic: [0]
  };

  function splitTemplateArgs(body) {
    var parts = [];
    var depth = 0;
    var start = 0;
    for (var i = 0; i < body.length; i++) {
      var two = body.charAt(i) + body.charAt(i + 1);
      if (two === '{{' || two === '[[') { depth++; i++; }
      else if (two === '}}' || two === ']]') { depth--; i++; }
      else if (body.charAt(i) === '|' && depth === 0) {
        parts.push(body.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(body.slice(start));
    return parts;
  }

  function parseTemplateBody(body) {
    var args = splitTemplateArgs(body);
    var name = (args.shift() || '').replace(/\s+/g, ' ').trim().toLowerCase();
    var positional = [];
    var named = {};
    args.forEach(function (arg) {
      var eq = arg.indexOf('=');
      if (eq > 0 && !/[[{]/.test(arg.slice(0, eq))) {
        named[arg.slice(0, eq).trim().toLowerCase().replace(/[_\s]+/g, '-')] = arg.slice(eq + 1).trim();
      } else {
        positional.push(arg.trim());
      }
    });
    return { name: name, positional: positional, named: named };
  }

  function stripTemplates(text) {
    var out = '';
    var i = 0;
    while (i < text.length) {
      if (text.charAt(i) === '{' && text.charAt(i + 1) === '{') {
        var end = findTemplateEnd(text, i);
        if (end < 0) end = text.length;
        var parsed = parseTemplateBody(text.slice(i + 2, Math.max(i + 2, end - 2)));
        var rule = INLINE_TEMPLATES[parsed.name];
        if (rule) {
          var kept = rule === 'all'
            ? parsed.positional
            : rule.map(function (n) { return parsed.positional[n]; })
                  .filter(function (v) { return v !== undefined; });
          out += ' ' + kept.map(stripWikitext).join(' ') + ' ';
        } else {
          out += ' ';
        }
        i = end;
        continue;
      }
      out += text.charAt(i);
      i++;
    }
    return out;
  }

  function stripWikitext(text) {
    var s = String(text);
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<ref[^>]*\/\s*>/gi, ' ');
    s = s.replace(/<ref[\s\S]*?<\/ref\s*>/gi, ' ');
    s = s.replace(/<references[\s\S]*?<\/references\s*>/gi, ' ');
    s = s.replace(/<\/?(?:references|gallery|math|score|syntaxhighlight|nowiki|poem|small|sub|sup|br|div|span|blockquote|code|pre)[^>]*>/gi, ' ');
    s = s.replace(/^\s*\{\|[\s\S]*?^\s*\|\}/gm, ' ');
    s = stripTemplates(s);
    s = s.replace(/\[\[\s*(?:File|Image|Media|Category)\s*:[\s\S]*?\]\]/gi, ' ');
    s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
    s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
    s = s.replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, '$1');
    s = s.replace(/\[(?:https?:)?\/\/\S+\]/g, ' ');
    s = s.replace(/'{2,5}/g, '');
    s = s.replace(/^[*#:;]+\s*/gm, '');
    s = s.replace(/^=+\s*(.*?)\s*=+\s*$/gm, '$1.');
    s = s.replace(/&nbsp;|&#160;/gi, ' ');
    s = s.replace(/&amp;/gi, '&');
    return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/^\s+|\s+$/g, '');
  }

  var HARD_TERMINATORS = '。！？؟۔।॥';
  var ABBREVIATIONS = {};
  ('mr mrs ms dr prof st jr sr vs etc ca approx no nos fig figs vol vols ' +
   'pp ed eds inc ltd co corp cf al dept univ mt est ave rd').split(' ')
    .forEach(function (w) { ABBREVIATIONS[w] = true; });

  function endsAbbreviation(text, dot) {
    var i = dot - 1;
    while (i >= 0 && /[\p{L}\p{N}]/u.test(text.charAt(i))) i--;
    var word = text.slice(i + 1, dot);
    if (!word.length) return false;
    if (word.length === 1 && /\p{Lu}/u.test(word)) return true;
    if (text.charAt(i) === '.') return true;
    return !!ABBREVIATIONS[word.toLowerCase()];
  }

  function splitSentences(text) {
    var out = [];
    var start = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (HARD_TERMINATORS.indexOf(ch) !== -1) {
        out.push(text.slice(start, i + 1).trim());
        start = i + 1;
        continue;
      }
      if (ch === '\n') {
        out.push(text.slice(start, i).trim());
        start = i + 1;
        continue;
      }
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      if (ch === '.' && endsAbbreviation(text, i)) continue;
      var j = i;
      while (j + 1 < text.length && /[.!?]/.test(text.charAt(j + 1))) j++;
      var rest = text.slice(j + 1);
      var ws = rest.match(/^[ \n\t]+/);
      if (!ws) continue;
      var after = rest.slice(ws[0].length);
      if (!after || /^[A-ZÀ-ÞА-ЯΑ-Ω(“"'\d[]/.test(after)) {
        out.push(text.slice(start, j + 1).trim());
        start = j + 1;
        i = j;
      }
    }
    var tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out.filter(function (s) { return s.length > 0; });
  }

  function sectionRangesOf(wikitext) {
    var re = /^(={2,6})\s*([^=\n][^\n]*?)\s*\1\s*$/gm;
    var heads = [];
    var m;
    while ((m = re.exec(wikitext))) {
      heads.push({ heading: m[2].trim(), level: m[1].length, start: m.index + m[0].length + 1 });
    }
    return heads.map(function (h, i) {
      var end = wikitext.length;
      for (var j = i + 1; j < heads.length; j++) {
        if (heads[j].level <= h.level) {
          end = wikitext.lastIndexOf('\n', heads[j].start - 2);
          if (end < h.start) end = h.start;
          break;
        }
      }
      return { heading: h.heading, level: h.level, start: h.start, end: end };
    });
  }

  function paragraphRangesOf(wikitext) {
    var out = [];
    var start = 0;
    for (;;) {
      var idx = wikitext.indexOf('\n\n', start);
      var end = idx === -1 ? wikitext.length : idx;
      if (end > start) out.push({ start: start, end: end });
      if (idx === -1) break;
      start = idx + 2;
    }
    return out;
  }

  function paragraphRangeAt(wikitext, offset) {
    var before = wikitext.lastIndexOf('\n\n', offset);
    var after = wikitext.indexOf('\n\n', offset);
    return {
      start: before === -1 ? 0 : before + 2,
      end: after === -1 ? wikitext.length : after
    };
  }

  // The span of wikitext holding the sentence a {{citation needed}} tag is on,
  // with the refs and tags attached to it. Mirrors taggedSentenceRange in
  // src/core/wikitext.ts: a reference inside it is one an editor already saw
  // and judged not enough, so it is never offered back for the claim.
  var MASKED = String.fromCharCode(0);

  function maskNonProse(text) {
    var out = text.split('');
    function blank(from, to) {
      for (var k = from; k < to && k < out.length; k++) out[k] = MASKED;
    }
    var m;
    var comment = /<!--[\s\S]*?-->/g;
    while ((m = comment.exec(text))) blank(m.index, m.index + m[0].length);
    var ref = /<ref\b[^>]*\/>|<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi;
    while ((m = ref.exec(text))) blank(m.index, m.index + m[0].length);
    for (var i = 0; i < text.length - 1; i++) {
      if (text.charAt(i) === '{' && text.charAt(i + 1) === '{') {
        var end = findTemplateEnd(text, i);
        if (end < 0) end = text.length;
        blank(i, end);
        i = end - 1;
      }
    }
    var file = /\[\[(?:File|Image):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]/gi;
    while ((m = file.exec(text))) blank(m.index, m.index + m[0].length);
    return out.join('');
  }

  function endsSentenceAt(masked, i) {
    var ch = masked.charAt(i);
    if (HARD_TERMINATORS.indexOf(ch) !== -1) return true;
    if (ch !== '.' && ch !== '!' && ch !== '?') return false;
    if (ch === '.' && /\d/.test(masked.charAt(i - 1)) && /\d/.test(masked.charAt(i + 1))) return false;
    if (ch === '.' && endsAbbreviation(masked, i)) return false;
    var j = i + 1;
    var spaced = false;
    var cited = false;
    while (j < masked.length && /[.!?"”’')\]\u0000\s]/.test(masked.charAt(j))) {
      if (/\s/.test(masked.charAt(j))) spaced = true;
      if (masked.charAt(j) === MASKED) cited = true;
      j++;
    }
    if (j >= masked.length) return true;
    if (cited && spaced) return true;
    return spaced && /[A-ZÀ-ÞА-ЯΑ-Ω(“"'\d[*]/.test(masked.charAt(j));
  }

  function taggedSentenceRange(wikitext, tagStart, tagEnd) {
    var para = paragraphRangeAt(wikitext, tagStart);
    var masked = maskNonProse(wikitext.slice(para.start, para.end));
    var ts = tagStart - para.start;
    var te = tagEnd - para.start;
    var k = ts - 1;
    while (k >= 0 && (masked.charAt(k) === MASKED || /\s/.test(masked.charAt(k)))) k--;
    var end = masked.length;
    if (k >= 0 && (/[.!?]/.test(masked.charAt(k)) || HARD_TERMINATORS.indexOf(masked.charAt(k)) !== -1)) {
      end = k;
    } else {
      for (var i = te; i < masked.length; i++) {
        if (endsSentenceAt(masked, i)) { end = i; break; }
      }
    }
    var tail = Math.min(end + 1, masked.length);
    while (tail < masked.length && /[\u0000\s"”’')\]]/.test(masked.charAt(tail))) tail++;
    var start = 0;
    for (var b = Math.min(k, end) - 1; b >= 0; b--) {
      if (endsSentenceAt(masked, b)) { start = b + 1; break; }
    }
    while (start < ts && /[\u0000\s"”’')\]]/.test(masked.charAt(start))) start++;
    return { start: para.start + start, end: para.start + tail };
  }

  // Without the page-to-wikitext mapping the tag's position is unknown; a
  // reference whose sentence restates the claim is then taken to be on it.
  function restatesClaim(sentence, claim) {
    var a = tokenSetOf(sentence);
    var b = Object.keys(tokenSetOf(claim));
    var small = Math.min(Object.keys(a).length, b.length);
    if (small < 4) return false;
    var shared = b.filter(function (t) { return a[t]; }).length;
    return shared / small >= 0.9;
  }

  // -- Text someone selected on the page, found again in the wikitext --
  // A claim picked from a selection has no tag to count, so its place in the
  // wikitext is found by its words: the page's text and the wikitext's prose
  // compared word by word, lower-cased, everything that does not render as
  // prose blanked (refs, templates, comments, link targets, tags). Template
  // output (a {{convert}}) is not in the wikitext, so a claim with some in it
  // is matched by its last words alone; where even those are not found, or
  // are found twice, the caller falls back.

  var WORD = /[\p{L}\p{N}]+/gu;
  var PICK_TAIL_WORDS = 6;
  var PICK_BEFORE_WORDS = 6;

  function wordsWithOffsets(text) {
    var out = [];
    var m;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(text))) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
    return out;
  }

  function proseWordsOf(wikitext) {
    var blank = function (m) { return new Array(m.length + 1).join(MASKED); };
    var masked = maskNonProse(wikitext)
      .replace(/\[\[\s*(?:Category|File|Image|Media)\s*:[^\]]*\]\]/gi, blank)
      .replace(/\[\[[^\[\]|\n]*\|/g, blank)
      .replace(/\[(?:https?:)?\/\/[^\s\]]+/gi, blank)
      .replace(/<\/?[a-zA-Z][^>]*>/g, blank)
      .replace(/&[a-zA-Z0-9#]+;/g, blank);
    return wordsWithOffsets(masked);
  }

  function wordRunsAt(prose, words) {
    var out = [];
    if (!words.length) return out;
    for (var i = 0; i + words.length <= prose.length; i++) {
      var k = 0;
      while (k < words.length && prose[i + k].w === words[k]) k++;
      if (k === words.length) out.push(i);
    }
    return out;
  }

  // { start, end } of the claim in the wikitext (start null when only its
  // last words were found), or null. `before` is the page text just ahead of
  // the claim in its paragraph, to tell apart two places with the same words.
  function locateClaimText(wikitext, claim, before) {
    var prose = proseWordsOf(wikitext);
    var words = wordsWithOffsets(claim).map(function (t) { return t.w; });
    if (!words.length) return null;
    var lead = wordsWithOffsets(before || '').map(function (t) { return t.w; }).slice(-PICK_BEFORE_WORDS);
    function preceded(at) {
      if (!lead.length) return false;
      for (var k = 1; k <= lead.length; k++) {
        var p = prose[at - k];
        if (!p) return k > 1;
        if (p.w !== lead[lead.length - k]) return false;
      }
      return true;
    }
    function pick(hits) {
      if (hits.length === 1) return hits[0];
      var kept = hits.filter(preceded);
      return kept.length === 1 ? kept[0] : -1;
    }
    var at = pick(wordRunsAt(prose, words));
    if (at >= 0) return { start: prose[at].start, end: prose[at + words.length - 1].end };
    var tail = words.slice(-PICK_TAIL_WORDS);
    var hits = wordRunsAt(prose, tail);
    at = hits.length === 1 ? hits[0] : -1;
    if (at < 0) return null;
    return { start: null, end: prose[at + tail.length - 1].end };
  }

  // Footnote templates, which sit after the text they cite as a <ref> does.
  var FOOTNOTE_TEMPLATES = { sfn: true, sfnp: true, sfnm: true, efn: true, rp: true, r: true, refn: true };

  // Where a <ref> for text ending at `end` goes: past the punctuation and
  // closing markup right after it, and past the footnotes already there.
  // Never past a space, so a claim ending mid-sentence is cited where it ends.
  function citationPointAfter(text, end) {
    var i = end;
    for (;;) {
      var rest = text.slice(i, i + 400);
      var m = rest.match(/^(?:[.,;:!?)"”’']|\]\]|<\/[a-zA-Z]+\s*>|<!--[\s\S]*?-->)/);
      if (m) { i += m[0].length; continue; }
      m = rest.match(/^<ref\b[^>]*\/\s*>/i);
      if (m) { i += m[0].length; continue; }
      if (/^<ref\b/i.test(rest)) {
        var close = text.toLowerCase().indexOf('</ref', i);
        var gt = close < 0 ? -1 : text.indexOf('>', close);
        if (gt < 0) break;
        i = gt + 1;
        continue;
      }
      if (rest.charAt(0) === '{' && rest.charAt(1) === '{') {
        var tEnd = findTemplateEnd(text, i);
        if (tEnd < 0) break;
        var inner = text.slice(i + 2, tEnd - 2);
        var pipe = inner.indexOf('|');
        var name = normaliseTemplateName(pipe >= 0 ? inner.slice(0, pipe) : inner);
        if (!FOOTNOTE_TEMPLATES[name]) break;
        i = tEnd;
        continue;
      }
      break;
    }
    return i;
  }

  function sectionAt(sections, pos) {
    var found = null;
    for (var i = 0; i < sections.length; i++) {
      if (pos >= sections[i].start && pos < sections[i].end) found = sections[i].heading;
    }
    return found;
  }

  // -- <ref> parsing --

  function refAttributes(raw) {
    var out = {};
    var re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g;
    var m;
    while ((m = re.exec(raw))) {
      out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
    }
    return out;
  }

  // Ranges where a <ref> only defines a citation and says nothing about where
  // it is used: <references>…</references> and {{reflist|refs=…}}.
  function definitionRanges(wikitext) {
    var ranges = [];
    var block = /<references[^>]*>[\s\S]*?<\/references\s*>/gi;
    var m;
    while ((m = block.exec(wikitext))) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
    var listRe = /\{\{\s*(?:reflist|notelist|refbegin)[^{}]*?\|\s*refs\s*=/gi;
    while ((m = listRe.exec(wikitext))) {
      var end = findTemplateEnd(wikitext, m.index);
      ranges.push({ start: m.index, end: end < 0 ? wikitext.length : end });
    }
    return ranges;
  }

  function parseRefs(wikitext) {
    var defRanges = definitionRanges(wikitext);
    var lower = wikitext.toLowerCase();
    var out = [];
    var open = /<ref(\s[^>]*?)?\/?\s*>/gi;
    var m;
    while ((m = open.exec(wikitext))) {
      var attrs = refAttributes(m[1] || '');
      var selfClosing = /\/>$/.test(m[0].replace(/\s+$/, ''));
      var start = m.index;
      var content = '';
      var end = m.index + m[0].length;
      if (!selfClosing) {
        // MediaWiki does not nest <ref>, so the next </ref> closes this one.
        var close = lower.indexOf('</ref', end);
        if (close === -1) continue;
        var closeEnd = wikitext.indexOf('>', close);
        content = wikitext.slice(end, close);
        end = closeEnd === -1 ? wikitext.length : closeEnd + 1;
        open.lastIndex = end;
      }
      var definitionOnly = defRanges.some(function (r) {
        return start >= r.start && start < r.end;
      });
      out.push({
        name: attrs.name || null,
        group: attrs.group || null,
        content: content.replace(/^\s+|\s+$/g, ''),
        offset: start,
        end: end,
        reuse: selfClosing || !content.trim(),
        definitionOnly: definitionOnly
      });
    }
    return out;
  }

  function resolveRefs(refs) {
    var bodies = {};
    refs.forEach(function (r) {
      if (r.name && r.content && !bodies[r.name]) bodies[r.name] = r.content;
    });
    return refs.map(function (r) {
      var resolved = r.content || (r.name && bodies[r.name]) || '';
      return {
        name: r.name, group: r.group, content: r.content, offset: r.offset,
        end: r.end, reuse: r.reuse, definitionOnly: r.definitionOnly,
        resolvedContent: resolved
      };
    });
  }

  function firstTemplateBody(content) {
    var start = content.indexOf('{{');
    if (start === -1) return null;
    var end = findTemplateEnd(content, start);
    if (end < 0) return null;
    return content.slice(start + 2, end - 2);
  }

  function identifierUrl(named) {
    if (named.doi) return 'https://doi.org/' + encodeURI(named.doi.replace(/^doi:\s*/i, ''));
    if (named.pmid && /^\d+$/.test(named.pmid)) {
      return 'https://pubmed.ncbi.nlm.nih.gov/' + named.pmid + '/';
    }
    if (named.pmc) {
      return 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC' + named.pmc.replace(/^PMC/i, '') + '/';
    }
    if (named.jstor) return 'https://www.jstor.org/stable/' + encodeURIComponent(named.jstor);
    if (named.arxiv) return 'https://arxiv.org/abs/' + encodeURIComponent(named.arxiv);
    if (named.hdl) return 'https://hdl.handle.net/' + encodeURI(named.hdl);
    return null;
  }

  function firstOf(named, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = named[keys[i]];
      if (v && v.trim()) return stripWikitext(v).trim() || null;
    }
    return null;
  }

  // Citation templates on the largest non-English Wikipedias, and the parameter
  // names they carry. Sister-wiki references are the point of this parser, and
  // most of them are not written with {{cite web}}.
  // Mirrors FOREIGN_CITE_TEMPLATES and the *_KEYS lists in wikitextRefs.ts.
  var FOREIGN_CITE_TEMPLATES = {};
  ['internetquelle', 'literatur',
   'lien web', 'ouvrage', 'article', 'périodique', 'lien brisé',
   'cita web', 'cita publicación', 'cita libro', 'cita noticia',
   'cita news', 'cita pubblicazione', 'cita testo',
   'citeer web', 'citeer boek', 'citeer nieuws',
   'cytuj stronę', 'cytuj książkę', 'cytuj pismo', 'cytuj',
   'citar web', 'citar livro', 'citar jornal', 'citar periódico',
   'статья', 'книга', 'публикация', 'cite news2',
   'webbref', 'bokref', 'tidningsref',
   'citace elektronické monografie', 'citace monografie', 'citace periodika',
   'verkkoviite', 'kirjaviite', 'lehtiviite',
   'kilde www', 'kilde bok', 'kilde avis',
   'web kaynağı', 'hivatkozás', 'cite web/hu'
  ].forEach(function (n) { FOREIGN_CITE_TEMPLATES[n] = true; });

  var URL_KEYS = ['url', 'chapter-url', 'article-url', 'entry-url',
    'transcript-url', 'lien', 'adresse', 'ссылка'];
  var TITLE_KEYS = ['title', 'chapter', 'article', 'entry',
    'titel', 'titre', 'título', 'titulo', 'titolo', 'tytuł', 'tytul',
    'otsikko', 'tittel', 'заголовок', 'название', 'başlık'];
  var WORK_KEYS = ['work', 'website', 'newspaper', 'magazine', 'journal',
    'publisher', 'periodical', 'encyclopedia', 'site',
    'werk', 'hrsg', 'herausgeber', 'verlag', 'éditeur', 'editeur', 'site-web',
    'obra', 'editorial', 'editore', 'opublikowany', 'wydawca', 'uitgever',
    'utgivare', 'julkaisija', 'издательство', 'издание', 'periódico'];
  var AUTHOR_KEYS = ['author', 'author1', 'last', 'last1', 'authors', 'first',
    'autor', 'auteur', 'autore', 'författare', 'forfatter', 'tekijä',
    'автор', 'авторы', 'yazar'];
  var DATE_KEYS = ['date', 'year', 'publication-date',
    'datum', 'jahr', 'fecha', 'año', 'ano', 'data', 'rok', 'année',
    'vuosi', 'år', 'дата', 'год', 'tarih'];
  var QUOTE_KEYS = ['quote', 'quotation', 'zitat', 'cita', 'cytat', 'цитата'];

  function isCitationTemplate(name) {
    return /^(?:cite\b|citation$|vcite\b)/.test(name) || !!FOREIGN_CITE_TEMPLATES[name];
  }

  function refToSource(content) {
    var raw = String(content || '').replace(/^\s+|\s+$/g, '');
    if (!raw) return null;

    var body = firstTemplateBody(raw);
    if (body) {
      var t = parseTemplateBody(body);
      if (/^(?:sfn|sfnp|sfnm|harvnb|harv|harvtxt|harvp|r)$/.test(t.name)) {
        var label = t.positional.filter(Boolean).join(' ');
        return {
          url: null, title: label || null, work: null,
          author: t.positional[0] || null, date: null, quote: null,
          template: t.name, shortFootnote: true, raw: raw
        };
      }
      if (isCitationTemplate(t.name)) {
        var dead = /^(?:dead|unfit|usurped|bot: unknown)$/i.test(t.named['url-status'] || '');
        var archive = t.named['archive-url'] || t.named.archiveurl || t.named.archiv_url || null;
        var live = null;
        for (var u = 0; u < URL_KEYS.length && !live; u++) {
          if (t.named[URL_KEYS[u]] && t.named[URL_KEYS[u]].trim()) live = t.named[URL_KEYS[u]];
        }
        var url = (dead && archive ? archive : live || archive) || identifierUrl(t.named);
        var surname = t.named.last1 || t.named.last;
        var given = t.named.first1 || t.named.first;
        return {
          url: url ? url.trim() : null,
          title: firstOf(t.named, TITLE_KEYS) ||
            (t.positional[0] ? stripWikitext(t.positional[0]) : null),
          work: firstOf(t.named, WORK_KEYS),
          author: surname && given
            ? stripWikitext(surname) + ', ' + stripWikitext(given)
            : firstOf(t.named, AUTHOR_KEYS),
          date: firstOf(t.named, DATE_KEYS),
          quote: firstOf(t.named, QUOTE_KEYS),
          template: t.name, shortFootnote: false, raw: raw
        };
      }
    }

    var bracketed = raw.match(/\[((?:https?:)?\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/);
    if (bracketed) {
      return {
        url: bracketed[1],
        title: bracketed[2] ? stripWikitext(bracketed[2]).trim() : null,
        work: null, author: null, date: null, quote: null,
        template: null, shortFootnote: false, raw: raw
      };
    }
    var bare = raw.match(/(?:https?:)?\/\/[^\s|}\]<]+/);
    if (bare) {
      return {
        url: bare[0], title: null, work: null, author: null, date: null,
        quote: null, template: null, shortFootnote: false, raw: raw
      };
    }
    var text = stripWikitext(raw).trim();
    if (!text) return null;
    return {
      url: null, title: text.length > 200 ? text.slice(0, 199) + '…' : text,
      work: null, author: null, date: null, quote: null,
      template: null, shortFootnote: false, raw: raw
    };
  }

  function refTextOf(source) {
    return [source.title, source.work, source.author, source.date, source.quote]
      .filter(Boolean).join(' ');
  }

  // -- Relevance scoring --

  var STOPWORDS = {};
  ('the and for that with from this was were are has have had not but they ' +
   'his her its their our your which who whom whose been being other than ' +
   'into over under after before during between about above below such more ' +
   'most some any all can could would should might will shall must ' +
   'also however therefore because since while when where what how why ' +
   'der die das den dem des und ist sind war waren nicht auch aber oder ' +
   'les des une del las los por para con como que qui est sont pour dans ' +
   'sur avec plus mais nel della delle degli sono come anche per ' +
   'van het een voor met zijn niet ook maar ' +
   'article page site www http https com org net html pdf archived retrieved ' +
   'cite citation isbn issn doi accessed').split(/\s+/)
    .forEach(function (w) { STOPWORDS[w] = true; });

  var DIGIT_MAP = {};
  [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0e50, 0xff10].forEach(function (base) {
    for (var d = 0; d <= 9; d++) DIGIT_MAP[String.fromCharCode(base + d)] = String(d);
  });

  function normaliseDigits(text) {
    return String(text).replace(/[٠-٩۰-۹०-९০-৯๐-๙０-９]/g,
      function (c) { return DIGIT_MAP[c] || c; });
  }

  // "100,000", "1.250.000", "100\u202f000" → one number, not "100" and "000".
  // Mirrors joinDigitGroups in src/core/relevance.ts.
  function joinDigitGroups(text) {
    return String(text).replace(/\b\d{1,3}(?:[,.\u00a0\u2009\u202f]\d{3})+\b/g, function (m) {
      return m.replace(/[^\d]/g, '');
    });
  }

  function foldText(text) {
    return normaliseDigits(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function wordsOf(text) {
    return joinDigitGroups(normaliseDigits(text))
      .replace(/[‘’“”]/g, "'")
      .split(/[^\p{L}\p{N}'-]+/u)
      .map(function (w) { return w.replace(/^[-']+|[-']+$/g, ''); })
      .filter(function (w) { return w.length > 0; });
  }

  function isContentToken(folded) {
    if (STOPWORDS[folded]) return false;
    if (/\d/.test(folded)) return true;
    return folded.length >= 3;
  }

  function tokenWeight(raw, folded) {
    if (/^\d{3,4}$/.test(folded)) return 3;
    if (/\d/.test(folded)) return 2.5;
    if (/^\p{Lu}/u.test(raw)) return 1.8;
    return 1;
  }

  function tokenSetOf(text) {
    var out = Object.create(null);
    wordsOf(text).forEach(function (raw) {
      var folded = foldText(raw);
      if (isContentToken(folded)) out[folded] = true;
    });
    return out;
  }

  function weightedTokensOf(text, background) {
    var bag = Object.create(null);
    wordsOf(text).forEach(function (raw) {
      var folded = foldText(raw);
      if (!isContentToken(folded)) return;
      var weight = tokenWeight(raw, folded);
      if (background && background[folded]) weight *= 0.3;
      if (!bag[folded] || bag[folded] < weight) bag[folded] = weight;
    });
    return bag;
  }

  function coverageOf(query, text) {
    var have = tokenSetOf(text);
    var total = 0;
    var matched = 0;
    Object.keys(query).forEach(function (token) {
      total += query[token];
      if (have[token]) matched += query[token];
    });
    return total === 0 ? 0 : matched / total;
  }

  // Anchors are the parts of a sentence that survive translation: numbers and
  // dates, and proper nouns spelled the same way in the target language.
  function anchorsOf(text) {
    var src = joinDigitGroups(normaliseDigits(text)).replace(/[‘’“”]/g, "'");
    var numbers = [];
    var names = [];
    var seenNum = Object.create(null);
    var seenName = Object.create(null);
    var run = [];
    var runEnd = -1;
    function addName(value) {
      var folded = foldText(value);
      if (folded && !seenName[folded]) { seenName[folded] = true; names.push(folded); }
    }
    function flush() {
      if (!run.length) return;
      addName(run.join(' '));
      if (run.length > 1) run.forEach(addName);
      run = [];
    }
    var re = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
    var m;
    while ((m = re.exec(src))) {
      var raw = m[0];
      var folded = foldText(raw);
      if (/^\d[\d,.]*$/.test(folded)) {
        var digits = folded.replace(/[,.]/g, '');
        if (digits.length >= 2 && !seenNum[digits]) { seenNum[digits] = true; numbers.push(digits); }
        flush();
        continue;
      }
      // A capital right after sentence-ending punctuation is grammar, not a name.
      var before = src.slice(0, m.index);
      var sentenceInitial = /(?:^|[.!?。！？]|\n)\s*["'(«]?$/.test(before);
      if (/^\p{Lu}/u.test(raw) && folded.length >= 3 && !STOPWORDS[folded] && !sentenceInitial) {
        if (run.length && !/^[  -]*$/.test(src.slice(runEnd, m.index))) flush();
        run.push(raw);
        runEnd = m.index + raw.length;
        continue;
      }
      flush();
    }
    flush();
    return { numbers: numbers, names: names };
  }

  function anchorCount(a) {
    return a.numbers.length + a.names.length;
  }

  // Whether `text` has the number `n` as a whole number: "22" is in "22 °C"
  // and "1889er", not in "2022". Mirrors hasNumber in src/core/relevance.ts.
  function hasNumberIn(text, n) {
    var at = text.indexOf(n);
    while (at !== -1) {
      var before = at === 0 ? '' : text.charAt(at - 1);
      var after = text.charAt(at + n.length);
      if (!/\d/.test(before) && !/\d/.test(after)) return true;
      at = text.indexOf(n, at + 1);
    }
    return false;
  }

  function anchorScoreOf(query, text, extraNames) {
    var folded = foldText(joinDigitGroups(normaliseDigits(text)));
    var have = tokenSetOf(text);
    var matched = [];
    var seen = Object.create(null);
    var total = 0;
    var hit = 0;
    query.numbers.forEach(function (n) {
      total += 2;
      if ((have[n] || hasNumberIn(folded, n)) && !seen[n]) {
        seen[n] = true; hit += 2; matched.push(n);
      }
    });
    var allNames = query.names.concat((extraNames || []).map(foldText));
    var seenName = Object.create(null);
    allNames.forEach(function (name) {
      if (!name || seenName[name]) return;
      seenName[name] = true;
      total += 1;
      var present = name.indexOf(' ') !== -1 ? folded.indexOf(name) !== -1 : !!have[name];
      if (present && !seen[name]) { seen[name] = true; hit += 1; matched.push(name); }
    });
    return { score: total === 0 ? 0 : hit / total, matched: matched };
  }

  function isLatinScript(text) {
    var sample = text.slice(0, 4000);
    var letters = sample.match(/\p{L}/gu);
    if (!letters || letters.length < 20) return true;
    var latin = sample.match(/\p{Script=Latin}/gu);
    return (latin ? latin.length : 0) / letters.length > 0.6;
  }

  // -- Indexing one article --

  function hostSentence(before) {
    var parts = splitSentences(before);
    if (!parts.length) return before.trim();
    var last = parts[parts.length - 1];
    if (last.length < 25 && parts.length > 1) {
      return (parts[parts.length - 2] + ' ' + last).trim();
    }
    return last;
  }

  // Every ref in a paragraph is swapped for a control character, the paragraph
  // is stripped once, and the markers are read back in order — which is how a
  // reference gets attached to the sentence it actually supports.
  function indexWikiArticle(code, title, wikitext) {
    var sections = sectionRangesOf(wikitext);
    var resolved = resolveRefs(parseRefs(wikitext)).filter(function (r) {
      return !r.definitionOnly;
    });
    var paragraphs = paragraphRangesOf(wikitext);
    var groups = [];
    var byIndex = {};
    var cursor = 0;
    resolved.forEach(function (ref) {
      while (cursor < paragraphs.length && paragraphs[cursor].end <= ref.offset) cursor++;
      if (cursor >= paragraphs.length) return;
      if (ref.offset < paragraphs[cursor].start) return;
      if (!byIndex[cursor]) { byIndex[cursor] = []; groups.push(cursor); }
      byIndex[cursor].push(ref);
    });

    var refs = [];
    groups.forEach(function (index) {
      var range = paragraphs[index];
      var group = byIndex[index];
      var marked = '';
      var at = range.start;
      group.forEach(function (ref) {
        marked += wikitext.slice(at, ref.offset) + REF_MARK;
        at = ref.end;
      });
      marked += wikitext.slice(at, range.end);

      var plain = stripWikitext(marked);
      var paragraph = plain.split(REF_MARK).join('').replace(/\s+/g, ' ').trim();
      var searchFrom = 0;
      group.forEach(function (ref) {
        var markPos = plain.indexOf(REF_MARK, searchFrom);
        if (markPos !== -1) searchFrom = markPos + 1;
        var before = markPos === -1
          ? paragraph
          : plain.slice(0, markPos).split(REF_MARK).join('').trim();
        var source = refToSource(ref.resolvedContent);
        if (!source) return;
        refs.push({
          occurrence: ref,
          source: source,
          sentence: hostSentence(before) || paragraph,
          paragraph: paragraph,
          section: sectionAt(sections, ref.offset)
        });
      });
    });

    return {
      lang: code,
      title: title,
      url: 'https://' + code + '.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
      wikitext: wikitext,
      refs: refs,
      sections: sections,
      latin: isLatinScript(stripWikitext(wikitext.slice(0, 8000)))
    };
  }

  // -- Corpus loading --

  var wikiCorpus = null;
  var wikiCorpusPromise = null;

  // Offsets of every rendered {{citation needed}} in the wikitext, in the same
  // order as the <sup> elements on the page. Shares CN_ALIASES and the
  // non-rendered skipping with the editor insertion, so both agree on index N.
  function citationNeededOffsets(text) {
    var out = [];
    var i = 0;
    while (i < text.length - 1) {
      var skip = skipNonRendered(text, i);
      if (skip > i) { i = skip; continue; }
      if (text.charCodeAt(i) === 123 && text.charCodeAt(i + 1) === 123) {
        var end = findTemplateEnd(text, i);
        if (end > 0) {
          var inner = text.slice(i + 2, end - 2);
          var pipe = inner.indexOf('|');
          var name = normaliseTemplateName(pipe >= 0 ? inner.slice(0, pipe) : inner);
          if (Object.prototype.hasOwnProperty.call(CN_ALIASES, name)) {
            out.push({ start: i, end: end });
          }
          i = end;
          continue;
        }
      }
      i++;
    }
    return out;
  }

  function loadWikiCorpus() {
    if (wikiCorpusPromise) return wikiCorpusPromise;
    console.log('[CNfirmed] wiki-local stage: fetching', WIKI_CODE + ':' + pageTitle);
    wikiCorpusPromise = wikiFetchWikitext(WIKI_CODE, pageTitle).then(function (page) {
      var local = indexWikiArticle(WIKI_CODE, page.title, page.wikitext);
      var offsets = citationNeededOffsets(page.wikitext);
      console.log('[CNfirmed] wiki-local stage: parsed', local.refs.length, 'ref(s) in',
        WIKI_CODE + ':' + page.title, '|', offsets.length, 'citation-needed tag(s) in wikitext vs',
        cnSups.length, 'rendered on page');
      var corpus = {
        local: local,
        sisters: [],
        linkTranslations: {},
        // Only trust the DOM-to-wikitext mapping when the counts agree; when
        // they do not, scoring falls back to section matching alone.
        claimOffsets: offsets.length === cnSups.length ? offsets : null,
        warnings: []
      };
      if (!corpus.claimOffsets) {
        corpus.warnings.push(
          offsets.length + ' {{cn}}-family tag(s) found in wikitext but ' + cnSups.length +
          ' rendered on page — same-article matching falls back to section-only'
        );
      }
      wikiCorpus = corpus;

      return wikiFetchLangLinks(WIKI_CODE, [page.title]).then(function (links) {
        var available = links[page.title] || {};
        var chosen = [];
        WIKI_SISTER_LANGS.forEach(function (code) {
          if (chosen.length >= WIKI_MAX_SISTERS) return;
          if (code === WIKI_CODE || !available[code]) return;
          chosen.push({ lang: code, title: available[code] });
        });
        console.log('[CNfirmed] wiki-local stage: sister wikis chosen:',
          chosen.map(function (c) { return c.lang; }));
        if (!chosen.length) {
          corpus.warnings.push('no counterpart article on the larger language editions');
          return corpus;
        }
        var targets = [];
        var langs = chosen.map(function (c) { return c.lang; });
        claimContexts.forEach(function (ctx) {
          (ctx && ctx.links ? ctx.links : []).forEach(function (t) {
            if (targets.indexOf(t) === -1) targets.push(t);
          });
        });
        var translations = targets.length
          ? wikiFetchLangLinks(WIKI_CODE, targets, langs).catch(function () { return {}; })
          : Promise.resolve({});
        return translations.then(function (map) {
          corpus.linkTranslations = map;
          return Promise.all(chosen.map(function (target) {
            return wikiFetchWikitext(target.lang, target.title).then(function (sister) {
              corpus.sisters.push(indexWikiArticle(target.lang, sister.title, sister.wikitext));
            }).catch(function (err) {
              corpus.warnings.push(target.lang + '.wikipedia.org: ' + (err.message || err));
            });
          })).then(function () { return corpus; });
        });
      }).catch(function (err) {
        corpus.warnings.push('interlanguage links unavailable: ' + (err.message || err));
        return corpus;
      });
    });
    wikiCorpusPromise.catch(function () { wikiCorpusPromise = null; });
    return wikiCorpusPromise;
  }

  // -- Per-claim search --

  function urlKeyOf(url) {
    try {
      var u = new URL(url);
      return u.hostname.toLowerCase().replace(/^www\./, '') +
        u.pathname.replace(/\/+$/, '') + u.search;
    } catch (e) {
      return String(url).trim().toLowerCase();
    }
  }

  function candidateTitleOf(source) {
    return source.title || source.work || source.url || 'untitled reference';
  }

  // Citation wikitext that will actually render on this wiki. A reference
  // copied from another language edition may use a template that only exists
  // there ({{Internetquelle}}, {{Lien web}}), so anything that is not an
  // English cite/citation call is rebuilt from the fields parsed out of it.
  function portableCitation(source) {
    if (source.template && /^(?:cite\b|citation$)/.test(source.template)) {
      return source.raw;
    }
    var parts = [
      'cite web',
      'url=' + (source.url || ''),
      'title=' + escapePipes(source.title || source.url || '')
    ];
    if (source.work) parts.push('work=' + escapePipes(source.work));
    if (source.author) parts.push('author=' + escapePipes(source.author));
    if (source.date) parts.push('date=' + escapePipes(source.date));
    return '{{' + parts.join(' |') + '}}';
  }

  // Where claim `index` sits in the article's wikitext, as a tag's span: the
  // tag itself, or for a picked claim the point its <ref> would go. Null when
  // unknown, and matching then falls back to the section alone.
  function claimPositionIn(corpus, ctx, index) {
    if (!ctx.picked) return corpus.claimOffsets ? corpus.claimOffsets[index] : null;
    if (ctx.wikitextAt === undefined) {
      var text = corpus.local.wikitext;
      var found = locateClaimText(text, ctx.claim, ctx.before);
      var point = found ? citationPointAfter(text, found.end) : -1;
      ctx.wikitextAt = point < 0 ? null : { start: point, end: point };
    }
    return ctx.wikitextAt;
  }

  function sameArticleCandidates(corpus, ctx, index) {
    var background = tokenSetOf(pageTitle.replace(/_/g, ' ') + ' ' + (ctx.section || ''));
    // Deliberately just the tagged sentence, not ctx.context (the whole
    // paragraph): a paragraph strings several sentences together, each with
    // its own citation, so including it would let a neighbouring reference
    // match trivially against its own sentence sitting right there in the
    // query.
    var query = weightedTokensOf(ctx.claim, background);
    var at = claimPositionIn(corpus, ctx, index);
    var range = at ? paragraphRangeAt(corpus.local.wikitext, at.start) : null;
    var own = at ? taggedSentenceRange(corpus.local.wikitext, at.start, at.end) : null;

    var out = [];
    corpus.local.refs.forEach(function (ref) {
      if (ref.occurrence.group) return;
      // Cited in the tagged sentence itself: an editor saw this reference and
      // still asked for a citation, so it is the one source not to suggest.
      if (own ? (ref.occurrence.offset >= own.start && ref.occurrence.offset < own.end)
        : restatesClaim(ref.sentence, ctx.claim)) return;
      var sameParagraph = !!range &&
        ref.occurrence.offset >= range.start && ref.occurrence.offset < range.end;
      var sameSection = !!ctx.section && ref.section === ctx.section;
      if (!sameParagraph && !sameSection) return;

      var lexical = coverageOf(query, refTextOf(ref.source) + ' ' + ref.sentence);
      // A real paragraph usually strings several sentences together, each
      // citing a different specific fact — "sits in the same paragraph" says
      // almost nothing about whether THIS reference is about THIS sentence.
      // Actual shared vocabulary with the reference's title/work/quote or the
      // sentence it supports has to carry the match; distance only narrows
      // the field further, never substitutes for it.
      if (lexical < (sameParagraph ? 0.2 : 0.35)) return;

      var distance = Math.abs(ref.occurrence.offset - (at ? at.start : 0));
      var proximity = sameParagraph ? (distance < 200 ? 1 : 0.5) : 0.25;
      var score = 0.75 * lexical + 0.25 * proximity;
      if (score < WIKI_MIN_SCORE) return;
      if (ref.source.url && isUnreliableDomain(ref.source.url)) return;
      // Without a URL there is nothing to verify, so a nearby reference is
      // not enough on its own — demand real content overlap.
      if (!ref.source.url && lexical < 0.4) return;

      out.push({
        url: ref.source.url,
        title: candidateTitleOf(ref.source),
        relevance: 'already cited in this article for: “' + truncate(ref.sentence, 160) + '”',
        snippet: ref.source.quote || ref.sentence,
        // Re-using a name already defined on the page is the smallest possible
        // edit; failing that, this wiki's own markup can be copied as written.
        ref: ref.occurrence.name
          ? '<ref name="' + ref.occurrence.name + '" />'
          : '<ref>' + ref.source.raw + '</ref>',
        evidence: {
          origin: 'same-article',
          lang: corpus.local.lang,
          article: corpus.local.title,
          articleUrl: corpus.local.url,
          sentence: ref.sentence,
          section: ref.section,
          score: Math.round(score * 1000) / 1000,
          refName: ref.occurrence.name
        }
      });
    });
    return out;
  }

  function sisterWikiCandidates(corpus, ctx) {
    var query = anchorsOf(ctx.claim);
    if (!query.numbers.length) query.numbers = anchorsOf(ctx.context).numbers;
    if (anchorCount(query) < 2) return [];
    var claimLinks = ctx.links || [];

    var out = [];
    corpus.sisters.forEach(function (sister) {
      var translated = [];
      claimLinks.forEach(function (target) {
        var map = corpus.linkTranslations[target];
        if (map && map[sister.lang]) translated.push(map[sister.lang]);
      });
      // Proper nouns only transfer between wikis that share a script.
      var scoped = (sister.latin && corpus.local.latin)
        ? query
        : { numbers: query.numbers, names: [] };
      if (anchorCount(scoped) + translated.length < 2) return;

      sister.refs.forEach(function (ref) {
        if (ref.occurrence.group) return;
        if (!ref.source.url || isUnreliableDomain(ref.source.url)) return;

        var onSentence = anchorScoreOf(scoped, ref.sentence, translated);
        var onParagraph = anchorScoreOf(scoped, ref.paragraph, translated);
        var useSentence = onSentence.score >= onParagraph.score * 0.9;
        var score = useSentence ? onSentence.score : onParagraph.score * 0.7;
        var matched = useSentence ? onSentence.matched : onParagraph.matched;

        var strong = score >= 0.8 && matched.length >= 1;
        if (!strong && (score < WIKI_MIN_ANCHOR_SCORE || matched.length < 2)) return;

        out.push({
          url: ref.source.url,
          title: candidateTitleOf(ref.source),
          relevance: 'cited on ' + sister.lang + '.wikipedia (' + sister.title +
            ') for: “' + truncate(ref.sentence, 160) + '”',
          snippet: ref.source.quote || ref.sentence,
          ref: '<ref>' + portableCitation(ref.source) + '</ref>',
          evidence: {
            origin: 'sister-wiki',
            lang: sister.lang,
            article: sister.title,
            articleUrl: sister.url,
            sentence: ref.sentence,
            section: ref.section,
            score: Math.round(score * 1000) / 1000,
            matchedAnchors: matched,
            refName: ref.occurrence.name
          }
        });
      });
    });
    return out;
  }

  function findWikiCandidates(corpus, index) {
    var ctx = claimContexts[index];
    if (!ctx || !ctx.claim) return [];
    var all = sameArticleCandidates(corpus, ctx, index)
      .concat(sisterWikiCandidates(corpus, ctx));

    var best = {};
    var order = [];
    all.forEach(function (candidate) {
      var key = candidate.url ? urlKeyOf(candidate.url) : 'raw:' + candidate.ref;
      if (!best[key]) order.push(key);
      if (!best[key] || candidate.evidence.score > best[key].evidence.score) {
        best[key] = candidate;
      }
    });
    return order.map(function (key) { return best[key]; }).sort(function (a, b) {
      if (b.evidence.score !== a.evidence.score) return b.evidence.score - a.evidence.score;
      // A citation another wiki attached to this very fact beats one this
      // article merely happens to use nearby.
      var rank = function (c) { return c.evidence.origin === 'sister-wiki' ? 0 : 1; };
      return rank(a) - rank(b);
    }).slice(0, WIKI_MAX_CANDIDATES);
  }

  // -- Orchestration --

  function runWikiStage(index, retry) {
    var current = wikiState[index];
    if (current && (current.status === 'done' || (current.status === 'error' && !retry))) {
      return Promise.resolve(current);
    }
    if (current && current.promise) return current.promise;

    var entry = { status: 'running' };
    wikiState[index] = entry;
    renderRow(index); renderBadge(index);
    entry.promise = loadWikiCorpus().then(function (corpus) {
      if (corpus.warnings && corpus.warnings.length) {
        console.warn('[CNfirmed] wiki-local stage:', corpus.warnings.join('; '));
      }
      var candidates = findWikiCandidates(corpus, index);
      console.log('[CNfirmed] wiki-local claim', index, ':', candidates.length,
        'candidate(s)', candidates);
      wikiState[index] = { status: 'done', candidates: candidates, warnings: corpus.warnings };
      persistWiki();
      renderRow(index); renderBadge(index);
      return wikiState[index];
    }).catch(function (err) {
      console.error('[CNfirmed] wiki-local stage failed for claim', index, ':', err);
      wikiState[index] = { status: 'error', error: (err && err.message) || String(err) };
      renderRow(index); renderBadge(index);
      return wikiState[index];
    });
    return entry.promise;
  }

  function hydrateWikiCache() {
    try {
      var raw = localStorage.getItem(wikiCacheKey);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') wikiState = dropPickedResults(parsed);
    } catch (e) { /* ignore */ }
  }

  function persistWiki() {
    try {
      var serialisable = {};
      Object.keys(wikiState).forEach(function (k) {
        var s = wikiState[k];
        if (s && s.status === 'done') {
          serialisable[k] = { status: 'done', candidates: s.candidates, warnings: s.warnings };
          // Only a finished check is kept: one that failed or was cut short
          // runs again when the claim is next opened.
          if (s.check && s.check.status === 'done') serialisable[k].check = s.check;
        }
      });
      localStorage.setItem(wikiCacheKey, JSON.stringify(serialisable));
    } catch (e) { /* ignore */ }
  }

  // -- Checking other-language leads --
  // The anchors find a sentence on another wiki that shares the claim's
  // numbers and names, which is not the same as stating its fact: on Vanadium,
  // "element 24 (chromium)" matched "24 million tonnes of reserves". So each
  // sister-wiki lead's sentence, the one that wiki cited the source for, goes
  // to the judge model with the claim, all of a claim's leads in one call: does
  // it state the same fact? The text is already in hand, so nothing is
  // fetched. A pass means another wiki cited this source for this fact, not
  // that the source was read: the lead says so. With no judge model, or when
  // the call fails, each sentence goes to the Verify API as the source instead.
  // Same-article leads are not checked: their sentence is by design a
  // different one, the neighbour whose source may cover this claim too.

  var WIKI_SAME_SYSTEM = [
    "You decide, for each sentence from another language edition of Wikipedia, whether it states the same fact as a claim from a Wikipedia article. Each sentence is the one that edition cited a source for, so a sentence stating the same fact points to a source for the claim.",
    "",
    "- \"same\": the sentence states the claim's fact, with its specific content (who, what, and any number or date), in whatever language or wording.",
    "- \"partial\": it states a substantial part of what the claim asserts (one of two facts, the event but not the date), enough to cite for that part.",
    "- \"no\": it states something else: the same topic, the same names or numbers in a different statement, or only a background detail of the claim.",
    "",
    "Be strict: shared numbers and names are not the same fact. \"24\" as an atomic number and \"24 million tonnes\" are different facts.",
    "",
    "Reply with JSON only: {\"sentences\": [{\"id\": \"S1\", \"verdict\": \"same\", \"why\": \"one short sentence\"}]}, one entry per sentence, in order."
  ].join('\n');
  var WIKI_SAME_MAX_TOKENS = 4000;
  var WIKI_SAME_EFFORT = 'low';
  var WIKI_SAME_SENTENCE_CHARS = 600;
  var WIKI_SAME_VERDICTS = ['same', 'partial', 'no'];
  var VERIFY_TO_WIKI_SAME = {
    'SUPPORTED': 'same',
    'PARTIALLY SUPPORTED': 'partial',
    'NOT SUPPORTED': 'no'
  };

  function isSisterLead(c) {
    return !!(c && c.evidence && c.evidence.origin === 'sister-wiki');
  }

  function wikiSamePrompt(input, leads) {
    var head = 'Article: ' + libArticleName(input.articleTitle) + '\n' +
      'Claim: ' + input.claim + '\n' +
      "The claim's paragraph, for context only: " + libClip(input.paragraph, 1200) + '\n';
    var list = leads.map(function (c, i) {
      var ev = c.evidence;
      return 'S' + (i + 1) + '. ' + ev.lang + '.wikipedia, ' + libClip(ev.article, 120) +
        (ev.section ? ', section "' + libClip(ev.section, 80) + '"' : '') + ':\n' +
        libClip(ev.sentence, WIKI_SAME_SENTENCE_CHARS);
    });
    return head + '\n' + list.join('\n\n');
  }

  // A verdict per lead, in order: { verdict: same | partial | no, reason },
  // or null where the reply gives none.
  function wikiParseSame(text, leads) {
    var j = libJsonObjectIn(text);
    var list = j && Array.isArray(j.sentences) ? j.sentences : null;
    if (!list) throw new Error('check: the model gave no verdicts');
    var byId = Object.create(null);
    list.forEach(function (e, i) {
      if (!e || typeof e !== 'object') return;
      var id = String(e.id == null ? 'S' + (i + 1) : e.id).trim().toUpperCase();
      if (!byId[id]) byId[id] = e;
    });
    return leads.map(function (c, i) {
      var r = byId['S' + (i + 1)];
      if (!r) return null;
      var v = String(r.verdict == null ? '' : r.verdict).trim().toLowerCase();
      if (WIKI_SAME_VERDICTS.indexOf(v) === -1) return null;
      return { verdict: v, reason: typeof r.why === 'string' ? r.why.trim() : '' };
    });
  }

  function toWikiSameVerdict(result) {
    var verdict = result && VERIFY_TO_WIKI_SAME[String(result.verdict || '').trim().toUpperCase()];
    return verdict ? { verdict: verdict, reason: result.comments || '' } : null;
  }

  // The check of a claim's sister-wiki leads: the judge model in one call, or
  // the Verify API, one sentence after another, when there is none or the call
  // fails. Resolves to the verdicts, in order, and what gave them.
  function checkSisterLeads(ctx, leads) {
    function viaVerifyApi() {
      var out = [];
      return leads.reduce(function (chain, c) {
        return chain.then(function () {
          return callVerifyApi(ctx.claim, c.evidence.sentence).then(function (r) {
            out.push(toWikiSameVerdict(r));
          });
        });
      }, Promise.resolve()).then(function () { return { verdicts: out, by: 'verify-api' }; });
    }
    var judge = libModels().judge;
    if (!judge) return viaVerifyApi();
    var input = {
      articleTitle: mw.config.get('wgTitle') || pageTitle,
      paragraph: ctx.context,
      claim: ctx.claim
    };
    return callWorkerModel(judge, WIKI_SAME_SYSTEM, wikiSamePrompt(input, leads),
      WIKI_SAME_MAX_TOKENS, WIKI_SAME_EFFORT)
      .then(function (text) {
        return { verdicts: wikiParseSame(text, leads), by: judge };
      })
      .catch(function (err) {
        console.warn('[CNfirmed] the judge model failed on the other-language leads; ' +
          'checking with the Verify API instead:', err);
        return viaVerifyApi();
      });
  }

  // Runs the check for a claim whose wiki-local stage is done, and keeps the
  // verdicts on its sister-wiki candidates.
  function checkWikiStage(index) {
    var w = wikiState[index];
    if (!w || w.status !== 'done') return Promise.resolve(w);
    var leads = (w.candidates || []).filter(isSisterLead);
    if (!leads.length) return Promise.resolve(w);
    if (w.checking) return w.checking;
    w.check = { status: 'running' };
    renderPanel(index);
    w.checking = checkSisterLeads(claimContexts[index], leads)
      .then(function (r) {
        leads.forEach(function (c, k) { c.check = r.verdicts[k]; });
        w.check = { status: 'done', by: r.by };
        console.log('[CNfirmed] other-language leads for claim', index, 'checked by', r.by + ':',
          r.verdicts.map(function (v) { return v ? v.verdict : 'none'; }).join(', '));
      }, function (err) {
        console.error('[CNfirmed] other-language check failed for claim', index, ':', err);
        w.check = { status: 'error', error: (err && err.message) || String(err) };
      }).then(function () {
        delete w.checking;
        persistWiki();
        renderPanel(index); renderBadge(index);
        return w;
      });
    return w.checking;
  }

  // The wiki-local stage, then the check of its other-language leads; leads
  // cached before their check finished are checked now.
  function runWiki(i, retry) {
    return runWikiStage(i, retry).then(function (w) {
      if (w && w.status === 'done' && !w.check) return checkWikiStage(i);
      return w;
    });
  }

  // ---- Internet Archive: books -------------------------------------------
  // Free, no key, no model: full-text search over the Archive's OCRed books,
  // keeping those an editor can read — open, or borrowable with a free account
  // — whose matching passage carries the claim's numbers and names. Mirrors src/core/archiveSources.ts; the parity test
  // runs both on the same recorded search response.
  //
  // Only https://archive.org is on Wikipedia's CSP allowlist, so this uses the
  // endpoint archive.org's own search page uses. Each hit carries its year,
  // collections and matching passages, so the only other request is item
  // metadata for the two or three books kept.

  var IA_SEARCH_URL = 'https://archive.org/services/search/beta/page_production/';
  var IA_METADATA_URL = 'https://archive.org/metadata/';
  var IA_MAX_HITS = 50;
  var IA_MAX_QUERIES = 3;
  var IA_MAX_PHRASE_QUERIES = 4;
  var IA_ENOUGH_HITS = 10;
  var IA_MAX_CANDIDATES = 4;
  var IA_MIN_SCORE = 0.3;
  var IA_MIN_PASSAGE_CHARS = 40;
  // Anyone with a free account can borrow these; 'printdisabled' alone is for
  // certified print-disabled readers only.
  var IA_LENDING = { inlibrary: true, lendinglibrary: true };

  function iaSubjectOf(title) {
    return String(title).replace(/_/g, ' ').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  function iaRawNumbers(text) {
    var out = [];
    var re = /\d(?:[\d,.]*\d)?/g;
    var m;
    var src = normaliseDigits(text);
    while ((m = re.exec(src))) {
      if (m[0].replace(/[,.]/g, '').length >= 2 && out.indexOf(m[0]) === -1) out.push(m[0]);
    }
    var isYear = function (n) { return /^(1[0-9]|20)\d\d$/.test(n); };
    return out.filter(isYear).concat(out.filter(function (n) { return !isYear(n); }));
  }

  // Where a key phrase breaks: function words, and common verbs and adverbs.
  // Mirrors PHRASE_BREAKS in src/core/archiveSources.ts.
  var IA_PHRASE_BREAKS = {};
  ('a an the of in on at to by for from with as is was were be been being are it its this that these those ' +
   'and or but not no nor so than then there their they he she his her him them who whom which what when where ' +
   'while also has have had do does did can could would should may might will shall must into onto over under ' +
   'after before during about between through up down out off such some any all each other more most many much ' +
   'very only just even both either neither however although though because since if until unless whether ' +
   'one two three four five six seven eight nine ten first second third including include includes ' +
   'became become becomes took take takes taken went go goes gone made make makes led lead leads said say says ' +
   'called known used using possesses possess possessed considered consider held hold holds given give gave ' +
   'found find finds began begin begins started starts start came come comes saw seen see got get gets ' +
   'presumably originally initially usually often later still around almost nearly approximately ' +
   'contains contain contained included according reported confirmed refer refers referred')
    .split(/\s+/).forEach(function (w) { IA_PHRASE_BREAKS[w] = true; });

  // The claim's key phrases, most telling first. Mirrors keyPhrases in
  // src/core/archiveSources.ts, which explains the rules.
  function iaKeyPhrases(claim, subject) {
    var subjectTokens = tokenSetOf(subject);
    var tokens = String(claim).replace(/[\u2018\u2019\u201c\u201d]/g, "'")
      .split(/(\s+|[,;:()."!?\u2013\u2014]+)/)
      .filter(function (t) { return t.trim().length > 0; });
    var runs = [];
    var run = [];
    var flush = function () { if (run.length) runs.push(run); run = []; };
    tokens.forEach(function (t) {
      if (/^[,;:()."!?\u2013\u2014]+$/.test(t) || IA_PHRASE_BREAKS[t.toLowerCase()] || /^'s$/i.test(t)) {
        flush();
        return;
      }
      var possessive = /'s$/i.test(t);
      var w = t.replace(/^'+|'+$/g, '').replace(/'s$/i, '');
      if (!w) return;
      run.push(w);
      if (possessive) flush();
    });
    flush();
    var split = [];
    runs.forEach(function (r) {
      if (r.length <= 3 || r.every(function (w) { return /^\p{Lu}/u.test(w); })) {
        split.push(r.slice(0, 4));
      } else {
        for (var i = 0; i + 1 < r.length; i++) split.push(r.slice(i, i + 2));
      }
    });
    var score = function (p) {
      var informative = p.filter(function (w) { return !subjectTokens[foldText(w)]; });
      if (informative.length === 0) return -1;
      var s = p.length * 2;
      informative.forEach(function (w) {
        if (/\d/.test(w)) s += 3;
        else if (/^\p{Lu}/u.test(w)) s += 2;
        else if (w.length >= 8) s += 1.5;
        else if (w.length >= 5) s += 0.5;
      });
      return s;
    };
    var out = [];
    split
      .filter(function (p) { return p.join(' ').length >= 4; })
      .map(function (p) { return { phrase: p.join(' '), score: score(p) }; })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .forEach(function (x) { if (out.indexOf(x.phrase) === -1) out.push(x.phrase); });
    return out;
  }

  function iaSubjectWords(subject) {
    return wordsOf(subject).filter(function (w) {
      return w.length >= 3 && !IA_PHRASE_BREAKS[w.toLowerCase()];
    });
  }

  function iaClaimTerms(claim, title) {
    var subject = iaSubjectOf(title);
    var subjectTokens = tokenSetOf(subject);
    var names = anchorsOf(claim).names
      .filter(function (name) {
        return !name.split(' ').every(function (w) { return subjectTokens[w]; });
      })
      .sort(function (a, b) { return b.length - a.length || (a < b ? -1 : 1); });
    var kept = [];
    names.forEach(function (name) {
      if (kept.some(function (k) { return k.split(' ').indexOf(name) !== -1; })) return;
      kept.push(name);
    });
    return {
      subject: subject,
      numbers: iaRawNumbers(claim).slice(0, 3),
      names: kept.slice(0, 2),
      phrases: iaKeyPhrases(claim, subject).slice(0, 3),
      subjectWords: iaSubjectWords(subject)
    };
  }

  function iaPhrase(term) {
    return '"' + libSafeTerm(term) + '"';
  }

  // Terms are joined by a space, which the endpoint reads as AND: between two
  // terms an explicit AND is taken for the word "and", and each book's few
  // passages are spent highlighting it.
  function buildArchiveQueries(terms) {
    var subject = iaPhrase(terms.subject);
    var numbers = terms.numbers.map(iaPhrase);
    var names = terms.names.map(iaPhrase);
    var strongest = numbers[0] || names[0];
    if (!strongest || !terms.subject) return [];
    var out = [];
    [[subject].concat(numbers, names), [subject].concat(numbers), [subject, strongest]]
      .forEach(function (t) {
        if (t.length < 2) return;
        var q = t.join(' ');
        if (out.indexOf(q) === -1) out.push(q);
      });
    return out;
  }

  // Queries from the claim's key phrases. Mirrors buildPhraseQueries.
  function buildPhraseQueries(terms) {
    var subject = terms.subjectWords.map(iaPhrase);
    var phrases = terms.phrases.map(iaPhrase);
    if (phrases.length === 0) return [];
    var out = [];
    [subject.concat(phrases.slice(0, 3)), subject.concat(phrases.slice(0, 2)),
     subject.concat([phrases[0]]), phrases.length >= 2 ? phrases.slice(0, 2) : []]
      .forEach(function (t) {
        if (t.length === 0) return;
        var q = t.join(' ');
        if (out.indexOf(q) === -1) out.push(q);
      });
    return out;
  }

  function iaFirst(value) {
    if (Array.isArray(value)) return iaFirst(value[0]);
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return null;
  }

  function iaAll(value) {
    if (Array.isArray(value)) {
      return value.reduce(function (acc, v) { return acc.concat(iaAll(v)); }, []);
    }
    var one = iaFirst(value);
    return one === null ? [] : [one];
  }

  function iaYearOf(value) {
    var m = /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(iaFirst(value) || '');
    return m ? Number(m[1]) : null;
  }

  function iaStripHighlight(text) {
    return String(text).replace(/\{\{\{|\}\}\}/g, '').replace(/<\/?em>/gi, '')
      .replace(/\s+/g, ' ').trim();
  }

  function parseArchiveHits(response, query) {
    var raw = (response && response.response && response.response.body &&
      response.response.body.hits && response.response.body.hits.hits) || [];
    var out = [];
    raw.forEach(function (h, rank) {
      if (!h || typeof h !== 'object') return;
      var f = h.fields || {};
      var identifier = iaFirst(f.identifier);
      if (!identifier) return;
      var year = iaYearOf(f.year);
      out.push({
        identifier: identifier,
        title: iaFirst(f.title) || identifier,
        creator: iaFirst(f.creator),
        year: year !== null ? year : iaYearOf(f.date),
        mediatype: iaFirst(f.mediatype),
        collections: iaAll(f.collection),
        file: iaFirst(f.file_basename),
        highlights: iaAll(h.highlight && h.highlight.text).map(iaStripHighlight)
          .filter(function (t) { return t.length > 0; }),
        rank: rank,
        query: query
      });
    });
    return out;
  }

  // Whether an editor can read the book, and how: 'open' or 'borrow'.
  function archiveGate(hit) {
    if (hit.mediatype && hit.mediatype !== 'texts') return { ok: false, reason: 'not a text' };
    if (hit.collections.some(function (c) { return IA_LENDING[c]; })) {
      return { ok: true, access: 'borrow' };
    }
    if (hit.collections.indexOf('printdisabled') !== -1) {
      return { ok: false, reason: 'print-disabled readers only' };
    }
    return { ok: true, access: 'open' };
  }

  // books: the item's OCR text files, without _djvu.txt — more than one when
  // the item bundles several books under one title.
  function archiveDetailsOf(response) {
    var md = (response && response.metadata) || {};
    var files = response && Array.isArray(response.files) ? response.files : [];
    var books = files
      .map(function (f) { return f && typeof f === 'object' ? iaFirst(f.name) : null; })
      .filter(function (n) { return n !== null && /_djvu\.txt$/.test(n); })
      .map(function (n) { return n.slice(0, -'_djvu.txt'.length); });
    return {
      publisher: iaFirst(md.publisher),
      isbn: iaFirst(md.isbn),
      dark: response.is_dark === true,
      restricted: String(iaFirst(md['access-restricted-item']) || '').toLowerCase() === 'true',
      books: books
    };
  }

  // The book a hit matched in, when its item bundles several: the item's title
  // is then another book's, and its page opens on the first book. Mirrors
  // bundledBook.
  function iaBundledBook(hit, details) {
    var books = (details && details.books) || [];
    return books.length > 1 && hit.file !== null && hit.file !== undefined &&
      books.indexOf(hit.file) !== -1 ? hit.file : null;
  }

  // Every lending-library book is flagged restricted; any other one cannot be
  // borrowed, so nobody without special access can read it.
  function archiveDetailsGate(details, access) {
    if (details.dark) return { ok: false, reason: 'withdrawn' };
    if (details.restricted && access === 'open') return { ok: false, reason: 'access restricted' };
    return { ok: true };
  }

  function iaScoringContext(claim, subject) {
    var subjectTokens = tokenSetOf(subject);
    return {
      anchors: anchorsOf(claim),
      bag: weightedTokensOf(claim, subjectTokens),
      subjectTokens: Object.keys(subjectTokens)
    };
  }

  // datelineYear: a periodical issue's own year, which every page of it prints
  // in the masthead — not evidence, so not counted as a matched number.
  function scoreArchivePassage(text, ctx, bookIsAboutSubject, datelineYear) {
    var v = judgeArchivePassage(text, ctx, bookIsAboutSubject, datelineYear);
    return v.reason ? null : v;
  }

  // scoreArchivePassage, but saying which gate a passage failed.
  function judgeArchivePassage(text, ctx, bookIsAboutSubject, datelineYear) {
    if (text.length < IA_MIN_PASSAGE_CHARS) return { reason: 'too short' };
    if (!bookIsAboutSubject && !iaMentionsSubject(text, ctx.subjectTokens)) {
      return { reason: 'no subject' };
    }
    var query = datelineYear
      ? { names: ctx.anchors.names,
          numbers: ctx.anchors.numbers.filter(function (n) { return n !== datelineYear; }) }
      : ctx.anchors;
    var anchors = anchorScoreOf(query, text);
    var numbersMatched = query.numbers.some(function (n) {
      return anchors.matched.indexOf(n) !== -1;
    });
    if (ctx.anchors.numbers.length > 0 && !numbersMatched) return { reason: 'no claim number' };
    var cov = coverageOf(ctx.bag, text);
    var score = anchorCount(query) > 0 ? 0.6 * anchors.score + 0.4 * cov : cov;
    return { score: Math.round(score * 100) / 100, matched: anchors.matched };
  }

  function iaMentionsSubject(text, subjectTokens) {
    if (subjectTokens.length === 0) return true;
    var have = tokenSetOf(text);
    return subjectTokens.some(function (t) { return have[t]; });
  }

  function iaTitleIsAbout(title, subjectTokens) {
    if (subjectTokens.length === 0) return false;
    var have = tokenSetOf(title);
    return subjectTokens.every(function (t) { return have[t]; });
  }

  // The main title only: subtitles are catalogued on some scans and not others.
  function archiveEditionKey(title) {
    return foldText(String(title).split(/\s*[:;]\s*/)[0])
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .split(/\s+/)
      .filter(function (w) { return w && w !== 'the' && w !== 'a' && w !== 'an'; })
      .slice(0, 8)
      .join(' ');
  }

  // Same main title, and creators sharing a name — or no creator on one of
  // them. A different author under the same title is a different work.
  function iaSameWork(a, b) {
    if (archiveEditionKey(a.title) !== archiveEditionKey(b.title)) return false;
    if (!a.creator || !b.creator) return true;
    var theirs = tokenSetOf(iaCleanCreator(b.creator));
    return Object.keys(tokenSetOf(iaCleanCreator(a.creator))).some(function (t) {
      return theirs[t];
    });
  }

  // Gate, per-passage scoring, one book per work. No I/O.
  function rankArchiveHits(hits, claim, title, minScore) {
    var ctx = iaScoringContext(claim, iaSubjectOf(title));
    var rejected = {};
    var available = 0;
    var borrowable = 0;
    var scored = [];
    var stats = { seen: 0, dropped: {}, bestBelow: null };
    var drop = function (reason) { stats.dropped[reason] = (stats.dropped[reason] || 0) + 1; };
    hits.forEach(function (hit) {
      var gate = archiveGate(hit);
      if (!gate.ok) {
        rejected[gate.reason] = (rejected[gate.reason] || 0) + 1;
        return;
      }
      available++;
      if (gate.access === 'borrow') borrowable++;
      var about = iaTitleIsAbout(hit.title, ctx.subjectTokens);
      var dateline = hit.year !== null && hit.collections.indexOf('periodicals') !== -1
        ? String(hit.year) : null;
      var passages = [];
      hit.highlights.forEach(function (text) {
        stats.seen++;
        var v = judgeArchivePassage(text, ctx, about, dateline);
        if (v.reason) {
          drop(v.reason);
        } else if (v.score < minScore) {
          drop('below threshold');
          if (!stats.bestBelow || v.score > stats.bestBelow.score) {
            stats.bestBelow = { score: v.score, identifier: hit.identifier, text: text };
          }
        } else {
          passages.push({ text: text, score: v.score, matched: v.matched });
        }
      });
      passages.sort(function (a, b) { return b.score - a.score; });
      if (passages.length) {
        scored.push({ hit: hit, access: gate.access, passages: passages, score: passages[0].score });
      }
    });

    // Best first — on a tie, a book anyone can open before one to borrow — and
    // then one per work: each later scan of a work already kept is dropped.
    var openFirst = function (x) { return x.access === 'open' ? 0 : 1; };
    scored.sort(function (a, b) {
      return b.score - a.score || openFirst(a) - openFirst(b) || a.hit.rank - b.hit.rank;
    });
    var ranked = [];
    scored.forEach(function (s) {
      if (!ranked.some(function (kept) { return iaSameWork(kept.hit, s.hit); })) ranked.push(s);
    });
    return {
      ranked: ranked, available: available, borrowable: borrowable,
      rejected: rejected, matched: scored.length, passages: stats
    };
  }

  // ---- Claim units: a second ranking, and reading whole books ----------------
  // Mirrors claimUnits, unitsIn, rankByUnits, mergeRankings, streamText and
  // bestWindow in src/core/archiveSources.ts, which explain the rules.

  function iaClaimUnits(claim, subject, minWordLength, subjectUnit) {
    var subjectTokens = tokenSetOf(subject);
    var anchors = anchorsOf(claim);
    var units = [];
    iaKeyPhrases(claim, subject).map(foldText).forEach(function (k) {
      if (k.indexOf(' ') !== -1) {
        units.push({ key: k, strong: true, test: function (f) { return f.indexOf(k) !== -1; } });
      }
    });
    var known = function (key) { return units.some(function (u) { return u.key === key; }); };
    anchors.numbers.forEach(function (n) {
      if (known(n)) return;
      units.push({ key: n, strong: true, test: function (f, have) { return !!have[n] || f.indexOf(n) !== -1; } });
    });
    anchors.names.forEach(function (n) {
      if (known(n) || n.split(' ').every(function (w) { return subjectTokens[w]; })) return;
      units.push({ key: n, strong: true, test: function (f, have) {
        return n.indexOf(' ') !== -1 ? f.indexOf(n) !== -1 : !!have[n];
      } });
    });
    Object.keys(tokenSetOf(claim)).forEach(function (w) {
      if (w.length < minWordLength || subjectTokens[w] || /\d/.test(w)) return;
      if (known(w)) return;
      units.push({ key: w, strong: false, test: function (f, have) { return !!have[w]; } });
    });
    var subjectWords = Object.keys(subjectTokens);
    if (subjectUnit && subjectWords.length > 0) {
      units.push({ key: '[' + subject + ']', strong: false, test: function (f, have) {
        return subjectWords.some(function (w) { return have[w]; });
      } });
    }
    return units;
  }

  function iaUnitsIn(text, units) {
    var f = foldText(text);
    var have = tokenSetOf(text);
    var hit = units.filter(function (u) { return u.test(f, have); });
    return hit.filter(function (u) {
      return !hit.some(function (o) {
        return o !== u && o.key.indexOf(' ') !== -1 && o.key.split(' ').indexOf(u.key) !== -1;
      });
    });
  }

  // A passage must mention the subject, unless the book's title is about it.
  function rankArchiveByUnits(hits, claim, title) {
    var subject = iaSubjectOf(title);
    var subjectTokens = Object.keys(tokenSetOf(subject));
    var units = iaClaimUnits(claim, subject, 6, false);
    var out = [];
    hits.forEach(function (hit) {
      var gate = archiveGate(hit);
      if (!gate.ok) return;
      var about = iaTitleIsAbout(hit.title, subjectTokens);
      var best = null;
      hit.highlights.forEach(function (text) {
        if (!about && !iaMentionsSubject(text, subjectTokens)) return;
        var matched = iaUnitsIn(text, units);
        if (matched.length >= 2 && matched.some(function (u) { return u.strong; }) &&
            (!best || matched.length > best.matched.length)) {
          best = { text: text, matched: matched };
        }
      });
      if (!best) return;
      var score = Math.round((best.matched.length / units.length) * 100) / 100;
      out.push({
        hit: hit,
        access: gate.access,
        passages: [{ text: best.text, score: score, matched: best.matched.map(function (u) { return u.key; }) }],
        score: score
      });
    });
    return out
      .map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) {
        return b.s.passages[0].matched.length - a.s.passages[0].matched.length || a.i - b.i;
      })
      .slice(0, 3)
      .map(function (x) { return x.s; });
  }

  function mergeArchiveRankings(first, second) {
    var out = [];
    for (var i = 0; i < Math.max(first.length, second.length); i++) {
      [first[i], second[i]].forEach(function (s) {
        if (s && !out.some(function (kept) { return iaSameWork(kept.hit, s.hit); })) out.push(s);
      });
    }
    return out;
  }

  function iaStreamText(html) {
    var m = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(html);
    if (!m) return null;
    return m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/-\s*\n\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function iaBestWindow(text, claim, title) {
    var units = iaClaimUnits(claim, iaSubjectOf(title), 5, true);
    var most = units.reduce(function (n, u) { return n + (u.strong ? 2 : 1); }, 0);
    var best = null;
    var runOpen = false;
    for (var i = 0; i < text.length; i += 150) {
      var matched = iaUnitsIn(text.slice(i, i + 450), units);
      var strong = matched.filter(function (u) { return u.strong; }).length;
      var score = strong === 0 ? 0 : strong * 2 + (matched.length - strong);
      if (score >= 4 && (!best || score > best.score)) {
        best = { starts: [i], score: score, matched: matched.map(function (u) { return u.key; }) };
        runOpen = true;
      } else if (best && runOpen && score === best.score) {
        best.starts.push(i);
      } else {
        runOpen = false;
      }
    }
    if (!best) return null;
    var start = best.starts[Math.floor((best.starts.length - 1) / 2)];
    var window_ = text.slice(start, start + 450);
    if (start > 0) window_ = '…' + window_.replace(/^\S*\s+/, '');
    if (start + 450 < text.length) window_ = window_.replace(/\s+\S*$/, '') + '…';
    return {
      text: window_,
      score: Math.round((best.score / most) * 100) / 100,
      matched: best.matched.filter(function (k) { return k.charAt(0) !== '['; })
    };
  }

  function iaCleanCreator(creator) {
    return String(creator).replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?\s*$/, '').trim();
  }

  // With `book`, that book of a bundle: archive.org opens the first otherwise.
  function iaDetailsUrl(identifier, book) {
    return 'https://archive.org/details/' + encodeURIComponent(identifier) +
      (book ? '/' + encodeURIComponent(book) : '');
  }

  var IA_SEARCH_PHRASE_WORDS = 6;
  var IA_SEARCH_PHRASE_MIN_WORDS = 3;

  // Words of a passage to search the book for, quoted: three to six of them,
  // the claim's terms first, then content words, never across an ellipsis or
  // a word broken across OCR lines; a single common word ("July", "Pantheon")
  // is found on every other page. Mirrors searchPhrase.
  function iaSearchPhrase(text, terms) {
    var wanted = tokenSetOf([terms.subject].concat(terms.numbers, terms.names, terms.phrases)
      .join(' ').replace(/-/g, ' '));
    var weight = function (w) {
      return Object.keys(tokenSetOf(w.replace(/-/g, ' '))).reduce(function (n, t) {
        return n + (wanted[t] ? (/\d/.test(t) ? 2 : 1) : 0);
      }, 0);
    };
    var content = function (w) {
      return Object.keys(tokenSetOf(w.replace(/-/g, ' '))).length > 0 ? 1 : 0;
    };
    var best = null;
    String(text).split(/\.\.\.|…/).forEach(function (piece) {
      var spans = [[]];
      var raw = piece.split(/\s+/).filter(function (w) { return w.length > 0; });
      raw.forEach(function (w, i) {
        var clean = libSafeTerm(w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
        var broken = /-$/.test(w) || (i > 0 && /-$/.test(raw[i - 1]));
        if (broken || clean.indexOf(' ') !== -1) spans.push([]);
        else if (clean) spans[spans.length - 1].push(clean);
      });
      spans.forEach(function (ws) {
        var size = Math.min(IA_SEARCH_PHRASE_WORDS, ws.length);
        if (size < IA_SEARCH_PHRASE_MIN_WORDS) return;
        for (var i = 0; i + size <= ws.length; i++) {
          var run = ws.slice(i, i + size);
          var score = run.reduce(function (n, x) { return n + 3 * weight(x) + content(x); }, 0);
          if (!best || score > best.score) best = { run: run, score: score };
        }
      });
    });
    if (!best) return null;
    var out = best.run.slice();
    while (out.length > IA_SEARCH_PHRASE_MIN_WORDS && content(out[0]) === 0) out.shift();
    while (out.length > IA_SEARCH_PHRASE_MIN_WORDS && content(out[out.length - 1]) === 0) out.pop();
    return '"' + out.join(' ') + '"';
  }

  function iaViewerUrl(url, passage, terms) {
    var q = iaSearchPhrase(passage, terms) || terms.numbers[0] || terms.names[0] || terms.subject;
    return url + '?q=' + encodeURIComponent(q);
  }

  // url-access=registration for a lending-library book, as InternetArchiveBot
  // writes it: the link works, after signing in with a free account.
  // A bundle's author, publisher, year and ISBN are the item's, not the
  // book's: left for the editor to fill in.
  function formatArchiveCitation(hit, access, details, book) {
    var item = !book;
    var parts = ['title=' + escapePipes(book || hit.title)];
    if (item && hit.creator) parts.push('author=' + escapePipes(iaCleanCreator(hit.creator)));
    if (item && details && details.publisher) parts.push('publisher=' + escapePipes(details.publisher));
    if (item && hit.year !== null) parts.push('year=' + hit.year);
    if (item && details && details.isbn) parts.push('isbn=' + escapePipes(details.isbn));
    parts.push('url=' + iaDetailsUrl(hit.identifier, book));
    if (access === 'borrow') parts.push('url-access=registration');
    parts.push('via=Internet Archive');
    var template = '{{cite book |' + parts.join(' |') + '}}';
    return { template: template, ref: '<ref>' + template + '</ref>', kind: 'cite book' };
  }

  // "gustave eiffel, gustave, eiffel" → "gustave eiffel".
  function iaCompactAnchors(matched) {
    var phrases = matched.filter(function (m) { return m.indexOf(' ') !== -1; });
    return matched.filter(function (m) {
      return m.indexOf(' ') !== -1 ||
        !phrases.some(function (p) { return p.split(' ').indexOf(m) !== -1; });
    });
  }

  function toArchiveCandidate(s, details, terms, via) {
    var hit = s.hit;
    var best = s.passages[0];
    var book = iaBundledBook(hit, details);
    var url = iaDetailsUrl(hit.identifier, book);
    var matched = iaCompactAnchors(best.matched);
    var byline = [
      s.access === 'borrow' ? 'Internet Archive (borrow)' : 'Internet Archive',
      hit.year,
      hit.creator && iaCleanCreator(hit.creator)
    ].filter(Boolean).join(', ');
    var evidence = {
      origin: 'internet-archive',
      identifier: hit.identifier,
      year: hit.year,
      access: s.access,
      passages: s.passages.map(function (p) { return p.text; }),
      score: s.score,
      matchedAnchors: matched,
      query: hit.query,
      viewerUrl: iaViewerUrl(url, best.text, terms)
    };
    if (book !== null) evidence.bundle = { title: hit.title, books: details.books.length };
    if (s.fullText) evidence.fullText = true;
    if (via) evidence.via = via;
    return {
      url: url,
      title: book || hit.title,
      relevance: byline + ' — matched ' + (matched.join(', ') || 'claim wording'),
      snippet: best.text,
      evidence: evidence,
      citation: formatArchiveCitation(hit, s.access, details, book)
    };
  }

  // One lead per text: a book uploaded twice under different titles, or once
  // on its own and once bundled with others, is shown once — on its own when
  // it is. Mirrors collapseCopies.
  var IA_COPY_MIN_CHARS = 80;
  var IA_COPY_REASON = 'a copy of another lead';

  function iaCopyKey(text) {
    return foldText(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function iaSameText(a, b) {
    var theirs = Object.create(null);
    b.passages.forEach(function (p) {
      var k = iaCopyKey(p.text);
      if (k.length >= IA_COPY_MIN_CHARS) theirs[k] = true;
    });
    return a.passages.some(function (p) { return theirs[iaCopyKey(p.text)] === true; });
  }

  function iaCollapseCopies(shown, funnel) {
    var out = [];
    shown.forEach(function (x) {
      var k = -1;
      for (var i = 0; i < out.length && k === -1; i++) if (iaSameText(out[i].s, x.s)) k = i;
      if (k === -1) {
        out.push(x);
        return;
      }
      funnel.rejected[IA_COPY_REASON] = (funnel.rejected[IA_COPY_REASON] || 0) + 1;
      if (iaBundledBook(out[k].s.hit, out[k].details) !== null && iaBundledBook(x.s.hit, x.details) === null) out[k] = x;
    });
    return out;
  }

  function iaSearchUrl(query, size) {
    return IA_SEARCH_URL + '?service_backend=fts' +
      '&user_query=' + encodeURIComponent(query) +
      '&hits_per_page=' + (size || IA_MAX_HITS);
  }

  function iaFetchJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw Object.assign(new Error('Internet Archive: HTTP ' + res.status), { status: res.status });
      return res.json();
    });
  }

  // A full-text search, asked twice more, each time for one more hit, when it
  // fails with a 400: the search's backend now and then fails a query it
  // accepts, and archive.org then serves that failure for the same URL for
  // some 20 minutes. A different hits_per_page is a fresh search; the
  // failures come in bursts, so each try waits a little longer. Mirrors
  // searchWithRetry in src/core/internetArchive.ts.
  var IA_RETRY_WAITS_MS = window.cnfirmedArchiveRetryWait === 0 ? [0, 0] : [5000, 15000];

  function iaSearch(query, size) {
    size = size || IA_MAX_HITS;
    function attempt(n) {
      return iaFetchJson(iaSearchUrl(query, size + n)).catch(function (err) {
        if (err.status !== 400 || n >= IA_RETRY_WAITS_MS.length) throw err;
        return sleep(IA_RETRY_WAITS_MS[n]).then(function () { return attempt(n + 1); });
      });
    }
    return attempt(0);
  }

  // An open book's whole OCR text. archive.org does not send a CORS header on
  // this page yet, so a browser refuses to hand it over: off unless
  // window.cnfirmedArchiveFullText is set (true, or a proxy URL prefix to use
  // in place of https://archive.org/stream/).
  var IA_FULL_TEXT = window.cnfirmedArchiveFullText || false;
  var IA_FULL_TEXT_BOOKS = 5;
  var IA_FULL_TEXT_LEADS = 2;

  function iaStreamUrl(identifier, file) {
    var base = typeof IA_FULL_TEXT === 'string' ? IA_FULL_TEXT : 'https://archive.org/stream/';
    return base + encodeURIComponent(identifier) + '/' + encodeURIComponent(file) + '_djvu.txt';
  }

  function iaFetchText(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Internet Archive: HTTP ' + res.status);
      return res.text();
    });
  }

  // The full-text queries for a claim: from its numbers and names, and from
  // its key phrases. Empty when it has neither, and then the Archive stage is
  // not offered at all.
  function archiveTermsFor(index) {
    var ctx = claimContexts[index];
    if (!ctx || !ctx.claim) return null;
    return iaClaimTerms(ctx.claim, mw.config.get('wgTitle') || pageTitle);
  }

  function archiveQueryFamiliesFor(index) {
    var terms = archiveTermsFor(index);
    if (!terms) return [[], []];
    return [
      buildArchiveQueries(terms).slice(0, IA_MAX_QUERIES),
      buildPhraseQueries(terms).slice(0, IA_MAX_PHRASE_QUERIES)
    ];
  }

  function archiveQueriesFor(index) {
    var f = archiveQueryFamiliesFor(index);
    return f[0].concat(f[1]);
  }

  function findArchiveCandidates(index) {
    var ctx = claimContexts[index];
    var title = mw.config.get('wgTitle') || pageTitle;
    var terms = archiveTermsFor(index);
    var funnel = {
      queries: [], hits: 0, available: 0, borrowable: 0, rejected: {},
      matched: 0, byUnits: 0, passages: { seen: 0, dropped: {}, bestBelow: null },
      lookedUp: 0, candidates: 0, errors: []
    };

    // The librarian's model calls run while the searches below do.
    var libInput = { articleTitle: title, section: ctx.section, paragraph: ctx.context, claim: ctx.claim };
    var models = libModels();
    var planning = IA_LIBRARIAN && models.planner
      ? callWorkerModel(models.planner, LIB_PLAN_SYSTEM, libPlanPrompt(libInput), LIB_PLAN_MAX_TOKENS)
        .then(function (text) {
          var plan = libParsePlan(text);
          return { plan: plan, error: plan ? null : 'planner: no plan in the reply' };
        }, function (err) {
          return { plan: null, error: 'planner: ' + err.message };
        })
      : Promise.resolve({ plan: null, error: null });
    var naming = IA_LIBRARIAN && models.books
      ? callWorkerModel(models.books, LIB_BOOKS_SYSTEM, libBooksPrompt(libInput), LIB_BOOKS_MAX_TOKENS, LIB_BOOKS_EFFORT)
        .then(function (text) {
          return { books: libParseBooks(text), error: null };
        }, function (err) {
          return { books: [], error: 'books: ' + err.message };
        })
      : Promise.resolve({ books: [], error: null });

    // The two families side by side, each strictest first until it has enough
    // distinct books of its own.
    function searchFamily(queries) {
      var used = [];
      var found = [];
      var seen = {};
      var chain = Promise.resolve();
      queries.forEach(function (query) {
        chain = chain.then(function () {
          if (found.length >= IA_ENOUGH_HITS) return;
          used.push(query);
          return iaSearch(query)
            .catch(function (err) {
              funnel.errors.push('search failed: ' + err.message);
              return null;
            })
            .then(function (response) {
              (response ? parseArchiveHits(response, query) : []).forEach(function (hit) {
                if (seen[hit.identifier]) return;
                seen[hit.identifier] = true;
                found.push(hit);
              });
            });
        });
      });
      return chain.then(function () { return { used: used, hits: found }; });
    }

    return Promise.all(archiveQueryFamiliesFor(index).map(searchFamily)).then(function (results) {
      var hits = [];
      var seen = {};
      results.forEach(function (r) {
        funnel.queries = funnel.queries.concat(r.used);
        r.hits.forEach(function (hit) {
          if (seen[hit.identifier]) return;
          seen[hit.identifier] = true;
          var copy = Object.assign({}, hit);
          copy.rank = hits.length;
          hits.push(copy);
        });
      });
      funnel.hits = hits.length;
      var ranked = rankArchiveHits(hits, ctx.claim, title, IA_MIN_SCORE);
      var byUnits = rankArchiveByUnits(hits, ctx.claim, title);
      funnel.available = ranked.available;
      funnel.borrowable = ranked.borrowable;
      funnel.rejected = ranked.rejected;
      funnel.matched = ranked.matched;
      funnel.byUnits = byUnits.length;
      funnel.passages = ranked.passages;

      var shortlist = mergeArchiveRankings(ranked.ranked, byUnits).slice(0, IA_MAX_CANDIDATES + 2);
      var extras = [];
      var read = IA_FULL_TEXT ? readWholeBooks(hits, shortlist, extras, ctx.claim, title, funnel)
        : Promise.resolve();
      var added = [];
      return read.then(function () {
        // Metadata for the few kept: publisher, ISBN, and whether it is still
        // readable. The search's own leads are looked up while the
        // librarian's models think, so its leads are judged new against the
        // books shown.
        var shown = [];
        function lookUp(list, cap, via) {
          var added = 0;
          return list.reduce(function (p, s) {
            return p.then(function () {
              if (added >= cap) return;
              return iaFetchJson(IA_METADATA_URL + encodeURIComponent(s.hit.identifier))
                .then(function (md) {
                  var details = archiveDetailsOf(md);
                  var gate = archiveDetailsGate(details, s.access);
                  if (!gate.ok) {
                    funnel.rejected[gate.reason] = (funnel.rejected[gate.reason] || 0) + 1;
                    return;
                  }
                  shown.push({ s: s, details: details, via: via });
                  added++;
                }, function (err) {
                  funnel.errors.push('metadata ' + s.hit.identifier + ': ' + err.message);
                  shown.push({ s: s, details: null, via: via });
                  added++;
                });
            });
          }, Promise.resolve());
        }
        return lookUp(shortlist, IA_MAX_CANDIDATES)
          .then(function () { return lookUp(extras, IA_FULL_TEXT_LEADS); })
          .then(function () {
            // The librarian: the planner's books and the named ones, then a
            // search inside every lead for the claim's telling terms.
            if (!IA_LIBRARIAN) return;
            var shownLeads = shown.map(function (x) { return x.s; });
            return librarianLeads(planning, naming, terms, shownLeads, added, funnel).then(function (lib) {
              funnel.librarian = lib;
              // Planner and named leads in their order, one at a time so `via` is kept.
              var before = shown.length;
              var room = IA_LIBRARIAN_LEADS;
              return added.reduce(function (p, a) {
                return p.then(function () {
                  if (room <= 0) return;
                  var n = shown.length;
                  return lookUp([a.s], 1, a.via).then(function () { room -= shown.length - n; });
                });
              }, Promise.resolve()).then(function () {
                funnel.librarian.added = shown.length - before;
              });
            });
          })
          .then(function () {
            funnel.lookedUp = shortlist.length + extras.length + added.length;
            var candidates = iaCollapseCopies(shown, funnel).map(function (x) {
              return toArchiveCandidate(x.s, x.details, terms, x.via);
            });
            funnel.candidates = candidates.length;
            return { candidates: candidates, funnel: funnel };
          });
      });
    });
  }

  // Mirrors readWholeBooks in src/core/archiveSources.ts.
  function readWholeBooks(hits, shortlist, extras, claim, title, funnel) {
    var others = [];
    hits.forEach(function (h) {
      var gate = archiveGate(h);
      if (!gate.ok || gate.access !== 'open') return;
      if (shortlist.some(function (s) { return iaSameWork(s.hit, h); })) return;
      if (others.some(function (o) { return iaSameWork(o.hit, h); })) return;
      others.push({ hit: h, access: 'open', passages: [], score: 0 });
    });
    var toRead = shortlist.filter(function (s) { return s.access === 'open'; }).concat(others)
      .slice(0, IA_FULL_TEXT_BOOKS);
    funnel.fullText = { read: 0, windows: 0 };
    return toRead.reduce(function (p, s) {
      return p.then(function () {
        return iaFetchText(iaStreamUrl(s.hit.identifier, s.hit.file || s.hit.identifier))
          .then(iaStreamText, function (err) {
            funnel.errors.push('text ' + s.hit.identifier + ': ' + err.message);
            return null;
          })
          .then(function (text) {
            if (!text) return;
            funnel.fullText.read++;
            var w = iaBestWindow(text, claim, title);
            if (!w) return;
            funnel.fullText.windows++;
            s.passages.unshift(w);
            s.score = Math.max(s.score, w.score);
            s.fullText = true;
            if (shortlist.indexOf(s) === -1) extras.push(s);
          });
      });
    }, Promise.resolve());
  }

  function archiveFunnelLine(f) {
    var rejected = Object.keys(f.rejected).map(function (r) { return f.rejected[r] + ' ' + r; });
    return f.queries.length + ' quer' + (f.queries.length === 1 ? 'y' : 'ies') + ' → ' +
      f.hits + ' books → ' + f.available + ' readable (' + f.borrowable + ' to borrow)' +
      (rejected.length ? ' (dropped: ' + rejected.join(', ') + ')' : '') +
      ' → ' + f.matched + ' with a matching passage, ' + f.byUnits + ' by claim phrases' +
      (f.fullText ? ' → ' + f.fullText.read + ' whole text(s) read, ' + f.fullText.windows +
        ' with a passage' : '') +
      (f.librarian ? ' → ' + archiveLibrarianLine(f.librarian) : '') +
      ' → ' + f.candidates + ' lead(s)';
  }

  // "planner 3 queries, 12 books; named 4 of 6 readable; 3 term(s) searched inside; +5 lead(s)".
  function archiveLibrarianLine(l) {
    var n = l.plan ? l.plan.queries.length : 0;
    return 'planner ' + (l.plan ? n + ' quer' + (n === 1 ? 'y' : 'ies') + ', ' + l.planned + ' books' : 'gave no plan') +
      '; named ' + l.namedFound + ' of ' + l.named.length + ' readable; ' +
      l.shelfTerms.length + ' term(s) searched inside; +' + l.added + ' lead(s)';
  }

  // Why passages did or did not count. Mirrors passageSummary in
  // src/core/archiveSources.ts.
  function archivePassageSummary(p) {
    if (!p) return '';
    var dropped = Object.keys(p.dropped)
      .map(function (r) { return [r, p.dropped[r]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .map(function (e) { return e[1] + ' ' + e[0]; });
    var best = p.bestBelow
      ? ' (best below: ' + p.bestBelow.score + ' in ' + p.bestBelow.identifier + ': "' +
        p.bestBelow.text + '")'
      : '';
    return p.seen + ' passage(s)' + (dropped.length ? ' → dropped: ' + dropped.join(', ') : '') + best;
  }

  function runArchiveStage(index, retry) {
    var current = archiveState[index];
    if (current && (current.status === 'done' || (current.status === 'error' && !retry))) {
      return Promise.resolve(current);
    }
    if (current && current.promise) return current.promise;
    var ctx = claimContexts[index];
    if (!ctx || !ctx.claim) {
      archiveState[index] = { status: 'error', error: 'Could not extract a claim from the surrounding text.' };
      renderPanel(index);
      return Promise.resolve(archiveState[index]);
    }

    var entry = { status: 'running' };
    archiveState[index] = entry;
    renderPanel(index);
    entry.promise = findArchiveCandidates(index).then(function (r) {
      console.log('[CNfirmed] Internet Archive claim', index, ':', archiveFunnelLine(r.funnel),
        r.funnel, r.candidates);
      console.log('[CNfirmed] Internet Archive claim', index, 'passages:',
        archivePassageSummary(r.funnel.passages));
      archiveState[index] = { status: 'done', candidates: r.candidates, funnel: r.funnel };
      persistArchive();
      renderPanel(index);
      // The passages are checked straight away: unchecked, most of them only
      // share words with the claim.
      if (r.candidates.length) return checkArchiveStage(index);
      return archiveState[index];
    }).catch(function (err) {
      console.error('[CNfirmed] Internet Archive search failed for claim', index, ':', err);
      archiveState[index] = { status: 'error', error: (err && err.message) || String(err) };
      renderPanel(index);
      return archiveState[index];
    });
    return entry.promise;
  }

  function hydrateArchiveCache() {
    try {
      var raw = localStorage.getItem(archiveCacheKey);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') archiveState = dropPickedResults(parsed);
    } catch (e) { /* ignore */ }
  }

  function persistArchive() {
    try {
      var serialisable = {};
      Object.keys(archiveState).forEach(function (k) {
        var s = archiveState[k];
        if (s && s.status === 'done') {
          serialisable[k] = { status: 'done', candidates: s.candidates, funnel: s.funnel };
          if (s.check && s.check.status === 'done') serialisable[k].check = s.check;
        }
      });
      localStorage.setItem(archiveCacheKey, JSON.stringify(serialisable));
    } catch (e) { /* ignore */ }
  }

  // ---- Internet Archive: the librarian ------------------------------------
  // What a person does and word matching cannot: restate the claim and write
  // the queries a book would match, name the books likely to state it, search
  // inside every lead for the claim's telling terms, and check the passages
  // against the restated claim. Mirrors src/core/archiveLibrarian.ts, which
  // explains each step; the parity tests run both on the same replies.
  //
  // The models are the open-weight ones chosen in Settings (see Open-weight
  // models above), so no key is needed. Set before the script loads, to change
  // a model whichever host is chosen, or to turn its step off:
  //   window.cnfirmedArchivePlannerModel  restates the claim, writes the queries
  //   window.cnfirmedArchiveBooksModel    names books likely to state it
  //   window.cnfirmedArchiveJudgeModel    checks the passages (false: the Verify API)
  //   window.cnfirmedArchiveLibrarian = false   no planner, named books or search
  //                                             inside: the word search alone (the
  //                                             check keeps its own switch above)

  function libModel(name, fallback) {
    var v = window[name];
    if (v === false || v === null) return null;
    return typeof v === 'string' && v ? v : fallback;
  }
  var IA_LIBRARIAN = window.cnfirmedArchiveLibrarian !== false;
  // Read on every claim: the choice in Settings can change between claims.
  function libModelsFor(openModel) {
    var m = OPEN_MODELS[openModel];
    return {
      planner: libModel('cnfirmedArchivePlannerModel', m.planner),
      books: libModel('cnfirmedArchiveBooksModel', m.books),
      judge: libModel('cnfirmedArchiveJudgeModel', m.judge)
    };
  }
  function libModels() {
    return libModelsFor(getOpenModel());
  }
  // Reasoning models spend output tokens thinking before they answer.
  // Output tokens per call, thinking included. The Worker gives up on Hugging
  // Face after 60 seconds, about 8,000 tokens of GLM-5.2, and now and then the
  // model thinks until it runs out (no answer): the caps keep a call inside the
  // Worker's minute, and such a call is tried once more.
  var LIB_PLAN_MAX_TOKENS = 6000;
  var LIB_BOOKS_MAX_TOKENS = 6000;
  var LIB_JUDGE_MAX_TOKENS = 7000;
  // Naming books is recall, not reasoning: less thinking, fewer runaways.
  var LIB_BOOKS_EFFORT = 'low';
  var LIB_PARAGRAPH_CHARS = 2000;
  var LIB_PLAN_MAX_QUERIES = 3;
  var LIB_SHELF_TERMS = 3;
  var LIB_MAX_NAMED_BOOKS = 6;
  var LIB_SHELF_SIZE = 20;
  var LIB_JUDGE_BOOK_CHARS = 1600;
  var IA_PLANNER_HITS = 25;
  var IA_PLANNER_LEADS = 5;
  var IA_NAMED_ROWS = 5;
  var IA_NAMED_SCANS = 2;
  var IA_LIBRARIAN_LEADS = 8;
  var IA_CATALOGUE_URL = 'https://archive.org/advancedsearch.php';

  var LIB_PLAN_SYSTEM = [
    "You help a Wikipedia editor find a book on the Internet Archive that states a claim. Work out exactly what must be found, then the words a book would print.",
    "",
    "Reply with JSON only:",
    "{\"fact\": \"...\", \"queries\": [\"...\", \"...\", \"...\"], \"terms\": [[\"...\"], [\"...\", \"...\"]]}",
    "",
    "- fact: the claim as one self-contained sentence. Replace every pronoun and every phrase that points elsewhere (\"her mother\", \"the city\", \"his reign\", \"it\") with the name the paragraph gives.",
    "- queries: three queries for a full-text search over the OCR of millions of books. Every space-separated term must appear in the book; put a multi-word term in double quotes. No OR, AND, NEAR or wildcards. Two or three terms each: a name as a book would print it, the specific number or date, one distinctive word. Not Wikipedia's wording, and never a whole clause. Most specific first.",
    "- terms: the three to six things a passage stating the claim must mention, each a list of the ways a book might write it, numbers and names first. The person or thing the claim is about is one of them, by name.",
    "",
    "Take every name, number and date from the paragraph and the claim; do not add any from memory.",
    "",
    "Example 1. Article: Mary Shelley. Paragraph: \"Mary Shelley was born in London on 30 August 1797 to the philosopher William Godwin and the writer Mary Wollstonecraft. Her mother died eleven days after the birth.\" Claim: \"Her mother died eleven days after the birth.\"",
    "{\"fact\": \"Mary Wollstonecraft, the mother of Mary Shelley, died eleven days after Mary's birth in 1797.\", \"queries\": [\"Wollstonecraft died 1797\", \"Wollstonecraft \\\"eleven days\\\" daughter\", \"\\\"Mary Wollstonecraft\\\" death September 1797\"], \"terms\": [[\"1797\"], [\"Wollstonecraft\"], [\"died\", \"death\"], [\"eleven days\", \"11 days\"], [\"daughter\", \"Mary\"]]}",
    "",
    "Example 2. Article: Golden Gate Bridge. Paragraph: \"Joseph Strauss led the design. The bridge opened to vehicle traffic on 28 May 1937, a day after its pedestrian opening.\" Claim: \"The bridge opened to vehicle traffic on 28 May 1937.\"",
    "{\"fact\": \"The Golden Gate Bridge opened to vehicle traffic on 28 May 1937.\", \"queries\": [\"\\\"Golden Gate Bridge\\\" 1937 traffic\", \"\\\"Golden Gate\\\" \\\"May 28\\\" opened\", \"\\\"Golden Gate\\\" 1937 automobiles\"], \"terms\": [[\"1937\"], [\"Golden Gate\"], [\"May 28\", \"28 May\", \"28th of May\"], [\"opened\", \"opening\", \"dedicated\"], [\"traffic\", \"vehicles\", \"automobiles\", \"cars\"]]}"
  ].join('\n');

  var LIB_BOOKS_SYSTEM = [
    "You are a reference librarian. A Wikipedia editor needs a published book that states a claim. Name the books most likely to state it: standard biographies, histories, monographs and reference works on the subject, older public-domain works included. Only books you are sure exist; a wrong title wastes a search.",
    "",
    "Reply with JSON only: {\"books\": [{\"title\": \"the book's title\", \"author\": \"the first author's surname\", \"year\": 1900}]}, up to six, most likely first."
  ].join('\n');

  var LIB_JUDGE_SYSTEM = [
    "You decide, for each book, whether its passages state a claim from a Wikipedia article. The passages are OCR text from scans: noisy, and cut mid-sentence.",
    "",
    "- \"supports\": the book's passages state the claim's fact, with its specific content (who, what, and any number or date).",
    "- \"partial\": they state a substantial part of what the claim asserts (the event but not the date, or one of two facts), enough to cite for that part.",
    "- \"no\": they are only about the same topic, use the same names or numbers in a different statement, only confirm a background detail of the claim (where a place is, who someone was), or are unrelated.",
    "",
    "Be strict: shared words are not support. Judge each book only on its own passages, not on what it probably says elsewhere and not on another book's passages. A book may name a person or place differently from the article (a title instead of a name, another spelling or language); use what you know to connect them.",
    "",
    "For \"supports\" and \"partial\", quote the words in that book's passages that state it, exactly as written.",
    "",
    "Reply with JSON only: {\"books\": [{\"id\": \"B1\", \"verdict\": \"supports\", \"quote\": \"...\", \"why\": \"one short sentence\"}]}, one entry per book, in order."
  ].join('\n');

  // The Worker allows 20 requests a minute per address: this page stays under
  // 18, and waits out a 429 or a 5xx a few times (10, 20, then 40 seconds).
  var WORKER_PER_MINUTE = 18;
  var WORKER_RETRIES = 3;
  var WORKER_RETRY_WAIT_MS = 10000;
  var workerCalls = [];

  function workerTurn() {
    var now = Date.now();
    workerCalls = workerCalls.filter(function (t) { return now - t < 60000; });
    if (workerCalls.length < WORKER_PER_MINUTE) {
      workerCalls.push(now);
      return Promise.resolve();
    }
    return sleep(workerCalls[0] + 60000 - now).then(workerTurn);
  }

  function workerRequestBody(model, system, user, maxTokens, effort) {
    var body = {
      model: model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    };
    if (effort) body.reasoning_effort = effort;
    return JSON.stringify(body);
  }

  // One chat completion on the host that serves the model (the Worker's /hf
  // route, or llm-router's /liftwing): the reply text. `effort` is sent as
  // reasoning_effort.
  function callWorkerModel(model, system, user, maxTokens, effort, attempt) {
    attempt = attempt || 0;
    return workerTurn().then(function () {
      return fetch(openModelUrl(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: workerRequestBody(model, system, user, maxTokens, effort)
      });
    }).then(function (res) {
      return res.text().then(function (text) {
        if (workerShouldRetry(res.status, text, attempt)) {
          return sleep(WORKER_RETRY_WAIT_MS * Math.pow(2, attempt)).then(function () {
            return callWorkerModel(model, system, user, maxTokens, effort, attempt + 1);
          });
        }
        return workerReplyText(res.status, text);
      });
    });
  }

  // A 429, up to three times; a 5xx (the Worker's own minute ran out) or a
  // reply with no answer, once.
  function workerShouldRetry(status, text, attempt) {
    if (status === 429) return attempt < WORKER_RETRIES;
    if (status >= 500) return attempt < 1;
    return status >= 200 && status < 300 && workerReplyContent(text) === null && attempt < 1;
  }

  function workerParseReply(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // A chat-completions reply's message content, or null when it has none.
  function workerReplyContent(text) {
    var data = workerParseReply(text);
    var content = data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content;
    return typeof content === 'string' && content.trim() ? content : null;
  }

  function workerReplyText(status, text) {
    if (status < 200 || status >= 300) {
      var data = workerParseReply(text);
      var err = data && data.error;
      var message = (err && typeof err === 'object' ? err.message : err) || String(text).slice(0, 200);
      throw new Error('Worker ' + status + ': ' + String(message));
    }
    var content = workerReplyContent(text);
    if (content === null) throw new Error('Worker: empty reply');
    return content;
  }

  // Characters the full-text search's parser rejects or reads as syntax. A "/"
  // starts a regular expression even inside quotes, "~" is proximity, "[" and
  // "]" a range: each fails the query with HTTP 400, as does an unbalanced
  // quote. ":" and the brackets name fields and groups.
  var LIB_QUERY_SYNTAX = /[/\\~[\]{}^*?:()!+&|<>=]/g;

  // A term for a quoted phrase: no quotes and none of the parser's syntax.
  function libSafeTerm(term) {
    return String(term == null ? '' : term).replace(LIB_QUERY_SYNTAX, ' ').replace(/"/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // A model's query the parser accepts: no syntax characters, quotes
  // balanced, no term starting with "-".
  function libSafeQuery(query) {
    var q = String(query == null ? '' : query).replace(LIB_QUERY_SYNTAX, ' ');
    if ((q.match(/"/g) || []).length % 2) q = q.replace(/"/g, ' ');
    return q
      .replace(/"([^"]*)"/g, function (_, inner) { return inner.trim() ? '"' + inner.trim() + '"' : ' '; })
      .replace(/(^|\s)-+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // The first JSON object in a reply, whatever surrounds it.
  function libJsonObjectIn(text) {
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      var v = JSON.parse(text.slice(start, end + 1));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  function libClip(text, chars) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return t.length > chars ? t.slice(0, chars) + '…' : t;
  }

  function libArticleName(title) {
    return String(title).replace(/_/g, ' ');
  }

  function libUnique(list) {
    return list.filter(function (x, i) { return list.indexOf(x) === i; });
  }

  // 1. Plan: the restated claim, the queries a book would match, and what a
  // passage stating the claim must mention.
  function libPlanPrompt(c) {
    return 'Article: ' + libArticleName(c.articleTitle) + '\n' +
      'Section: ' + (c.section || '(lead)') + '\n' +
      'Paragraph: ' + libClip(c.paragraph, LIB_PARAGRAPH_CHARS) + '\n\n' +
      'Claim: ' + c.claim;
  }

  function libStrings(v) {
    if (!Array.isArray(v)) return [];
    return v.flat(3)
      .filter(function (x) { return typeof x === 'string' || typeof x === 'number'; })
      .map(String);
  }

  // Small models nest a term list one level too deep, or give a query as an
  // array; both are read.
  function libParsePlan(text) {
    var j = libJsonObjectIn(text);
    if (!j) return null;
    var fact = typeof j.fact === 'string' ? j.fact.replace(/\s+/g, ' ').trim() : '';
    var queries = (Array.isArray(j.queries) ? j.queries : [])
      .map(function (q) { return Array.isArray(q) ? libStrings(q).join(' ') : typeof q === 'string' ? q : ''; })
      .map(libSafeQuery)
      .filter(function (q) { return q.length >= 3; });
    var terms = (Array.isArray(j.terms) ? j.terms : [])
      .map(function (g) { return Array.isArray(g) ? libStrings(g) : libStrings([g]); })
      .map(function (g) {
        return libUnique(g.map(function (x) { return x.replace(/\s+/g, ' ').trim(); })
          .filter(function (x) { return x.length >= 2; }));
      })
      .filter(function (g) { return g.length > 0; });
    if (!queries.length && !terms.length) return null;
    return { fact: fact, queries: libUnique(queries).slice(0, LIB_PLAN_MAX_QUERIES), terms: terms.slice(0, 6) };
  }

  // A number, then a name, then anything else.
  function libSpecificity(group) {
    if (group.some(function (a) { return /\d/.test(a); })) return 0;
    if (group.some(function (a) { return /^\p{Lu}/u.test(a.trim()); })) return 1;
    return 2;
  }

  // The terms every lead is searched inside for: the plan's most telling
  // concepts, or without a plan the claim's numbers, names and key phrases.
  function libTellingTerms(plan, terms) {
    var out = [];
    function add(t) {
      var v = libSafeTerm(t);
      if (v.length >= 2 && !out.some(function (o) { return foldText(o) === foldText(v); })) out.push(v);
    }
    if (plan && plan.terms.length) {
      plan.terms.map(function (g, i) { return { g: g, i: i }; })
        .sort(function (a, b) { return libSpecificity(a.g) - libSpecificity(b.g) || a.i - b.i; })
        .forEach(function (x) { add(x.g[0]); });
    } else {
      terms.numbers.concat(terms.names, terms.phrases).forEach(add);
    }
    return out.slice(0, LIB_SHELF_TERMS);
  }

  function libNameConcepts(terms) {
    return terms.filter(function (g) { return libSpecificity(g) === 1; });
  }

  // Folded words, hyphens as spaces: "Saxe-Coburg-Gotha" holds "Saxe-Coburg".
  function libSplitKey(text) {
    return foldText(String(text == null ? '' : text)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  // A passage's words two ways, padded: hyphenation joined ("com- pleted"),
  // and hyphens as spaces.
  function libWordingsOf(text) {
    return { joined: ' ' + libQuoteKey(text) + ' ', split: ' ' + libSplitKey(text) + ' ' };
  }

  function libWordsIn(padded, words) {
    if (!words) return false;
    if (padded.indexOf(' ' + words + ' ') !== -1) return true;
    return /\p{L}$/u.test(words) &&
      (padded.indexOf(' ' + words + 's ') !== -1 || padded.indexOf(' ' + words + 'es ') !== -1);
  }

  // Whether a concept's wording is in a passage as whole words, a plural
  // allowed: "23" is not in "1923", nor "Carl" in "Carlisle".
  function libMentions(t, alt) {
    return libWordsIn(t.joined, libQuoteKey(alt)) || libWordsIn(t.split, libSplitKey(alt));
  }

  function libPlanCoverage(text, terms) {
    var t = libWordingsOf(text);
    return terms.filter(function (alts) {
      return alts.some(function (a) { return libMentions(t, a); });
    }).length;
  }

  function libPlanMatched(text, terms) {
    var t = libWordingsOf(text);
    return terms.filter(function (alts) {
      return alts.some(function (a) { return libMentions(t, a); });
    }).map(function (alts) { return foldText(alts[0]); });
  }

  // 2. Name books likely to state the fact.
  function libBooksPrompt(c) {
    return 'Article: ' + libArticleName(c.articleTitle) + '\nParagraph: ' +
      libClip(c.paragraph, LIB_PARAGRAPH_CHARS) + '\n\nClaim: ' + c.claim;
  }

  function libParseBooks(text) {
    var j = libJsonObjectIn(text);
    var list = j && Array.isArray(j.books) ? j.books : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || typeof b !== 'object') continue;
      var title = typeof b.title === 'string' ? b.title.replace(/\s+/g, ' ').trim() : '';
      if (title.length < 3) continue;
      var author = typeof b.author === 'string' && b.author.trim() ? b.author.replace(/\s+/g, ' ').trim() : null;
      var year = Number.parseInt(String(b.year == null ? '' : b.year), 10);
      out.push({ title: title, author: author, year: Number.isFinite(year) ? year : null });
      if (out.length >= LIB_MAX_NAMED_BOOKS) break;
    }
    return out;
  }

  // A named book's catalogue search: the title's longer words and the
  // author's surname.
  // Short title words a catalogue search does without.
  var LIB_TITLE_STOPWORDS = ('the and for its his her our are was who how why les des der die das und ' +
    'von del los las une con per').split(' ');

  function libCatalogueQuery(book) {
    var words = book.title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
      .filter(function (w) { return w.length >= 3 && LIB_TITLE_STOPWORDS.indexOf(w.toLowerCase()) === -1; })
      .slice(0, 5);
    if (!words.length) return null;
    var surname = (String(book.author || '').trim().split(/\s+/).pop() || '')
      .replace(/[\u2018\u2019`]/g, "'")
      .replace(/[^\p{L}'-]/gu, '')
      .replace(/^'+|'+$/g, '');
    return 'title:(' + words.join(' AND ') + ')' + (surname.length > 2 ? ' AND creator:(' + surname + ')' : '');
  }

  // Mirrors catalogueUrl in src/core/internetArchive.ts.
  function iaCatalogueUrl(query, rows) {
    var fields = ['identifier', 'title', 'creator', 'year', 'date', 'collection', 'mediatype']
      .map(function (f) { return '&fl[]=' + f; }).join('');
    return IA_CATALOGUE_URL + '?q=' + encodeURIComponent('(' + query + ') AND mediatype:texts') +
      fields + '&rows=' + rows + '&output=json';
  }

  function parseCatalogueHits(response, query) {
    var raw = (response && response.response && response.response.docs) || [];
    var out = [];
    raw.forEach(function (d, rank) {
      if (!d || typeof d !== 'object') return;
      var identifier = iaFirst(d.identifier);
      if (!identifier) return;
      var year = iaYearOf(d.year);
      out.push({
        identifier: identifier,
        title: iaFirst(d.title) || identifier,
        creator: iaFirst(d.creator),
        year: year !== null ? year : iaYearOf(d.date),
        mediatype: iaFirst(d.mediatype),
        collections: iaAll(d.collection),
        file: null,
        highlights: [],
        rank: rank,
        query: query
      });
    });
    return out;
  }

  // 3. Search inside the shortlist. An identifier with a dot (the Digital
  // Library of India's) is never matched by identifier:, and one left
  // unquoted empties the whole query.
  function libShelfSearchable(identifier) {
    return identifier.indexOf('.') === -1;
  }

  function libShelfQueries(term, identifiers) {
    var ids = identifiers.filter(libShelfSearchable);
    var out = [];
    for (var i = 0; i < ids.length; i += LIB_SHELF_SIZE) {
      var shelf = ids.slice(i, i + LIB_SHELF_SIZE);
      out.push({
        query: '"' + term + '" identifier:(' + shelf.map(function (id) { return '"' + id + '"'; }).join(' OR ') + ')',
        size: shelf.length
      });
    }
    return out;
  }

  // The planner's hits, one per book, best covered first; a book must be about
  // the claim (two concepts in one passage, and one of its names when the plan
  // has any). Mirrors rankPlannedHits in src/core/archiveSources.ts.
  // A plan with fewer than two concepts cannot tell, and adds no book. A book
  // found by several queries is judged on all its highlights together.
  function rankPlannedHits(lists, terms) {
    if (terms.length < 2) return [];
    var names = libNameConcepts(terms);
    var byId = Object.create(null);
    var books = [];
    for (var i = 0; lists.some(function (l) { return i < l.length; }); i++) {
      for (var k = 0; k < lists.length; k++) {
        var h = lists[k][i];
        if (!h) continue;
        var known = byId[h.identifier];
        if (!known) {
          known = byId[h.identifier] = Object.assign({}, h, { highlights: h.highlights.slice() });
          books.push(known);
          continue;
        }
        h.highlights.forEach(function (t) { if (known.highlights.indexOf(t) === -1) known.highlights.push(t); });
      }
    }
    var out = [];
    books.forEach(function (h) {
      var gate = archiveGate(h);
      if (!gate.ok || !h.highlights.length) return;
      var passages = h.highlights.map(function (text) {
        return { text: text, score: 0, matched: libPlanMatched(text, terms) };
      }).sort(function (a, b) { return b.matched.length - a.matched.length; });
      if (passages[0].matched.length < 2) return;
      if (names.length && libPlanCoverage(h.highlights.join(' '), names) === 0) return;
      var cover = libPlanCoverage(h.highlights.join(' '), terms);
      var score = Math.round((cover / terms.length) * 100) / 100;
      out.push({ s: { hit: h, access: gate.access, passages: passages, score: score }, cover: cover, order: out.length });
    });
    return out.sort(function (a, b) { return b.cover - a.cover || a.order - b.order; })
      .map(function (x) { return x.s; });
  }

  // The librarian's leads, added to `added`, and every lead's passages extended
  // by a search inside it for the claim's telling terms. Mirrors librarianLeads
  // in src/core/archiveSources.ts: failures are noted in the funnel, in the
  // same order, and never fail the stage.
  function librarianLeads(planning, naming, terms, shortlist, added, funnel) {
    return Promise.all([planning, naming]).then(function (r) {
      var plan = r[0].plan;
      var named = r[1].books;
      if (r[0].error) funnel.errors.push(r[0].error);
      if (r[1].error) funnel.errors.push(r[1].error);
      var lib = { plan: plan, planned: 0, named: named, namedFound: 0, shelfTerms: [], shelfQueries: 0, added: 0 };
      var concepts = plan ? plan.terms : [];

      var searching = Promise.all((plan ? plan.queries : []).map(function (query) {
        return iaSearch(query, IA_PLANNER_HITS).then(function (response) {
          return { hits: parseArchiveHits(response, query), error: null };
        }, function (err) {
          return { hits: [], error: 'search failed: ' + err.message };
        });
      }));
      var finding = Promise.all(named.map(function (book) {
        var q = libCatalogueQuery(book);
        if (!q) return { scans: [], error: null };
        return iaFetchJson(iaCatalogueUrl(q, IA_NAMED_ROWS)).then(function (response) {
          return {
            scans: parseCatalogueHits(response, q).filter(function (h) {
              return archiveGate(h).ok && libShelfSearchable(h.identifier);
            }).slice(0, IA_NAMED_SCANS),
            error: null
          };
        }, function (err) {
          return { scans: [], error: 'catalogue: ' + err.message };
        });
      }));

      return Promise.all([searching, finding]).then(function (rs) {
        var lists = rs[0];
        var found = rs[1];
        lists.forEach(function (l) { if (l.error) funnel.errors.push(l.error); });
        var planned = rankPlannedHits(lists.map(function (l) { return l.hits; }), concepts);
        lib.planned = planned.length;
        found.forEach(function (f) { if (f.error) funnel.errors.push(f.error); });
        lib.namedFound = found.filter(function (f) { return f.scans.length > 0; }).length;

        // One lead per work, beyond the search's own. A planner hit on a book
        // already shown adds its passages to it.
        var taken = shortlist.map(function (s) { return s.hit; });
        function isNew(h) {
          return !taken.some(function (t) { return t.identifier === h.identifier || iaSameWork(t, h); });
        }
        function addPassages(s, texts) {
          var known = Object.create(null);
          s.passages.forEach(function (p) { known[p.text] = true; });
          texts.forEach(function (text) {
            if (known[text]) return;
            known[text] = true;
            s.passages.push({ text: text, score: 0, matched: libPlanMatched(text, concepts) });
          });
        }
        var fromPlanner = 0;
        for (var i = 0; i < planned.length; i++) {
          var same = shortlist.filter(function (x) { return x.hit.identifier === planned[i].hit.identifier; })[0];
          if (same) addPassages(same, planned[i].passages.map(function (p) { return p.text; }));
          if (fromPlanner >= IA_PLANNER_LEADS) continue;
          if (!isNew(planned[i].hit)) continue;
          added.push({ s: planned[i], via: 'planner' });
          taken.push(planned[i].hit);
          fromPlanner++;
        }
        // Each named book's scans as one group: after the search inside, the
        // first scan with a passage stands for the book.
        found.forEach(function (f, g) {
          var scans = f.scans.filter(isNew);
          scans.forEach(function (h) {
            var gate = archiveGate(h);
            if (!gate.ok) return;
            added.push({ s: { hit: h, access: gate.access, passages: [], score: 0 }, via: 'named', group: g });
          });
          taken = taken.concat(scans);
        });

        // Search inside every lead, one query per telling term.
        var everyone = shortlist.concat(added.map(function (x) { return x.s; }));
        lib.shelfTerms = libTellingTerms(plan, terms);
        var ids = everyone.map(function (s) { return s.hit.identifier; });
        var shelf = [];
        lib.shelfTerms.forEach(function (t) { shelf = shelf.concat(libShelfQueries(t, ids)); });
        lib.shelfQueries = shelf.length;
        return Promise.all(shelf.map(function (q) {
          return iaSearch(q.query, q.size).then(function (response) {
            return { hits: parseArchiveHits(response, q.query), error: null };
          }, function (err) {
            return { hits: [], error: 'shelf search failed: ' + err.message };
          });
        })).then(function (replies) {
          var inside = Object.create(null);
          replies.forEach(function (rep) {
            if (rep.error) funnel.errors.push(rep.error);
            rep.hits.forEach(function (h) {
              inside[h.identifier] = (inside[h.identifier] || []).concat([h]);
            });
          });
          everyone.forEach(function (s) {
            var hits = inside[s.hit.identifier] || [];
            // An item can bundle several books: only the lead's own book
            // counts. A lead from the catalogue does not know its book until now.
            if (s.hit.file === null) {
              var withFile = hits.filter(function (h) { return h.file !== null; })[0];
              s.hit.file = withFile ? withFile.file : null;
            }
            addPassages(s, hits.filter(function (h) { return h.file === null || h.file === s.hit.file; })
              .reduce(function (acc, h) { return acc.concat(h.highlights); }, []));
          });
          // The librarian's leads show their best-covered passage first; one
          // with no passage has nothing to show or check, and a named book
          // needs only one scan.
          var kept = Object.create(null);
          for (var k = 0; k < added.length; k++) {
            var s = added[k].s;
            var group = added[k].group;
            if (!s.passages.length || (group !== undefined && kept[group])) {
              added.splice(k--, 1);
              continue;
            }
            if (group !== undefined) kept[group] = true;
            s.passages.sort(function (x, y) { return y.matched.length - x.matched.length; });
            if (concepts.length) {
              var cover = libPlanCoverage(s.passages.map(function (p) { return p.text; }).join(' '), concepts);
              s.score = Math.max(s.score, Math.round((cover / concepts.length) * 100) / 100);
            }
          }
          return lib;
        });
      });
    });
  }

  // 4. Check: every book's passages against the claim, in one call.
  function libJudgePrompt(c, books) {
    var head = 'Article: ' + libArticleName(c.articleTitle) + '\n' +
      'Claim: ' + c.claim + '\n' +
      (c.fact && c.fact !== c.claim ? 'What the claim says, with the names its paragraph gives: ' + c.fact + '\n' : '') +
      "The claim's paragraph, for context only: " + libClip(c.paragraph, 1200) + '\n';
    var list = books.map(function (b, i) {
      var used = 0;
      var lines = [];
      for (var k = 0; k < b.passages.length; k++) {
        var t = libClip(b.passages[k], 600);
        if (used + t.length > LIB_JUDGE_BOOK_CHARS && lines.length) break;
        lines.push('- ' + t);
        used += t.length;
      }
      return 'B' + (i + 1) + '. ' + libClip(b.title, 160) + (b.year ? ' (' + b.year + ')' : '') + '\n' +
        (lines.join('\n') || '- (no passage)');
    });
    return head + '\n' + list.join('\n\n');
  }

  // Folded, hyphenation joined, punctuation dropped: how a quote is looked for
  // in OCR text.
  function libQuoteKey(text) {
    return foldText(String(text == null ? '' : text))
      .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  // A quote counts when every piece of it between ellipses is in the passages,
  // three words at least: a model that cannot point at the words has not read
  // them.
  function libQuoteInPassages(quote, passages) {
    var pieces = String(quote == null ? '' : quote)
      .split(/\.\.\.|…|\[\s*\.\.\.\s*\]/)
      .map(libQuoteKey)
      .filter(function (p) { return p.length > 0; });
    if (!pieces.length) return false;
    if (pieces.join(' ').split(' ').length < 3) return false;
    // Compared without spaces: "Saxe- Coburg" broken across OCR lines is
    // "Saxe-Coburg" in the quote, and "Saxe Coburg" if the model drops the hyphen.
    var hay = passages.map(libQuoteKey).join(' ').replace(/ /g, '');
    return pieces.every(function (p) { return hay.indexOf(p.replace(/ /g, '')) !== -1; });
  }

  // A verdict per book, in order (null where the reply gives none). A
  // "supports" or "partial" whose quote is not in that book's passages counts
  // as not stating the claim.
  function libParseJudgement(text, books) {
    var j = libJsonObjectIn(text);
    var list = j && Array.isArray(j.books) ? j.books : null;
    if (!list) throw new Error('check: the model gave no verdicts');
    var byId = Object.create(null);
    list.forEach(function (e, i) {
      if (!e || typeof e !== 'object') return;
      var id = String(e.id == null ? 'B' + (i + 1) : e.id).trim().toUpperCase();
      if (!byId[id]) byId[id] = e;
    });
    return books.map(function (b, i) {
      var r = byId['B' + (i + 1)];
      if (!r) return null;
      var v = String(r.verdict == null ? '' : r.verdict).trim().toLowerCase();
      var reason = typeof r.why === 'string' ? r.why.trim() : '';
      var quote = typeof r.quote === 'string' ? r.quote.trim() : '';
      if (v === 'no' || v === 'unsupported') return { verdict: 'unsupported', quote: '', reason: reason };
      if (v !== 'supports' && v !== 'partial') return null;
      if (!libQuoteInPassages(quote, b.passages)) {
        return { verdict: 'unsupported', quote: '', reason: ('Not counted: its quote is not in the passages. ' + reason).trim() };
      }
      return { verdict: v, quote: quote, reason: reason };
    });
  }

  // ---- Checking the Archive passages against the claim ------------------
  // The search matches words, and most passages that share a claim's words do
  // not say what it says. Every lead's passages go to the judge model in one
  // call, with the restated claim (above, step 4); a verdict counts only when
  // its quote is in the passages. With no judge model, or when the call fails,
  // each lead goes to the Verify API instead (POST /v1/verify,
  // alex-o-748/citation-checker-script's docs/verify-api.md), the benchmarked
  // claim-vs-source check the citation-checker userscript runs, also with the
  // restated claim. Neither needs a key, so the check runs whenever the search
  // finds leads. Override the Verify API host with window.cnfirmedVerifyUrl.

  var VERIFY_API_BASE = String(window.cnfirmedVerifyUrl || 'https://citation-verifier.toolforge.org')
    .replace(/\/+$/, '');
  // The service's budget is 30 requests/minute across all callers; a 429 is
  // waited out a few times rather than failing the check.
  var VERIFY_MAX_RETRIES = 3;
  var VERIFY_MAX_WAIT_S = 60;

  // 'unsupported' is the Verify API's NOT SUPPORTED. The older 'topic' and
  // 'unrelated' split came from the model prompt this replaced; they stay so
  // checks cached before the switch still render.
  var ARCHIVE_VERDICTS = ['supports', 'partial', 'unsupported', 'topic', 'unrelated'];
  var VERIFY_TO_ARCHIVE = {
    'SUPPORTED': 'supports',
    'PARTIALLY SUPPORTED': 'partial',
    'NOT SUPPORTED': 'unsupported'
  };

  // What the Verify API reads as the source: the book's passages, one per
  // line. Title and year are left out so they are never taken as evidence.
  function archiveSourceContent(candidate) {
    return candidate.evidence.passages.join('\n');
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // One Verify API call. Resolves to the API's JSON body, or null when the
  // source is unusable (422); rejects on any other failure.
  function callVerifyApi(claim, sourceContent, attempt) {
    attempt = attempt || 0;
    return fetch(VERIFY_API_BASE + '/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim: claim, source_content: sourceContent })
    }).then(function (res) {
      if (res.status === 429 && attempt < VERIFY_MAX_RETRIES) {
        var wait = Number(res.headers.get('Retry-After'));
        wait = wait > 0 ? Math.min(wait, VERIFY_MAX_WAIT_S) : 10;
        return sleep(wait * 1000).then(function () {
          return callVerifyApi(claim, sourceContent, attempt + 1);
        });
      }
      return res.text().then(function (t) {
        var data;
        try { data = JSON.parse(t); } catch (e) { data = null; }
        if (res.ok && data) return data;
        if (res.status === 422) return null;
        throw new Error('Verify API ' + res.status + ': ' +
          ((data && data.error) || truncate(t, 200)));
      });
    });
  }

  // The API's answer as a lead's verdict; null (unchecked) when it gave none
  // this script knows, or judged the source unavailable.
  function toArchiveVerdict(result) {
    var verdict = result && VERIFY_TO_ARCHIVE[String(result.verdict || '').trim().toUpperCase()];
    if (!verdict) return null;
    return {
      verdict: verdict,
      // verified_text, never source_quote: only it is known to be in the passages.
      quote: result.verified_text || '',
      reason: result.comments || ''
    };
  }

  // One Verify API call per lead, one after another, to go easy on the shared
  // budget. A verdict per candidate, in order. `claim` is the restated claim
  // when the planner gave one.
  function checkArchiveCandidates(ctx, candidates, claim) {
    var out = [];
    return candidates.reduce(function (chain, c) {
      return chain.then(function () {
        return callVerifyApi(claim || ctx.claim, archiveSourceContent(c)).then(function (r) {
          out.push(toArchiveVerdict(r));
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  // The check of a claim's leads: the judge model in one call, or the Verify
  // API when there is none or the call fails. Resolves to the verdicts, in
  // order, and what gave them.
  function checkArchiveLeads(ctx, plan, candidates) {
    var fact = plan && plan.fact ? plan.fact : null;
    function viaVerifyApi() {
      return checkArchiveCandidates(ctx, candidates, fact).then(function (verdicts) {
        return { verdicts: verdicts, by: 'verify-api' };
      });
    }
    var judge = libModels().judge;
    if (!judge) return viaVerifyApi();
    var books = candidates.map(function (c) {
      return { title: c.title, year: c.evidence.year, passages: c.evidence.passages };
    });
    var input = {
      articleTitle: mw.config.get('wgTitle') || pageTitle,
      section: ctx.section,
      paragraph: ctx.context,
      claim: ctx.claim,
      fact: fact
    };
    return callWorkerModel(judge, LIB_JUDGE_SYSTEM, libJudgePrompt(input, books), LIB_JUDGE_MAX_TOKENS)
      .then(function (text) {
        return { verdicts: libParseJudgement(text, books), by: judge };
      })
      .catch(function (err) {
        console.warn('[CNfirmed] the judge model failed; checking with the Verify API instead:', err);
        return viaVerifyApi();
      });
  }

  function archiveCheckWanted(verdict) {
    return verdict === 'supports' || verdict === 'partial';
  }

  // Runs the check for a claim whose Archive search is done, and keeps the
  // verdicts on its candidates.
  function checkArchiveStage(index) {
    var a = archiveState[index];
    if (!a || a.status !== 'done' || !(a.candidates || []).length) return Promise.resolve(a);
    if (a.checking) return a.checking;
    a.check = { status: 'running' };
    renderPanel(index);
    var plan = a.funnel && a.funnel.librarian ? a.funnel.librarian.plan : null;
    a.checking = checkArchiveLeads(claimContexts[index], plan, a.candidates)
      .then(function (r) {
        a.candidates.forEach(function (c, k) { c.check = r.verdicts[k]; });
        a.check = { status: 'done', by: r.by };
        console.log('[CNfirmed] Internet Archive claim', index, 'checked by', r.by + ':',
          r.verdicts.map(function (v) { return v ? v.verdict : 'none'; }).join(', '));
      }, function (err) {
        console.error('[CNfirmed] Internet Archive check failed for claim', index, ':', err);
        a.check = { status: 'error', error: (err && err.message) || String(err) };
      }).then(function () {
        delete a.checking;
        persistArchive();
        renderPanel(index);
        return a;
      });
    return a.checking;
  }

  // ---- Provider implementations -----------------------------------------

  function buildUserMessage(ctx) {
    return 'Claim: ' + ctx.claim + '\n\n' +
      'Context: ' + ctx.context + '\n\n' +
      'Section: ' + (ctx.section || '(none)') + '\n\n' +
      'Article: ' + pageTitle.replace(/_/g, ' ');
  }

  // A long server-side search turn can stop with pause_turn; it is resumed by
  // sending the partial assistant turn back, a few times at most.
  var CLAUDE_MAX_CONTINUATIONS = 3;

  function callClaude(ctx, apiKey) {
    var userMessage = { role: 'user', content: buildUserMessage(ctx) };
    var blocks = [];

    function request(messages, continuations) {
      var body = {
        model: modelFor('claude'),
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: [
          { type: searchToolFor('claude'), name: 'web_search', max_uses: 6 }
        ],
        messages: messages
      };
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.text().then(function (t) {
          if (!res.ok) throw new Error('Claude API ' + res.status + ': ' + truncate(t, 200));
          var data = JSON.parse(t);
          blocks = blocks.concat(data.content || []);
          if (data.stop_reason === 'pause_turn' && continuations < CLAUDE_MAX_CONTINUATIONS) {
            return request([userMessage, { role: 'assistant', content: blocks }],
              continuations + 1);
          }
          return parseSuggestions(blocks
            .filter(function (b) { return b && b.type === 'text'; })
            .map(function (b) { return b.text; })
            .join('\n'));
        });
      });
    }

    return request([userMessage], 0);
  }

  function callGemini(ctx, apiKey) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(modelFor('gemini')) + ':generateContent?key=' +
      encodeURIComponent(apiKey);
    var body = {
      contents: [{ parts: [{ text: buildUserMessage(ctx) }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { maxOutputTokens: 4096, temperature: 0 },
      tools: [{ googleSearch: {} }, { urlContext: {} }]
    };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (t) {
        var data;
        try { data = JSON.parse(t); } catch (e) { data = null; }
        if (!res.ok) {
          var msg = (data && data.error && data.error.message) || truncate(t, 200);
          throw new Error('Gemini API ' + res.status + ': ' + msg);
        }
        var text = '';
        if (data && data.candidates && data.candidates[0] &&
            data.candidates[0].content && data.candidates[0].content.parts) {
          text = data.candidates[0].content.parts
            .map(function (p) { return p.text || ''; })
            .join('\n');
        }
        return parseSuggestions(text);
      });
    });
  }

  function callOpenAI(ctx, apiKey) {
    // Responses API supports the built-in web_search tool.
    var body = {
      model: modelFor('openai'),
      tools: [{ type: 'web_search' }],
      instructions: SYSTEM_PROMPT,
      input: buildUserMessage(ctx)
    };
    return fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (t) {
        var data;
        try { data = JSON.parse(t); } catch (e) { data = null; }
        if (!res.ok) {
          var msg = (data && data.error && data.error.message) || truncate(t, 200);
          throw new Error('OpenAI API ' + res.status + ': ' + msg);
        }
        var text = data && data.output_text ? data.output_text : extractOpenAIText(data);
        return parseSuggestions(text);
      });
    });
  }

  function extractOpenAIText(data) {
    if (!data || !Array.isArray(data.output)) return '';
    var parts = [];
    for (var i = 0; i < data.output.length; i++) {
      var o = data.output[i];
      if (o && o.type === 'message' && Array.isArray(o.content)) {
        for (var j = 0; j < o.content.length; j++) {
          var c = o.content[j];
          if (c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
            parts.push(c.text);
          }
        }
      }
    }
    return parts.join('\n');
  }

  // ---- Tavily search + an open-weight model --------------------------------
  // The search goes through the CNfirmed Cloudflare Worker: Wikipedia's
  // Content-Security-Policy blocks api.tavily.com, and the Worker is on its
  // allowlist. The model is the open-weight one chosen in Settings.
  var PROXY_BASE = String(window.cnfirmedProxyUrl || 'https://publicai-proxy.alaexis.workers.dev')
    .replace(/\/+$/, '');

  // The model has no search tool here, so the search happens first and the
  // model only judges what came back. It is told to cite only those URLs, and
  // any other URL it names is dropped: it cannot have read it.

  var TAVILY_MAX_QUERY = 400;       // Tavily rejects longer queries
  var TAVILY_MAX_RESULTS = 6;
  var TAVILY_SOURCE_CHARS = 6000;   // per result, of the page text sent on

  var RESULTS_ADDENDUM = [
    '',
    'You have no search tool. The user message ends with SEARCH RESULTS that',
    'were retrieved for you, each with its URL and the text read from that',
    'page. Judge only those results, using only their text. Every "url" you',
    'return must be copied exactly from one of them. Quote only from the text',
    'given. If none of them substantiates the claim, return {"suggestions": []}.'
  ].join('\n');

  function tavilyQuery(ctx) {
    var q = pageTitle.replace(/_/g, ' ') + ': ' + ctx.claim.replace(/\s+/g, ' ').trim();
    return q.length > TAVILY_MAX_QUERY ? q.slice(0, TAVILY_MAX_QUERY) : q;
  }

  // Without a key of the user's own, the Worker searches on its own key.
  function tavilySearch(ctx, apiKey) {
    var headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    return fetch(PROXY_BASE + '/tavily', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        query: tavilyQuery(ctx),
        search_depth: 'advanced',
        chunks_per_source: 3,
        max_results: TAVILY_MAX_RESULTS,
        include_raw_content: 'text',
        // Wikipedia and its mirrors would make the citation circular.
        exclude_domains: ['wikipedia.org', 'wikiwand.com', 'kiddle.co', 'dbpedia.org']
      })
    }).then(function (res) {
      return res.text().then(function (t) {
        if (res.status === 402 && !apiKey && /"free_credits_exhausted"/.test(t)) {
          setFreeSearchesSpent(true);
          throw noFreeSearchesError();
        }
        if (!res.ok) throw new Error('Tavily API ' + res.status + ': ' + truncate(t, 200));
        if (!apiKey) setFreeSearchesSpent(false);
        var data = JSON.parse(t);
        return (data.results || []).filter(function (r) {
          return r && typeof r.url === 'string' && !isUnreliableDomain(r.url);
        });
      });
    });
  }

  function formatSearchResults(results) {
    function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
    // The excerpts are the passages Tavily matched to the query, so they go
    // first; the page text after them is cut, and may stop before the part
    // that matters.
    return results.map(function (r, k) {
      var page = clean(r.raw_content);
      if (page.length > TAVILY_SOURCE_CHARS) page = page.slice(0, TAVILY_SOURCE_CHARS) + ' […]';
      return '[' + (k + 1) + '] ' + r.url + '\nTitle: ' + (r.title || '') +
        '\nExcerpts: ' + clean(r.content) +
        (page ? '\nPage text: ' + page : '');
    }).join('\n\n');
  }

  // Paced with the Internet Archive stage's calls: the Worker counts both
  // against one limit.
  function callOpenModelChat(system, user) {
    var model = modelFor('tavilyhf');
    return workerTurn().then(function () {
      return fetch(openModelUrl(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          // The models reason before they answer, and that counts against this.
          max_tokens: 8000,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        var data;
        try { data = JSON.parse(t); } catch (e) { data = null; }
        if (!res.ok) {
          var err = data && data.error;
          var msg = (err && (err.message || (typeof err === 'string' ? err : ''))) || truncate(t, 200);
          throw new Error(openModelHost(model) + ' (via proxy) ' + res.status + ': ' + msg);
        }
        var m = data && data.choices && data.choices[0] && data.choices[0].message;
        return (m && m.content) || '';
      });
    });
  }

  function callTavilyGptOss(ctx, tavilyKey) {
    return tavilySearch(ctx, tavilyKey).then(function (results) {
      if (!results.length) return [];
      var user = buildUserMessage(ctx) + '\n\nSEARCH RESULTS:\n\n' + formatSearchResults(results);
      return callOpenModelChat(SYSTEM_PROMPT + '\n' + RESULTS_ADDENDUM, user).then(function (text) {
        // Trailing slashes and fragments differ harmlessly between copies.
        function urlKey(u) { return u.trim().replace(/#.*$/, '').replace(/\/+$/, ''); }
        var seen = Object.create(null);
        results.forEach(function (r) { seen[urlKey(r.url)] = true; });
        return parseSuggestions(text).filter(function (s) { return seen[urlKey(s.source.url)]; });
      });
    });
  }

  // ---- Suggestion JSON parsing ------------------------------------------

  function parseSuggestions(raw) {
    if (!raw) return [];
    var json = extractJsonObject(raw);
    if (!json) {
      console.warn('[CNfirmed] no JSON object in model output:', raw);
      return [];
    }
    var parsed;
    try { parsed = JSON.parse(json); }
    catch (e) {
      console.warn('[CNfirmed] failed to parse JSON:', e, json);
      return [];
    }
    var arr = parsed && parsed.suggestions;
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var s = normaliseSuggestion(arr[i]);
      if (s) out.push(s);
    }
    return out;
  }

  function normaliseSuggestion(s) {
    if (!s || typeof s !== 'object' || typeof s.url !== 'string') return null;
    var verdict = normaliseVerdict(s.verdict);
    var confidence = clampConfidence(s.confidence);
    var reliability = normaliseReliability(s.reliability, verdict);
    var source = { url: s.url, title: typeof s.title === 'string' && s.title ? s.title : s.url };
    return {
      source: source,
      verdict: {
        verdict: verdict,
        confidence: confidence,
        comments: typeof s.comments === 'string' ? s.comments : '',
        reliability: reliability,
        reliabilityReason: typeof s.reliability_reason === 'string'
          ? s.reliability_reason
          : (typeof s.reliabilityReason === 'string' ? s.reliabilityReason : '')
      },
      citation: formatCitation(source)
    };
  }

  function normaliseVerdict(raw) {
    if (typeof raw !== 'string') return 'NOT SUPPORTED';
    var v = raw.trim().toUpperCase();
    if (v === 'SUPPORTED' || v === 'PARTIALLY SUPPORTED' ||
        v === 'NOT SUPPORTED' || v === 'SOURCE UNAVAILABLE') return v;
    if (v.indexOf('PARTIAL') === 0) return 'PARTIALLY SUPPORTED';
    if (v.indexOf('UNAVAILABLE') !== -1) return 'SOURCE UNAVAILABLE';
    if (v === 'UNSUPPORTED') return 'NOT SUPPORTED';
    return 'NOT SUPPORTED';
  }

  function clampConfidence(n) {
    var x = typeof n === 'number' ? n : parseFloat(n);
    if (isNaN(x)) return 0;
    return Math.max(0, Math.min(100, x));
  }

  function normaliseReliability(raw, verdict) {
    if (raw === 'high' || raw === 'medium' || raw === 'low' || raw === 'n/a') return raw;
    if (verdict === 'SOURCE UNAVAILABLE') return 'n/a';
    return 'medium';
  }

  function extractJsonObject(raw) {
    var fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    var candidate = fence ? fence[1] : raw;
    var first = candidate.indexOf('{');
    if (first === -1) return null;
    var depth = 0, inStr = false, esc = false;
    for (var i = first; i < candidate.length; i++) {
      var c = candidate[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return candidate.slice(first, i + 1);
      }
    }
    return null;
  }

  // ---- Citation formatting ----------------------------------------------
  // Mirrors src/core/formatCitation.ts (browser-side).

  var NEWS_DOMAINS = [
    'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'bbc.com',
    'bbc.co.uk', 'reuters.com', 'apnews.com', 'bloomberg.com', 'wsj.com',
    'ft.com', 'economist.com', 'npr.org', 'cnn.com', 'aljazeera.com',
    'lemonde.fr'
  ];
  var JOURNAL_DOMAINS = [
    'doi.org', 'ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'arxiv.org',
    'nature.com', 'science.org', 'springer.com', 'sciencedirect.com',
    'jstor.org', 'cambridge.org', 'oxfordjournals.org', 'wiley.com',
    'tandfonline.com', 'academic.oup.com'
  ];
  var BOOK_DOMAINS = ['books.google.com', 'archive.org/details'];

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }

  function pickKind(url) {
    var host = hostOf(url);
    var full = url.toLowerCase();
    function match(list) {
      return list.some(function (d) { return host === d || host.endsWith('.' + d); });
    }
    if (match(JOURNAL_DOMAINS)) return 'cite journal';
    if (BOOK_DOMAINS.some(function (d) { return full.indexOf(d) !== -1; })) return 'cite book';
    if (match(NEWS_DOMAINS)) return 'cite news';
    return 'cite web';
  }

  function escapePipes(s) { return String(s).replace(/\|/g, '{{!}}'); }

  function today() { return new Date().toISOString().slice(0, 10); }

  function formatCitation(source) {
    var kind = pickKind(source.url);
    var host = hostOf(source.url);
    var title = escapePipes(source.title || source.url);
    var date = today();
    var template;
    switch (kind) {
      case 'cite news':
        template = '{{cite news |url=' + source.url + ' |title=' + title + ' |work=' + host + ' |access-date=' + date + '}}';
        break;
      case 'cite journal':
        template = '{{cite journal |url=' + source.url + ' |title=' + title + ' |access-date=' + date + '}}';
        break;
      case 'cite book':
        template = '{{cite book |url=' + source.url + ' |title=' + title + ' |access-date=' + date + '}}';
        break;
      default:
        template = '{{cite web |url=' + source.url + ' |title=' + title + ' |website=' + host + ' |access-date=' + date + '}}';
    }
    return { template: template, ref: '<ref>' + template + '</ref>', kind: kind };
  }

  // ---- A full citation from the ISBN, DOI or URL ---------------------------
  // Mirrors src/core/citoid.ts. What ProveIt and VisualEditor's "Automatic"
  // tab do: ask Citoid for the record (a book's ISBN, else the DOI in the
  // link, else the page), let MediaWiki:Citoid-template-type-map.json pick the
  // template for its item type, and write each field into the parameter that
  // template's TemplateData `maps.citoid` names. Our link and access date stay
  // (and an Archive scan's |url-access= and |via=); the catalogue wins on the rest.

  function citoidNamePairs(first, last) {
    var pairs = [[first, last]];
    for (var n = 2; n <= 9; n++) pairs.push([first + n, last + n]);
    return pairs;
  }

  function citoidExtend(base, extra) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  var CITOID_TYPE_MAP = {
    book: 'Cite book',
    bookSection: 'Cite book',
    journalArticle: 'Cite journal',
    magazineArticle: 'Cite magazine',
    newspaperArticle: 'Cite news',
    webpage: 'Cite web',
    blogPost: 'Cite web',
    forumPost: 'Cite web',
    thesis: 'Cite thesis',
    report: 'Cite report',
    conferencePaper: 'Cite conference',
    encyclopediaArticle: 'Cite encyclopedia',
    dictionaryEntry: 'Cite encyclopedia',
    videoRecording: 'Cite AV media',
    film: 'Cite AV media',
    podcast: 'Cite podcast',
    interview: 'Cite interview',
    map: 'Cite map'
  };

  var CITOID_COMMON_MAP = {
    title: 'title',
    url: 'url',
    date: 'date',
    accessDate: 'access-date',
    language: 'language',
    publisher: 'publisher',
    archiveUrl: 'archive-url',
    archiveDate: 'archive-date',
    author: citoidNamePairs('first', 'last')
  };

  var CITE_BOOK_CITOID_MAP = {
    title: 'title',
    bookTitle: 'title',
    edition: 'edition',
    series: 'series',
    volume: 'volume',
    publisher: 'publisher',
    place: 'location',
    date: 'date',
    language: 'language',
    ISBN: ['isbn'],
    ISSN: ['issn'],
    oclc: 'oclc',
    DOI: 'doi',
    url: 'url',
    author: citoidNamePairs('first', 'last'),
    editor: citoidNamePairs('editor-first', 'editor-last'),
    translator: citoidNamePairs('translator-first', 'translator-last'),
    contributor: 'others'
  };

  var BUILTIN_CITOID_MAPS = {
    'cite book': CITE_BOOK_CITOID_MAP,
    'cite web': citoidExtend(CITOID_COMMON_MAP, {
      websiteTitle: 'website', publicationTitle: 'website', blogTitle: 'website', forumTitle: 'website'
    }),
    'cite news': citoidExtend(CITOID_COMMON_MAP, {
      publicationTitle: 'work', websiteTitle: 'work', place: 'location', ISSN: ['issn'], DOI: 'doi'
    }),
    'cite journal': citoidExtend(CITOID_COMMON_MAP, {
      publicationTitle: 'journal', volume: 'volume', issue: 'issue', pages: 'pages', series: 'series',
      DOI: 'doi', ISSN: ['issn'], PMID: 'pmid', PMCID: 'pmc', editor: citoidNamePairs('editor-first', 'editor-last')
    }),
    'cite magazine': citoidExtend(CITOID_COMMON_MAP, {
      publicationTitle: 'magazine', volume: 'volume', issue: 'issue', pages: 'pages', ISSN: ['issn']
    })
  };

  var CITOID_KEEP = ['url', 'url-access', 'via', 'access-date'];
  var CITOID_WORK = ['website', 'work', 'newspaper', 'magazine', 'journal', 'periodical'];
  var CITOID_FIELD_ORDER = [
    'title', 'work', 'website', 'newspaper', 'magazine', 'journal', 'periodical',
    'edition', 'series', 'volume', 'issue', 'pages', 'others', 'publisher', 'location',
    'date', 'year', 'language', 'isbn', 'issn', 'oclc', 'doi', 'pmid', 'pmc',
    'url', 'url-access', 'via', 'access-date', 'archive-url', 'archive-date'
  ];
  var CITOID_TIMEOUT_MS = 8000;

  function normaliseIsbn(raw) {
    var digits = String(raw).replace(/[^0-9Xx]/g, '').toUpperCase();
    return /^(?:\d{9}[\dX]|\d{13})$/.test(digits) ? digits : null;
  }

  function doiIn(url) {
    var text = url;
    try { text = decodeURIComponent(url); } catch (e) { /* as it is */ }
    var m = /\b(10\.\d{4,9}\/[^\s?#&"<>]+)/.exec(text);
    if (!m) return null;
    return m[1].replace(/\/(?:full|abstract|pdf|epdf|fulltext)$/i, '').replace(/\.pdf$/i, '').replace(/[.,;)]+$/, '');
  }

  function citationTemplateBody(citation) {
    return citation.template.replace(/^\{\{/, '').replace(/\}\}$/, '');
  }

  function isCiteTemplate(name) {
    return /^(?:cite .+|citation)$/i.test(String(name).trim());
  }

  function citoidQuery(citation) {
    if (!citation || !citation.template) return null;
    var parsed = parseTemplateBody(citationTemplateBody(citation));
    if (!isCiteTemplate(parsed.name)) return null;
    var isbn = parsed.named.isbn ? normaliseIsbn(parsed.named.isbn) : null;
    if (isbn) return isbn;
    var url = parsed.named.url;
    if (!url || !/^https?:\/\//i.test(url) || /\barchive\.org\/details\//i.test(url)) return null;
    return doiIn(url) || url;
  }

  function citoidClean(value) {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).replace(/\s+/g, ' ').trim().replace(/\|/g, '{{!}}')
      : '';
  }

  function citoidParams(item, map) {
    var params = {};
    function set(param, value) {
      var v = citoidClean(value);
      if (typeof param === 'string' && param && v && !params[param]) params[param] = v;
    }
    Object.keys(map).forEach(function (field) {
      var target = map[field];
      var value = item[field];
      if (value === undefined || value === null) return;
      var values = Array.isArray(value) ? value : [value];
      if (typeof target === 'string') { set(target, values[0]); return; }
      target.forEach(function (param, i) {
        var v = values[i];
        if (Array.isArray(param)) {
          var name = Array.isArray(v) ? v : [];
          var first = citoidClean(name[0]);
          var last = citoidClean(name[1]);
          set(param[1], last || first);
          if (last) set(param[0], first);
        } else {
          set(param, v);
        }
      });
    });
    return params;
  }

  function citoidTemplate(item, typeMap, current) {
    var mapped = typeof item.itemType === 'string' ? typeMap[item.itemType] : undefined;
    if (typeof mapped !== 'string' || !isCiteTemplate(mapped)) return current;
    var name = mapped.trim().replace(/_/g, ' ');
    return name.charAt(0).toLowerCase() + name.slice(1);
  }

  function citoidOrderKey(param) {
    var m = /^(?:(editor|translator)-)?(last|first|author)(\d*)$/.exec(param);
    if (m) {
      var group = m[1] === 'editor' ? 1 : m[1] === 'translator' ? 2 : 0;
      return [group, Number(m[3] || 1), m[2] === 'first' ? 1 : 0];
    }
    var i = CITOID_FIELD_ORDER.indexOf(param);
    return [3, i < 0 ? CITOID_FIELD_ORDER.length : i, 0];
  }

  function mergeParams(existing, catalogue, sameTemplate) {
    var out = {};
    Object.keys(catalogue).forEach(function (k) { if (k !== 'url') out[k] = catalogue[k]; });
    var hasAuthor = Object.keys(out).some(function (k) { return /^(?:last|author)1?$/.test(k); });
    var hasWork = CITOID_WORK.some(function (w) { return out[w]; });
    Object.keys(existing).forEach(function (k) {
      if (CITOID_KEEP.indexOf(k) !== -1) out[k] = existing[k];
      else if (!sameTemplate) return;
      else if (out[k] || (k === 'author' && hasAuthor) || (k === 'year' && out.date) ||
        (CITOID_WORK.indexOf(k) !== -1 && hasWork)) return;
      else out[k] = existing[k];
    });
    var ordered = {};
    Object.keys(out)
      .map(function (k, i) { return { k: k, i: i, key: citoidOrderKey(k) }; })
      .sort(function (a, b) {
        return a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.i - b.i;
      })
      .forEach(function (e) { ordered[e.k] = out[e.k]; });
    return ordered;
  }

  function citoidUsableTitle(title, url) {
    return Boolean(title) && !/^https?:\/\//i.test(title) && title !== url;
  }

  function completeCitation(citation, items, template, map) {
    var item = Array.isArray(items) ? items[0] : null;
    if (!item || typeof item !== 'object') return citation;
    var parsed = parseTemplateBody(citationTemplateBody(citation));
    if (!isCiteTemplate(parsed.name) || !isCiteTemplate(template)) return citation;
    var catalogue = citoidParams(item, map);
    if (!citoidUsableTitle(catalogue.title, parsed.named.url)) return citation;
    var merged = mergeParams(parsed.named, catalogue, template.toLowerCase() === parsed.name);
    var out = '{{' + template + ' |' + Object.keys(merged).map(function (k) {
      return k + '=' + merged[k];
    }).join(' |') + '}}';
    return { template: out, ref: '<ref>' + out + '</ref>', kind: template.toLowerCase() };
  }

  // The wiki's own REST and action APIs, as ProveIt calls them.
  var citoidTypeMapPromise = null;
  function citoidTypeMap() {
    if (!citoidTypeMapPromise) {
      citoidTypeMapPromise = mwApiGet(WIKI_CODE, {
        action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
        titles: 'MediaWiki:Citoid-template-type-map.json'
      }).then(function (data) {
        var page = data && data.query && data.query.pages && data.query.pages[0];
        var rev = page && page.revisions && page.revisions[0];
        var content = rev && rev.slots && rev.slots.main && rev.slots.main.content;
        var parsed = content ? JSON.parse(content) : null;
        return parsed && typeof parsed === 'object' ? parsed : CITOID_TYPE_MAP;
      }).catch(function () { return CITOID_TYPE_MAP; });
    }
    return citoidTypeMapPromise;
  }

  var citoidTemplateMaps = Object.create(null);
  function templateCitoidMap(template) {
    var key = template.toLowerCase();
    if (!citoidTemplateMaps[key]) {
      var builtin = BUILTIN_CITOID_MAPS[key] || null;
      citoidTemplateMaps[key] = mwApiGet(WIKI_CODE, {
        action: 'templatedata', titles: 'Template:' + template, redirects: '1'
      }).then(function (data) {
        var pages = data && data.pages ? Object.keys(data.pages).map(function (k) { return data.pages[k]; }) : [];
        var maps = pages[0] && pages[0].maps;
        return (maps && maps.citoid) || builtin;
      }).catch(function () { return builtin; });
    }
    return citoidTemplateMaps[key];
  }

  function citoidLookup(query) {
    return fetch('https://' + WIKI_CODE + '.wikipedia.org/api/rest_v1/data/citation/mediawiki/' +
      encodeURIComponent(query), { headers: { accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('Citoid: HTTP ' + res.status);
      return res.json();
    });
  }

  function citoidComplete(citation, query) {
    return Promise.all([citoidTypeMap(), citoidLookup(query)]).then(function (r) {
      var items = r[1];
      var item = Array.isArray(items) && items[0] && typeof items[0] === 'object' ? items[0] : null;
      if (!item) return citation;
      var current = parseTemplateBody(citationTemplateBody(citation)).name;
      var template = citoidTemplate(item, r[0], current);
      return templateCitoidMap(template).then(function (map) {
        if (map || template === current) return { template: template, map: map };
        return templateCitoidMap(current).then(function (m) { return { template: current, map: m }; });
      }).then(function (t) {
        return t.map ? completeCitation(citation, items, t.template, t.map) : citation;
      });
    });
  }

  // One lookup per citation, shared by the warm-up on opening a source and
  // the Insert / Copy buttons; a failed or slow one leaves the citation as it was.
  var citoidPending = Object.create(null);
  function completeFromCitoid(citation) {
    var query = citoidQuery(citation);
    if (!query || citation.citoid) return Promise.resolve(citation);
    var key = citation.template;
    if (!citoidPending[key]) {
      citoidPending[key] = citoidComplete(citation, query).then(function (done) {
        done.citoid = true;
        return done;
      }).catch(function () {
        delete citoidPending[key];
        return citation;
      });
    }
    var timer;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(citation); }, CITOID_TIMEOUT_MS);
    });
    return Promise.race([citoidPending[key], timeout]).then(function (result) {
      clearTimeout(timer);
      return result;
    });
  }

  // What a listed source's citation lives on (a web suggestion, an Archive
  // book) and how to save it, so the cache and the next click have the full one.
  function citoidHolder(holder, save) {
    return holder && citoidQuery(holder.citation) ? { holder: holder, save: save } : null;
  }

  function completeHeldCitation(held) {
    var h = held.holder;
    return completeFromCitoid(h.citation).then(function (citation) {
      if (citation !== h.citation && citation.citoid) {
        h.citation = citation;
        held.save();
      }
      return citation;
    });
  }

  // ---- What was found, in one list ---------------------------------------
  // Every search's results become the same kind of item, ranked by how sure
  // we are that the source states the claim — not by which search found it:
  //   supports  checked against the claim and states it
  //   partial   checked, states part of it
  //   lead      not checked: cited for a similar sentence, or no verdict
  //   flag      "supports" it, but repeats the article word for word
  // Sources checked and found not to state the claim are only counted.

  var TIER_ORDER = { supports: 0, partial: 1, lead: 2, flag: 3 };

  // Hosts of documents anyone can upload: worth a warning, not a block.
  var USER_UPLOAD_HOSTS = ['scribd.com', 'issuu.com', 'yumpu.com', 'pdfcoffee.com', 'dokumen.pub'];

  function isUserUploadHost(url) {
    var host = hostOf(url);
    return USER_UPLOAD_HOSTS.some(function (d) { return host === d || host.endsWith('.' + d); });
  }

  function copyCompare(text) {
    return String(text || '').toLowerCase()
      .replace(/[‘’“”"'`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  // A page that "supports" the claim by repeating the article's sentence word
  // for word is almost always a copy of Wikipedia (WP:CIRCULAR).
  function copiesClaim(claim, text) {
    var c = copyCompare(claim);
    return c.length >= 40 && copyCompare(text).indexOf(c) !== -1;
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function webItem(ctx, s, key) {
    var v = s.verdict || {};
    var tier, verdictText;
    if (v.verdict === 'SUPPORTED') { tier = 'supports'; verdictText = 'Supports the claim'; }
    else if (v.verdict === 'PARTIALLY SUPPORTED') { tier = 'partial'; verdictText = 'Supports part of the claim'; }
    else if (v.verdict === 'SOURCE UNAVAILABLE') { tier = 'lead'; verdictText = 'Could not be read'; }
    else return null;
    var url = s.source.url;
    var host = hostOf(url);
    var warnings = [];
    if (tier !== 'lead' && copiesClaim(ctx.claim, v.comments)) {
      tier = 'flag';
      verdictText = 'Probably copied from Wikipedia';
      warnings.push('The page repeats the article’s sentence word for word, so it is probably ' +
        'copied from Wikipedia (WP:CIRCULAR). Look for the source it came from.');
    }
    if (isUserUploadHost(url)) {
      warnings.push(host + ' hosts documents anyone can upload. Cite the original publication instead.');
    }
    if (v.reliability === 'low') {
      warnings.push('Reliability for this claim: low. ' + (v.reliabilityReason || ''));
    }
    return {
      key: key,
      tier: tier,
      verdictText: verdictText,
      title: s.source.title || url,
      url: url,
      meta: host + ' · web search',
      quoteLabel: 'From the page:',
      quote: v.comments || '',
      warnings: warnings,
      note: v.reliability === 'medium' && v.reliabilityReason
        ? 'Reliability for this claim: medium. ' + v.reliabilityReason : '',
      ref: s.citation && s.citation.ref,
      cite: citoidHolder(s, persist)
    };
  }

  function archiveItem(c, verdict, checkDone, key, terms) {
    var ev = c.evidence || {};
    var tier = verdict === 'supports' ? 'supports' : verdict === 'partial' ? 'partial' : 'lead';
    var verdictText = verdict === 'supports' ? 'Supports the claim'
      : verdict === 'partial' ? 'Supports part of the claim'
      : checkDone ? 'Lead, the check gave no verdict' : 'Lead, not checked';
    var words = c.check && c.check.quote;
    // The checked words find the page better than the passage they came from.
    var url = words && terms ? iaViewerUrl(c.url, words, terms) : ev.viewerUrl || c.url;
    var warnings = [];
    if (ev.bundle) {
      warnings.push('This is one of ' + ev.bundle.books + ' books uploaded together as “' + ev.bundle.title +
        '”. Check the book’s title, author and publisher before citing it.');
    }
    var notes = [];
    if (c.check && c.check.reason) notes.push(c.check.reason);
    notes.push('Find the page in the book and add |page= to the citation.');
    if (ev.year && new Date().getUTCFullYear() - ev.year > 100) {
      notes.push('Old sources can be outdated (WP:AGEMATTERS).');
    }
    return {
      key: key,
      tier: tier,
      verdictText: verdictText,
      title: c.title,
      url: url,
      meta: ['Internet Archive', ev.year,
        ev.access === 'borrow' ? 'borrow with a free account' : 'free to read'].filter(Boolean).join(' · '),
      quoteLabel: words ? 'The words that state it:' : 'Passage:',
      // A passage from the whole text is already cut with "…".
      quote: words || (ev.fullText ? c.snippet : '…' + c.snippet + '…'),
      warnings: warnings,
      note: notes.join(' '),
      ref: c.citation && c.citation.ref,
      cite: citoidHolder(c, persistArchive)
    };
  }

  // `verdict` is the other-language check's: same | partial, or null when it
  // gave none (`checkDone`) or has not run. It says another wiki cited the
  // source for this fact; the source itself is not read, so it stays a lead.
  function wikiItem(c, key, verdict, checkDone) {
    var ev = c.evidence || {};
    var same = ev.origin === 'same-article';
    var host = c.url ? hostOf(c.url) : '';
    var where = same ? 'already cited in this article' : 'cited on ' + ev.lang + '.wikipedia';
    var verdictText = verdict === 'same'
      ? 'Cited for this fact on ' + ev.lang + '.wikipedia, source not checked'
      : verdict === 'partial'
        ? 'Cited for part of this fact on ' + ev.lang + '.wikipedia, source not checked'
        : checkDone ? 'Lead, the check gave no verdict' : 'Lead, not checked';
    var notes = [];
    if (verdict && c.check && c.check.reason) notes.push(c.check.reason);
    if (same && /^<ref name=/.test(c.ref || '')) notes.push('Insert re-uses the citation already in the article.');
    return {
      key: key,
      tier: 'lead',
      verdictText: verdictText,
      title: c.title,
      url: c.url || null,
      meta: (host ? host + ' · ' : '') + where,
      quoteLabel: same ? 'Cited in this article for:' : 'Cited on ' + ev.lang + '.wikipedia for:',
      quote: truncate(ev.sentence || c.snippet || '', 400),
      warnings: [],
      note: notes.join(' '),
      ref: c.ref
    };
  }

  // Each search's state for a claim: idle | running | done | error, and
  // 'none' for books when the claim has nothing to search on.
  function stageStates(i) {
    var w = wikiState[i] || { status: 'idle' };
    var a = archiveState[i] || { status: 'idle' };
    var s = state[i] || { status: 'idle' };
    var books;
    if (archiveNothingToSearch(i)) books = 'none';
    else if (a.status !== 'done') books = a.status;
    else if ((a.candidates || []).length && (!a.check || a.check.status === 'running')) books = 'running';
    else books = 'done';
    var wiki = w.status === 'done' && w.check && w.check.status === 'running' ? 'running' : w.status;
    return { wiki: wiki, books: books, web: s.status };
  }

  function collectItems(i) {
    var ctx = claimContexts[i] || {};
    var all = [];
    var counts = { web: null, books: null, wiki: null };

    var s = state[i];
    if (s && s.status === 'done' && s.result) {
      var wc = { total: 0, supports: 0, partial: 0, copies: 0, rejected: 0 };
      (s.result.suggestions || []).forEach(function (sg, k) {
        wc.total++;
        var item = webItem(ctx, sg, 'web' + k);
        if (!item) { wc.rejected++; return; }
        if (item.tier === 'supports') wc.supports++;
        else if (item.tier === 'partial') wc.partial++;
        else if (item.tier === 'flag') wc.copies++;
        all.push(item);
      });
      counts.web = wc;
    }

    // Books are listed once checked, or if the check failed; while it runs
    // they would only flicker in and out.
    var a = archiveState[i];
    if (a && a.status === 'done' && a.check && a.check.status !== 'running') {
      var checkDone = a.check.status === 'done';
      var terms = archiveTermsFor(i);
      var bc = { total: 0, supports: 0, partial: 0, rejected: 0, unclear: 0 };
      (a.candidates || []).forEach(function (c, k) {
        bc.total++;
        var verdict = checkDone && c.check ? c.check.verdict : null;
        if (verdict && !archiveCheckWanted(verdict)) { bc.rejected++; return; }
        if (verdict === 'supports') bc.supports++;
        else if (verdict === 'partial') bc.partial++;
        else bc.unclear++;
        all.push(archiveItem(c, verdict, checkDone, 'ia' + k, terms));
      });
      counts.books = bc;
    }

    // Other-language leads, like books, are listed once checked; those the
    // check found to state another fact are only counted.
    var w = wikiState[i];
    if (w && w.status === 'done') {
      var checking = w.check && w.check.status === 'running';
      var checked = !!(w.check && w.check.status === 'done');
      var kc = { total: 0, same: 0, partial: 0, rejected: 0, unchecked: 0, sameArticle: 0 };
      (w.candidates || []).forEach(function (c, k) {
        kc.total++;
        if (!isSisterLead(c)) {
          kc.sameArticle++;
          all.push(wikiItem(c, 'wiki' + k, null, false));
          return;
        }
        if (checking) return;
        var verdict = checked && c.check ? c.check.verdict : null;
        if (verdict === 'no') { kc.rejected++; return; }
        if (verdict === 'same') kc.same++;
        else if (verdict === 'partial') kc.partial++;
        else kc.unchecked++;
        all.push(wikiItem(c, 'wiki' + k, verdict, checked));
      });
      counts.wiki = kc;
    }

    all.sort(function (x, y) { return TIER_ORDER[x.tier] - TIER_ORDER[y.tier]; });
    var seen = Object.create(null);
    var items = all.filter(function (item) {
      var k = item.url ? urlKeyOf(item.url) : item.key;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    return { items: items, counts: counts };
  }

  // One line per claim, for its badge and the list of claims.
  function claimStatus(i) {
    var st = stageStates(i);
    var items = collectItems(i).items;
    var top = items[0];
    var running = st.wiki === 'running' || st.books === 'running' || st.web === 'running';
    if (top && top.tier === 'supports') return { kind: 'found', text: 'Supported: ' + truncate(top.title, 60) };
    if (running) {
      return { kind: 'running', text: 'Searching…' + (items.length ? ' ' + plural(items.length, 'lead') + ' so far' : '') };
    }
    if (top && top.tier === 'partial') return { kind: 'partial', text: 'Supported in part: ' + truncate(top.title, 50) };
    if (items.length) return { kind: 'leads', text: plural(items.length, 'lead') + ' to check' };
    if (st.wiki === 'error' || st.books === 'error' || st.web === 'error') return { kind: 'error', text: 'A search failed' };
    if (st.wiki === 'done' && (st.books === 'done' || st.books === 'none')) {
      return { kind: 'nothing', text: st.web === 'done' ? 'Nothing found' : 'Nothing on Wikipedia or in books' };
    }
    return { kind: 'idle', text: 'Not searched yet' };
  }

  var BADGE_ICON = {
    found: 'supports', partial: 'partial', leads: 'search', running: 'spin',
    error: 'search', nothing: 'search', idle: 'search'
  };

  function renderBadge(i) {
    var badge = badges[i];
    if (!badge || !booted) return;
    var st = claimStatus(i);
    badge.title = 'CNfirmed: ' + st.text;
    // Swapping the icon restarts the spinner, so only on a change.
    if (badge.getAttribute('data-status') === st.kind) return;
    badge.setAttribute('data-status', st.kind);
    badge.textContent = '';
    badge.appendChild(icon(BADGE_ICON[st.kind]));
  }

  // ---- The panel --------------------------------------------------------
  // Docked to the right edge, as Source Verifier's is: the article moves over
  // to make room instead of being covered. Three views share its header: one
  // claim, all claims, and settings.

  var PANEL_MIN_WIDTH = 320;
  var NARROW_SCREEN = 720;
  var panel = null;            // { root, head, claimBox, body, drawn }
  var panelView = 'claim';     // 'claim' | 'overview' | 'settings'
  var viewBeforeSettings = 'claim';
  var currentIndex = null;
  var openItemKey = {};        // claim → the expanded source; unset = the first
  var showAllItems = {};

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(className, text, onClick, title) {
    var b = el('button', className, text);
    b.type = 'button';
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function iconButton(name, label, onClick) {
    var b = button('cnf-ib', null, onClick, label);
    b.setAttribute('aria-label', label);
    b.appendChild(icon(name));
    return b;
  }

  function storedPanelWidth() {
    var w = parseInt(localStorage.getItem('cnfirmed-panel-width'), 10);
    if (!(w >= PANEL_MIN_WIDTH)) w = 400;
    return Math.min(w, Math.round(window.innerWidth * 0.8));
  }

  function ensurePanel() {
    if (panel) return panel;
    var root = el('aside');
    root.id = 'cnfirmed-panel';
    root.setAttribute('aria-label', 'CNfirmed');
    root.hidden = true;
    var handle = el('div', 'cnf-resize');
    handle.title = 'Drag to resize';
    var head = el('div', 'cnf-head');
    var claimBox = el('div', 'cnf-claim');
    var body = el('div', 'cnf-body');
    root.appendChild(handle);
    root.appendChild(head);
    root.appendChild(claimBox);
    root.appendChild(body);
    document.body.appendChild(root);
    makeResizable(handle, root);
    // Using the panel puts it back on top of any other tool's.
    root.addEventListener('mousedown', bringToFront);
    window.addEventListener('resize', applyBodyMargin);
    panel = { root: root, head: head, claimBox: claimBox, body: body, drawn: null };
    return panel;
  }

  function makeResizable(handle, root) {
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      function move(ev) {
        var w = Math.max(PANEL_MIN_WIDTH, Math.min(window.innerWidth - ev.clientX, window.innerWidth * 0.8));
        root.style.width = Math.round(w) + 'px';
        applyBodyMargin();
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        try {
          localStorage.setItem('cnfirmed-panel-width', String(parseInt(root.style.width, 10)));
        } catch (err) { /* ignore */ }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // On a narrow screen the panel covers the page instead.
  // The room is made by a stylesheet rule, not an inline style: Source
  // Verifier, while its own panel is closed, sets the body's right margin to
  // 0 !important, which beats any inline margin and left the article running
  // under this panel. The rule here is more specific, so it wins.
  function applyBodyMargin() {
    if (!panel) return;
    var root = document.documentElement;
    var make = panelVisible() && window.innerWidth > NARROW_SCREEN;
    root.classList.toggle('cnfirmed-panel-open', make);
    if (make) root.style.setProperty('--cnfirmed-panel-width', panel.root.style.width);
  }

  function panelVisible() {
    return !!panel && !panel.root.hidden;
  }

  function showPanel() {
    ensurePanel();
    if (panel.root.hidden) {
      panel.root.style.width = storedPanelWidth() + 'px';
      panel.root.hidden = false;
    }
    applyBodyMargin();
    bringToFront();
  }

  // The outermost element covering the middle of the open panel, or null when
  // the panel is on top. Another tool's panel docked to the same edge (Source
  // Verifier, say) is the usual culprit.
  function coveringElement() {
    if (!panelVisible()) return null;
    var r = panel.root.getBoundingClientRect();
    var el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!el || panel.root.contains(el)) return null;
    while (el.parentElement && el.parentElement !== document.body) el = el.parentElement;
    return el;
  }

  function bringToFront() {
    var cover = coveringElement();
    if (!cover) return;
    var z = (parseInt(getComputedStyle(cover).zIndex, 10) || 0) + 1;
    panel.root.style.zIndex = String(Math.max(z, 10001));
  }

  function closePanel() {
    if (!panel) return;
    stopPicking();
    panel.root.hidden = true;
    applyBodyMargin();
    setActive(null);
  }

  // A panel another tool has covered is raised rather than closed.
  function togglePanel() {
    if (!panelVisible()) openOverview();
    else if (coveringElement()) bringToFront();
    else closePanel();
  }

  // A picked claim's text is highlighted where the browser can do it
  // without touching the article's HTML (the CSS Custom Highlight API).
  function setActive(i) {
    cnSups.forEach(function (sup, k) { sup.classList.toggle('cnfirmed-active', k === i); });
    pickedAnchors.forEach(function (badge, k) { badge.classList.toggle('cnfirmed-active', cnSups.length + k === i); });
    if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') return;
    if (i !== null && i !== undefined && isPicked(i)) {
      CSS.highlights.set('cnfirmed-claim', new Highlight(pickedRanges[i - cnSups.length]));
    } else {
      CSS.highlights.delete('cnfirmed-claim');
    }
  }

  function showInArticle(i) {
    anchorOf(i).scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(anchorOf(i));
  }

  function openClaim(i, scroll) {
    if (!booted || !anchorOf(i)) return;
    stopPicking();
    currentIndex = i;
    panelView = 'claim';
    showPanel();
    setActive(i);
    if (scroll) showInArticle(i);
    drawPanel();
    startClaim(i);
  }

  function openOverview() {
    if (!booted) return;
    stopPicking();
    panelView = 'overview';
    showPanel();
    drawPanel();
  }

  function openSettings() {
    if (panelView !== 'settings') viewBeforeSettings = panelView;
    panelView = 'settings';
    showPanel();
    drawPanel();
  }

  function closeSettings() {
    panelView = viewBeforeSettings === 'claim' && currentIndex === null ? 'overview' : viewBeforeSettings;
    drawPanel();
  }

  // Called whenever something about claim i changed (or, with no claim,
  // anything at all): redraws its badge and whatever the panel shows of it.
  function renderPanel(i) {
    var one = i !== undefined && i !== null;
    if (one) renderBadge(i);
    if (!panelVisible()) return;
    if (panelView === 'settings' && one) return; // never under someone typing a key
    if (panelView === 'claim' && one && i !== currentIndex) return;
    drawPanel();
  }

  // The pipeline calls this, as it did when each claim had a sidebar row.
  function renderRow(i) {
    renderPanel(i);
  }

  function drawPanel() {
    if (!panel) return;
    var where = panelView + ':' + currentIndex;
    var scroll = panel.body.scrollTop;
    if (onFreeSearches(getProvider())) checkFreeSearches();
    drawHeader();
    drawClaimBox();
    panel.body.textContent = '';
    var pad = el('div', 'cnf-pad');
    if (panelView === 'claim' && currentIndex !== null) drawClaimView(pad, currentIndex);
    else if (panelView === 'settings') drawSettings(pad);
    else if (panelView === 'pick' && picking) drawPick(pad);
    else drawOverview(pad);
    panel.body.appendChild(pad);
    panel.body.scrollTop = panel.drawn === where ? scroll : 0;
    panel.drawn = where;
  }

  function drawHeader() {
    var head = panel.head;
    head.textContent = '';
    var brand = el('a', 'cnf-brand', 'CNfirmed');
    brand.href = (mw.util && typeof mw.util.getUrl === 'function')
      ? mw.util.getUrl('User:Alaexis/CNfirmed') : '/wiki/User:Alaexis/CNfirmed';
    brand.title = 'About CNfirmed';
    head.appendChild(brand);
    head.appendChild(el('span', 'cnf-spacer'));

    if (panelView === 'claim' && currentIndex !== null) {
      var i = currentIndex;
      var prev = iconButton('prev', 'Previous claim', function () { openClaim(i - 1, true); });
      prev.disabled = i === 0;
      var total = claimCount();
      var count = button('cnf-ib', (i + 1) + ' of ' + total, openOverview, 'All claims on this page');
      count.setAttribute('aria-label', 'Claim ' + (i + 1) + ' of ' + total + '. Show all claims');
      var next = iconButton('next', 'Next claim', function () { openClaim(i + 1, true); });
      next.disabled = i === total - 1;
      head.appendChild(prev);
      head.appendChild(count);
      head.appendChild(next);
    } else {
      head.appendChild(el('span', 'cnf-title', panelView === 'settings' ? 'Settings'
        : panelView === 'pick' ? 'Find sources for a claim' : 'All claims'));
    }

    var gear = iconButton('gear', 'Settings', function () {
      if (panelView === 'settings') closeSettings();
      else openSettings();
    });
    gear.setAttribute('aria-pressed', panelView === 'settings' ? 'true' : 'false');
    head.appendChild(gear);
    head.appendChild(iconButton('close', 'Close', closePanel));
  }

  function drawClaimBox() {
    var box = panel.claimBox;
    box.textContent = '';
    box.hidden = !(panelView === 'claim' && currentIndex !== null);
    if (box.hidden) return;
    var i = currentIndex;
    var ctx = claimContexts[i] || {};
    var back = button('cnf-back', null, openOverview, 'Back to the list of all claims on this page');
    back.appendChild(icon('prev'));
    back.appendChild(document.createTextNode('All claims'));
    box.appendChild(back);
    var top = el('div', 'cnf-claim-top');
    if (ctx.section) top.appendChild(el('span', 'cnf-section', ctx.section));
    if (ctx.picked) top.appendChild(el('span', 'cnf-chip', 'No tag · picked by you'));
    if (top.firstChild) box.appendChild(top);
    box.appendChild(el('p', 'cnf-claim-text', ctx.claim || '(no claim text found)'));
    if (ctx.picked && ctx.cites && ctx.cites.length) {
      box.appendChild(el('p', 'cnf-cites', 'Already cites ' + ctx.cites.join('') +
        '. That source is left out of the leads; a new <ref> goes after it.'));
    }
    var acts = el('div', 'cnf-claim-acts');
    acts.appendChild(button('cnf-linkbtn', 'Show in article', function () { showInArticle(i); }));
    if (ctx.picked) {
      acts.appendChild(button('cnf-linkbtn', 'Add {{cn}}', function () { tagClaimInEditor(i); },
        'Open the section editor in a new tab with {{citation needed}} after this text, for you to review and save'));
      box.appendChild(acts);
      return;
    }
    acts.appendChild(button('cnf-linkbtn', 'Edit sentence', function () {
      editClaimInEditor(i, 'select');
    }, 'Open the section editor in a new tab with this sentence selected, to reword or correct it'));
    acts.appendChild(button('cnf-linkbtn', 'Remove sentence', function () {
      editClaimInEditor(i, 'remove');
    }, 'Open the section editor in a new tab with this sentence already taken out, for you to review and save'));
    box.appendChild(acts);
  }

  function drawClaimView(pad, i) {
    var found = collectItems(i);
    var items = found.items;
    var st = stageStates(i);
    var running = st.wiki === 'running' || st.wiki === 'idle' || st.books === 'running' || st.web === 'running';

    var headline = null;
    if (!(items.length && items[0].tier === 'supports')) {
      if (running) {
        headline = { busy: true, text: items.length ? 'Still searching. ' + plural(items.length, 'lead') + ' so far.' : 'Searching…' };
      } else if (items.length) {
        headline = {
          text: items[0].tier === 'partial' ? 'Nothing supports the whole claim yet.'
            : 'No confirmed source yet. ' + plural(items.length, 'lead') + ' to check.'
        };
      } else {
        headline = { text: st.web === 'done' ? 'Nothing found for this claim.' : 'Nothing on Wikipedia or in books.' };
      }
    }
    if (headline) {
      var h = el('div', 'cnf-headline');
      if (headline.busy) h.setAttribute('data-busy', '');
      h.appendChild(icon(headline.busy ? 'spin' : 'info'));
      h.appendChild(el('span', null, headline.text));
      pad.appendChild(h);
    }
    if (!items.length && isPicked(i) && st.wiki === 'done' && (st.books === 'done' || st.books === 'none') &&
        st.web !== 'running' && st.web !== 'error') {
      var tagBox = el('div', 'cnf-box');
      tagBox.appendChild(el('div', 'cnf-box-title', 'Tag it so others can look'));
      tagBox.appendChild(el('p', null, 'Adds ' + citationNeededTag() + ' after this text, in the section editor, ' +
        'for you to review and save.'));
      tagBox.appendChild(button('cnf-btn cnf-btn-pri', 'Add {{citation needed}}', function () { tagClaimInEditor(i); }));
      pad.appendChild(tagBox);
    }

    if (items.length) {
      var section = el('section');
      section.setAttribute('aria-label', 'Sources found');
      section.appendChild(el('h2', 'cnf-label', 'Found · ' + items.length));
      var openKey = Object.prototype.hasOwnProperty.call(openItemKey, i) ? openItemKey[i] : items[0].key;
      var limit = showAllItems[i] ? items.length : 5;
      items.slice(0, limit).forEach(function (item) {
        section.appendChild(drawItem(i, item, item.key === openKey));
      });
      if (items.length > limit) {
        section.appendChild(button('cnf-linkbtn', 'Show ' + (items.length - limit) + ' more', function () {
          showAllItems[i] = true;
          drawPanel();
        }));
      }
      pad.appendChild(section);
    }

    pad.appendChild(drawSearched(i, st, found.counts));
  }

  function drawItem(i, item, isOpen) {
    var wrap = el('div', 'cnf-item');
    wrap.setAttribute('data-tier', item.tier);
    if (isOpen) wrap.setAttribute('data-open', '');

    var row = button('cnf-row', null, function () {
      openItemKey[i] = isOpen ? null : item.key;
      drawPanel();
    });
    row.setAttribute('aria-expanded', String(isOpen));
    var glyph = el('span', 'cnf-glyph');
    glyph.appendChild(icon(item.tier));
    var main = el('span', 'cnf-row-main');
    main.appendChild(el('span', 'cnf-row-title', item.title));
    var meta = el('span', 'cnf-row-meta');
    meta.appendChild(el('span', 'cnf-verdict', item.verdictText));
    meta.appendChild(document.createTextNode(' · ' + item.meta));
    main.appendChild(meta);
    var chev = el('span', 'cnf-chev');
    chev.appendChild(icon('next'));
    row.appendChild(glyph);
    row.appendChild(main);
    row.appendChild(chev);
    wrap.appendChild(row);
    if (!isOpen) return wrap;

    var detail = el('div', 'cnf-detail');
    if (item.quote) {
      var quote = el('div', 'cnf-quote');
      quote.appendChild(el('span', 'cnf-quote-label', item.quoteLabel));
      quote.appendChild(document.createTextNode(item.quote));
      detail.appendChild(quote);
    }
    item.warnings.forEach(function (text) {
      var box = el('div', 'cnf-warnbox');
      box.appendChild(icon('flag'));
      box.appendChild(el('span', null, text));
      detail.appendChild(box);
    });
    if (item.note) detail.appendChild(el('p', 'cnf-note', item.note));

    var actions = el('div', 'cnf-actions');
    if (item.ref) {
      // Look the record up now, so the buttons usually have the full
      // citation by the time they are clicked.
      if (item.cite) completeHeldCitation(item.cite);
      actions.appendChild(button('cnf-btn cnf-btn-pri', 'Insert in editor', function () {
        insertInEditor(i, item);
      }, isPicked(i) ? 'Open the section editor in a new tab with this <ref> after the selected text'
        : 'Open the section editor in a new tab with this <ref> in place of the {{citation needed}} tag'));
      actions.appendChild(button('cnf-btn', 'Copy <ref>', function () { refFor(item).then(copyRef); }));
    }
    if (item.url) {
      var open = el('a', 'cnf-open', 'Open source');
      open.href = item.url;
      open.target = '_blank';
      open.rel = 'noopener';
      open.appendChild(icon('external'));
      actions.appendChild(open);
    }
    detail.appendChild(actions);
    wrap.appendChild(detail);
    return wrap;
  }

  function refFor(item) {
    if (!item.cite) return Promise.resolve(item.ref);
    return completeHeldCitation(item.cite).then(function (citation) { return citation.ref; });
  }

  function copyRef(ref) {
    navigator.clipboard.writeText(ref).then(function () {
      toast('Copied <ref> to clipboard');
    }, function () { toast('Copy failed'); });
  }

  function sourceRow(name, where, stateName, result, actionLabel, onAction, title) {
    var row = el('div', 'cnf-src');
    row.setAttribute('data-state', stateName);
    if (title) row.title = title;
    var mark = el('span', 'cnf-src-icon');
    mark.appendChild(icon({ done: 'check', running: 'spin', error: 'info' }[stateName] || 'lead'));
    var main = el('span', 'cnf-src-main');
    var nameLine = el('span', 'cnf-src-name');
    nameLine.appendChild(el('b', null, name));
    nameLine.appendChild(el('span', 'cnf-src-where', ' · ' + where));
    main.appendChild(nameLine);
    main.appendChild(el('span', 'cnf-src-result', result));
    row.appendChild(mark);
    row.appendChild(main);
    if (actionLabel) row.appendChild(button('cnf-btn cnf-btn-sm', actionLabel, onAction));
    return row;
  }

  function webCostNote(providerId) {
    if (onFreeSearches(providerId)) return 'One free search';
    return providerId === 'tavilyhf' ? 'One search, billed to your Tavily key' : 'One API call, billed to your key';
  }

  // Where it looked, and the only place a search is started by hand.
  function drawSearched(i, st, counts) {
    var section = el('section');
    section.setAttribute('aria-label', 'Where CNfirmed looked');
    section.appendChild(el('h2', 'cnf-label', 'Searched'));
    var retry = function () { startClaim(i, true); };

    var w = wikiState[i] || {};
    var wikiWhere = 'this article and other languages';
    var kc = counts.wiki;
    if (st.wiki === 'done' && w.check && w.check.status === 'error') {
      section.appendChild(sourceRow('Wikipedia', wikiWhere, 'error',
        'Found ' + plural(kc.total, 'lead') + ', but the check of the other-language ones failed: ' +
        w.check.error, 'Retry', function () { checkWikiStage(i); }));
    } else if (st.wiki === 'done') {
      var parts = [];
      if (kc && kc.sameArticle) parts.push(kc.sameArticle + ' in this article');
      if (kc && kc.same) parts.push(kc.same + ' cited for this fact elsewhere');
      if (kc && kc.partial) parts.push(kc.partial + ' for part of it');
      if (kc && kc.rejected) parts.push(kc.rejected + ' cited for another fact');
      if (kc && kc.unchecked) parts.push(kc.unchecked + ' not checked');
      section.appendChild(sourceRow('Wikipedia', wikiWhere, 'done', kc && kc.total
        ? plural(kc.total, 'lead') + ': ' + parts.join(', ')
        : 'Nothing in this article or other languages'));
    } else if (st.wiki === 'running' && w.status === 'done') {
      section.appendChild(sourceRow('Wikipedia', wikiWhere, 'running', 'Checking ' +
        plural((w.candidates || []).filter(isSisterLead).length, 'other-language lead') + ' against the claim…'));
    } else if (st.wiki === 'error') {
      section.appendChild(sourceRow('Wikipedia', wikiWhere, 'error', 'Failed: ' + w.error, 'Retry', retry));
    } else {
      section.appendChild(sourceRow('Wikipedia', wikiWhere, 'running', 'Looking for citations…'));
    }

    var a = archiveState[i] || {};
    var funnel = a.funnel ? archiveFunnelLine(a.funnel) : '';
    if (st.books === 'none') {
      section.appendChild(sourceRow('Books', 'Internet Archive', 'done',
        'Nothing in the claim to search for: no number, name or key phrase'));
    } else if (st.books === 'running') {
      var checking = a.status === 'done';
      section.appendChild(sourceRow('Books', 'Internet Archive', 'running', checking
        ? 'Checking ' + plural((a.candidates || []).length, 'book') + ' against the claim…'
        : 'Searching digitised books…', null, null, funnel));
    } else if (st.books === 'error') {
      section.appendChild(sourceRow('Books', 'Internet Archive', 'error', 'Failed: ' + a.error, 'Retry', function () {
        runBooks(i, true).then(function () { renderPanel(i); });
      }));
    } else if (st.books === 'done' && a.check && a.check.status === 'error') {
      section.appendChild(sourceRow('Books', 'Internet Archive', 'error',
        'Found ' + plural(a.candidates.length, 'book') + ', but the check failed: ' + a.check.error,
        'Retry', function () { checkArchiveStage(i); }, funnel));
    } else if (st.books === 'done') {
      var b = counts.books;
      var parts = [];
      if (b && b.supports) parts.push(b.supports + ' support' + (b.supports === 1 ? 's' : '') + ' it');
      if (b && b.partial) parts.push(b.partial + ' in part');
      if (b && b.rejected) parts.push(b.rejected + ' don’t state it');
      if (b && b.unclear) parts.push(b.unclear + ' unclear');
      section.appendChild(sourceRow('Books', 'Internet Archive', 'done', b && b.total
        ? plural(b.total, 'book') + ': ' + parts.join(', ')
        : 'No book matches the claim', null, null, funnel));
    } else {
      section.appendChild(sourceRow('Books', 'Internet Archive', 'idle', 'Not searched yet', 'Search', function () {
        runBooks(i).then(function () { renderPanel(i); });
      }));
    }

    var s = state[i] || {};
    var providerId = st.web === 'idle' ? getProvider() : (s.provider || getProvider());
    var webWhere = PROVIDERS[providerId] ? PROVIDERS[providerId].name : providerId;
    if (st.web === 'running') {
      section.appendChild(sourceRow('Web', webWhere, 'running', 'Searching the web…'));
    } else if (st.web === 'error') {
      section.appendChild(sourceRow('Web', webWhere, 'error', 'Failed: ' + s.error, 'Retry', function () { runOne(i); }));
    } else if (st.web === 'done') {
      var c = counts.web;
      var bits = [];
      if (c && c.supports) bits.push(c.supports + ' support' + (c.supports === 1 ? 's' : '') + ' it');
      if (c && c.partial) bits.push(c.partial + ' in part');
      if (c && c.copies) bits.push(c.copies + ' probably copied from Wikipedia');
      if (c && c.rejected) bits.push(c.rejected + ' don’t support it');
      section.appendChild(sourceRow('Web', webWhere, 'done', c && c.total
        ? plural(c.total, 'result') + ': ' + bits.join(', ')
        : 'No usable source found'));
    } else if (canSearchWeb(providerId)) {
      section.appendChild(sourceRow('Web', webWhere, 'idle', webCostNote(providerId), 'Search', function () { runOne(i); }));
    } else if (onFreeSearches(providerId)) {
      section.appendChild(sourceRow('Web', webWhere, 'idle', NO_FREE_SEARCHES, 'Add key', openSettings));
    } else {
      section.appendChild(sourceRow('Web', webWhere, 'idle', 'Needs a ' + keyLabel(providerId), 'Add key', openSettings));
    }
    return section;
  }

  var OVERVIEW_ICON = {
    found: 'supports', partial: 'partial', leads: 'lead', running: 'spin',
    error: 'info', nothing: 'nothing', idle: 'lead'
  };

  function drawOverview(pad) {
    var statuses = [];
    var tally = { found: 0, partial: 0, leads: 0, running: 0, error: 0, nothing: 0, idle: 0 };
    var unsearched = 0;
    for (var i = 0; i < claimCount(); i++) {
      var st = claimStatus(i);
      statuses.push(st);
      if (!isPicked(i)) tally[st.kind]++;
      if (st.kind === 'idle' || st.kind === 'error') unsearched++;
    }
    var pickedCount = pickedAnchors.length;

    var head = el('div');
    head.appendChild(el('div', 'cnf-ov-title', String(pageTitle).replace(/_/g, ' ')));
    var bits = [];
    if (tally.found) bits.push(tally.found + ' supported');
    if (tally.partial) bits.push(tally.partial + ' supported in part');
    if (tally.leads) bits.push(tally.leads + ' with leads');
    if (tally.nothing) bits.push(tally.nothing + ' with nothing found');
    if (tally.running) bits.push(tally.running + ' searching');
    if (tally.error) bits.push(tally.error + ' failed');
    if (tally.idle) bits.push(tally.idle + ' not searched yet');
    var summary = cnSups.length
      ? plural(cnSups.length, 'claim') + (cnSups.length === 1 ? ' needs' : ' need') + ' a citation' +
        (bits.length ? ': ' + bits.join(', ') : '') + '.'
      : 'No {{citation needed}} tags on this page.';
    if (pickedCount) summary += ' You picked ' + pickedCount + (cnSups.length ? ' more.' : '.');
    head.appendChild(el('p', 'cnf-ov-summary', summary));
    pad.appendChild(head);

    if (batch) {
      var busy = button('cnf-btn cnf-btn-pri', 'Searching… ' + batch.done + ' of ' + batch.total);
      busy.disabled = true;
      pad.appendChild(busy);
    } else if (unsearched) {
      var start = el('div');
      start.appendChild(button('cnf-btn cnf-btn-pri', 'Find sources for all (free)', findAllFree));
      start.appendChild(el('p', 'cnf-ov-summary', 'Wikipedia and Internet Archive books. No key needed.'));
      pad.appendChild(start);
    }

    var list = el('div');
    var groups = pickedCount && cnSups.length;
    if (groups) list.appendChild(el('h2', 'cnf-label', 'Tagged · ' + cnSups.length));
    statuses.forEach(function (st, k) {
      if (groups && k === cnSups.length) {
        list.appendChild(el('h2', 'cnf-label cnf-group-label', 'Picked by you · ' + pickedCount));
      }
      var row = button('cnf-ov-row', null, function () { openClaim(k, true); });
      row.setAttribute('data-kind', st.kind);
      if (k === currentIndex) row.setAttribute('aria-current', 'true');
      var glyph = el('span', 'cnf-glyph');
      glyph.appendChild(icon(OVERVIEW_ICON[st.kind]));
      var main = el('span', 'cnf-row-main');
      main.appendChild(el('span', 'cnf-ov-text', (claimContexts[k] && claimContexts[k].claim) || '(no claim text found)'));
      main.appendChild(el('span', 'cnf-ov-status', st.text));
      row.appendChild(glyph);
      row.appendChild(main);
      list.appendChild(row);
    });
    pad.appendChild(list);

    var forWeb = batch ? [] : claimsForWeb();
    if (forWeb.length) {
      var providerId = getProvider();
      var canSearch = canSearchWeb(providerId);
      var n = forWeb.length;
      var searches = n + (n === 1 ? ' search' : ' searches') + ' with ' + PROVIDERS[providerId].name;
      var box = el('div', 'cnf-box');
      box.appendChild(el('div', 'cnf-box-title', 'Search the web for the ' + plural(n, 'claim') + ' with nothing'));
      box.appendChild(el('p', null, !canSearch
        ? (onFreeSearches(providerId) ? NO_FREE_SEARCHES : 'Needs a ' + keyLabel(providerId) + '.')
        : onFreeSearches(providerId)
          ? searches + ', free while CNfirmed’s shared searches last.'
          : searches + ', billed to your ' + (providerId === 'tavilyhf' ? 'Tavily key.' : 'API key.')));
      box.appendChild(button('cnf-btn cnf-btn-pri', canSearch ? 'Search the web (' + n + ')' : 'Add key',
        canSearch ? searchWebForNothing : openSettings));
      pad.appendChild(box);
    }

    var more = el('div', 'cnf-ov-foot');
    more.appendChild(button('cnf-linkbtn', 'Find sources for a claim with no tag', startPicking,
      'Select text in the article and find sources for it'));
    pad.appendChild(more);
  }

  // Choosing the text for a new claim.
  function drawPick(pad) {
    var p = picking.pick;
    var box = el('div', 'cnf-box cnf-pick');
    box.appendChild(el('div', 'cnf-box-title', 'Select the text you want a source for'));
    box.appendChild(el('p', null, 'Select it in the article, then click Find sources. ' +
      'A whole sentence works best; a fact within one works too.'));
    if (p) {
      var quote = el('div', 'cnf-quote');
      quote.appendChild(el('span', 'cnf-quote-label', p.tag >= 0 ? 'Already tagged:' : 'Selected:'));
      quote.appendChild(document.createTextNode(truncate(p.claim, 400)));
      box.appendChild(quote);
    } else if (picking.reason) {
      box.appendChild(el('p', 'cnf-pick-reason', picking.reason));
    }
    var acts = el('div', 'cnf-actions');
    var go = button('cnf-btn cnf-btn-pri', p && p.tag >= 0 ? 'Open the tagged claim' : 'Find sources', usePick);
    go.disabled = !p;
    acts.appendChild(go);
    acts.appendChild(button('cnf-btn', 'Cancel', cancelPicking));
    box.appendChild(acts);
    pad.appendChild(box);
    if (!cnSups.length) {
      var hint = el('p', 'cnf-ov-summary', 'Looking for tagged claims instead? ');
      var cat = el('a', null, 'Category:All articles with unsourced statements');
      cat.href = (mw.util && typeof mw.util.getUrl === 'function')
        ? mw.util.getUrl('Category:All_articles_with_unsourced_statements')
        : '/wiki/Category:All_articles_with_unsourced_statements';
      hint.appendChild(cat);
      hint.appendChild(document.createTextNode(' lists every article that has one.'));
      pad.appendChild(hint);
    }
  }

  var PROVIDER_BLURBS = {
    claude: 'Anthropic. Uses your API key.',
    gemini: 'Google. Uses your API key.',
    openai: 'Uses your API key.',
    tavilyhf: 'Tavily searches, the open-weight model below reads the results. Free while CNfirmed’s ' +
      'shared searches last; then uses your Tavily key.'
  };

  function drawSettings(pad) {
    var current = getProvider();

    var field = el('fieldset', 'cnf-field');
    field.appendChild(el('legend', 'cnf-field-label', 'Web search'));
    Object.keys(PROVIDERS).forEach(function (id) {
      var label = el('label', 'cnf-radio');
      if (id === current) label.setAttribute('data-checked', '');
      var input = el('input');
      input.type = 'radio';
      input.name = 'cnfirmed-provider';
      input.value = id;
      input.checked = id === current;
      input.addEventListener('change', function () {
        setProvider(id);
        drawPanel();
      });
      var text = el('span');
      text.appendChild(el('span', 'cnf-radio-name', PROVIDERS[id].name));
      text.appendChild(el('span', 'cnf-radio-desc', PROVIDER_BLURBS[id] || ''));
      label.appendChild(input);
      label.appendChild(text);
      field.appendChild(label);
    });
    pad.appendChild(field);

    var p = PROVIDERS[current];
    var hasKey = !!getKey(current);
    var keyBlock = el('div');
    var keyName = el('label', 'cnf-field-label', keyLabel(current) + (p.freeSearches ? ' (optional)' : ''));
    keyName.htmlFor = 'cnfirmed-key';
    var row = el('div', 'cnf-keyrow');
    var input = el('input', 'cnf-input');
    input.type = 'password';
    input.id = 'cnfirmed-key';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = hasKey ? 'Saved. Paste a new key to replace it' : 'Paste your key';
    var save = button('cnf-btn cnf-btn-pri', 'Save', function () {
      if (!input.value.trim()) { toast('Paste a key first'); return; }
      setKey(current, input.value);
      toast(keyLabel(current) + ' saved');
      drawPanel();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') save.click();
    });
    row.appendChild(input);
    row.appendChild(save);
    keyBlock.appendChild(keyName);
    keyBlock.appendChild(row);
    if (p.freeSearches && !hasKey) {
      keyBlock.appendChild(el('p', 'cnf-note', freeSearchesSpent() ? NO_FREE_SEARCHES
        : 'Not needed while CNfirmed’s free searches last. Add one to search on your own Tavily credits.'));
    }
    keyBlock.appendChild(el('p', 'cnf-note', 'Kept in this browser’s localStorage. Sent only to ' +
      (p.keyService || p.name) + (p.keyService ? ', through the CNfirmed proxy.' : '.')));
    if (hasKey) {
      keyBlock.appendChild(button('cnf-linkbtn', 'Remove key', function () {
        setKey(current, '');
        toast(keyLabel(current) + ' removed');
        drawPanel();
      }));
    }
    pad.appendChild(keyBlock);

    var currentModel = getOpenModel();
    var models = el('fieldset', 'cnf-field');
    models.appendChild(el('legend', 'cnf-field-label', 'Open-weight model'));
    models.appendChild(el('p', 'cnf-note', 'Reads the Tavily results, and finds and checks books on the ' +
      'Internet Archive. No key needed.'));
    Object.keys(OPEN_MODELS).forEach(function (id) {
      var label = el('label', 'cnf-radio');
      if (id === currentModel) label.setAttribute('data-checked', '');
      var input = el('input');
      input.type = 'radio';
      input.name = 'cnfirmed-open-model';
      input.value = id;
      input.checked = id === currentModel;
      input.addEventListener('change', function () {
        setOpenModel(id);
        drawPanel();
      });
      var text = el('span');
      text.appendChild(el('span', 'cnf-radio-name', OPEN_MODELS[id].name));
      text.appendChild(el('span', 'cnf-radio-desc', OPEN_MODELS[id].blurb));
      label.appendChild(input);
      label.appendChild(text);
      models.appendChild(label);
    });
    pad.appendChild(models);

    var free = el('div', 'cnf-free');
    free.appendChild(el('b', null, 'Free, no key needed'));
    free.appendChild(el('p', 'cnf-note', 'Citations already on Wikipedia (this article and other languages), ' +
      'and books on the Internet Archive, found and checked with the open-weight model above.'));
    pad.appendChild(free);

    var done = el('div');
    done.appendChild(button('cnf-btn cnf-btn-pri', 'Done', closeSettings));
    pad.appendChild(done);
  }

  // ---- Helpers ----------------------------------------------------------

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function flash(el) {
    el.classList.add('cnfirmed-flash');
    setTimeout(function () { el.classList.remove('cnfirmed-flash'); }, 800);
  }

  // ---- Editor integration ------------------------------------------------
  // "Insert in editor" opens the section's source editor in a new tab, with a
  // pre-filled summary and a one-time token in the URL, and stages the <ref>
  // in localStorage under that token (sessionStorage is per tab). The tab is
  // opened on the click itself, since a browser blocks a tab opened after a
  // wait, and the <ref> follows once its Citoid lookup is done; the same
  // script runs on the edit page, waits for it, and puts it in place of the
  // corresponding {{citation needed}} template in the textarea.

  var EDIT_INSERT_PREFIX = 'cnfirmed:pending-insert:';
  var EDIT_INSERT_PARAM = 'cnfirmedInsert';
  var EDIT_INSERT_DONE = 'cnfirmed:insert-done:';
  // Longer than a Citoid lookup may take, so the <ref> has time to arrive.
  var EDIT_INSERT_WAIT_MS = CITOID_TIMEOUT_MS + 4000;
  var EDIT_INSERT_POLL_MS = 200;
  var EDIT_INSERT_MAX_AGE_MS = 10 * 60 * 1000;
  var sectionEditLinksCache = null;

  function insertToken() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // A staged <ref> nobody picked up (a tab closed before it loaded) is
  // dropped once it is old, so localStorage does not collect them.
  function writeStagedInsert(token, payload) {
    try {
      var now = Date.now();
      for (var n = localStorage.length - 1; n >= 0; n--) {
        var k = localStorage.key(n);
        if (!k || k.indexOf(EDIT_INSERT_PREFIX) !== 0) continue;
        var old = null;
        try { old = JSON.parse(localStorage.getItem(k)); } catch (e) { /* drop it */ }
        if (!old || !(now - old.stagedAt < EDIT_INSERT_MAX_AGE_MS)) localStorage.removeItem(k);
      }
      localStorage.setItem(EDIT_INSERT_PREFIX + token, JSON.stringify(payload));
      return true;
    } catch (e) {
      return false;
    }
  }

  // The staged <ref> for this token, once: it is removed as it is read.
  function takeStagedInsert(token) {
    var key = EDIT_INSERT_PREFIX + token;
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    try { localStorage.removeItem(key); } catch (e) { /* read once anyway */ }
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function sectionEditLinkFor(supEl) {
    var node = supEl;
    while (node && node !== document.body) {
      var sib = node.previousElementSibling;
      while (sib) {
        // Vector 2022 wraps the heading and its [edit] link together in a
        // <div class="mw-heading">, so search the wrapper as a whole — not
        // just inside the <h2>, where legacy Vector kept .mw-editsection.
        var headingScope = null;
        if (sib.matches && /^H[1-6]$/i.test(sib.tagName)) {
          headingScope = sib;
        } else if (sib.classList && sib.classList.contains('mw-heading')) {
          headingScope = sib;
        } else if (sib.querySelector && sib.querySelector('h1, h2, h3, h4, h5, h6')) {
          headingScope = sib;
        }
        if (headingScope) {
          var a = headingScope.querySelector('.mw-editsection a[href*="action=edit"]');
          if (a && a.href) return a.href;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  }

  function sectionEditLinkAt(i) {
    if (!sectionEditLinksCache) sectionEditLinksCache = {};
    if (!(i in sectionEditLinksCache)) sectionEditLinksCache[i] = sectionEditLinkFor(anchorOf(i));
    return sectionEditLinksCache[i];
  }

  // The source editor for a claim's section (the whole page for the lead).
  // action=submit, not the section link's action=edit: for anyone whose
  // editing preference is the visual editor, action=edit opens VisualEditor,
  // which ignores the wikitext box the <ref> is written into.
  function sourceEditorUrl(sectionLink) {
    var params = { action: 'submit' };
    if (sectionLink) {
      try {
        var section = new URL(sectionLink, location.href).searchParams.get('section');
        if (section !== null) params.section = section;
      } catch (e) { /* the whole page, then */ }
    }
    if (mw.util && typeof mw.util.getUrl === 'function') return mw.util.getUrl(pageTitle, params);
    return '/w/index.php?title=' + encodeURIComponent(pageTitle) + '&' + new URLSearchParams(params).toString();
  }

  function appendQueryParam(url, key, value) {
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + encodeURIComponent(key) + '=' + encodeURIComponent(value);
  }

  // Opens claim i's section in the source editor in a new tab and stages
  // what to do there once `staged` resolves: put a <ref> in place of the tag
  // (mode 'insert'), select the tagged sentence ('select'), or take it out
  // ('remove'). For a picked claim, which has no tag, the <ref> or a tag goes
  // after the claim's text, found by its words ('append').
  function openClaimInEditor(i, mode, summary, staged, fallback) {
    var link = sectionEditLinkAt(i);
    var k = 0;
    for (var j = 0; j < i && j < cnSups.length; j++) if (sectionEditLinkAt(j) === link) k++;
    var ctx = claimContexts[i] || {};
    var token = insertToken();
    var url = sourceEditorUrl(link);
    if (summary) url = appendQueryParam(url, 'summary', summary);
    url = appendQueryParam(url, EDIT_INSERT_PARAM, token);

    var tab = window.open(url, '_blank');
    if (tab) { try { tab.opener = null; } catch (e) { /* not needed */ } }

    Promise.resolve(staged).then(function (extra) {
      var payload = {
        mode: mode,
        pageTitle: pageTitle,
        revid: revid,
        cnIndexInSection: k,
        sectionLabel: ctx.section || null,
        stagedAt: Date.now()
      };
      if (ctx.picked) {
        payload.claim = ctx.claim;
        payload.before = ctx.before || '';
      }
      for (var key in extra) payload[key] = extra[key];
      if (!writeStagedInsert(token, payload)) {
        toast('Could not stage the edit (localStorage unavailable). ' + fallback);
        return;
      }
      // Pop-ups blocked: this tab, then.
      if (!tab) window.location.href = url;
    });
  }

  function insertInEditor(i, item) {
    if (!item.ref) {
      toast('No <ref> to insert.');
      return;
    }
    openClaimInEditor(i, isPicked(i) ? 'append' : 'insert', 'Added reference (via [[User:Alaexis/CNfirmed|CNfirmed]])',
      refFor(item).then(function (ref) { return { ref: ref }; }), 'Use Copy <ref> instead.');
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function citationNeededTag() {
    var now = new Date();
    return '{{Citation needed|date=' + MONTHS[now.getMonth()] + ' ' + now.getFullYear() + '}}';
  }

  // A picked claim nothing was found for: tag it, so other editors can look.
  function tagClaimInEditor(i) {
    openClaimInEditor(i, 'append', 'Tagged an unsourced statement (via [[User:Alaexis/CNfirmed|CNfirmed]])',
      { ref: citationNeededTag(), tag: true }, 'Use the section\'s [edit] link instead.');
  }

  // For a claim that is wrong or cannot be sourced: reword it, or take it out.
  function editClaimInEditor(i, mode) {
    var summary = mode === 'remove'
      ? 'Removed unsourced statement (via [[User:Alaexis/CNfirmed|CNfirmed]])'
      : null;
    openClaimInEditor(i, mode, summary, {}, 'Use the section\'s [edit] link instead.');
  }

  // Edit-mode: wait for the staged payload and apply it to the textarea.

  function handlePendingEditorInsertion() {
    var token = null;
    try { token = new URL(location.href).searchParams.get(EDIT_INSERT_PARAM); } catch (e) { return; }
    if (!token) return;
    // A preview or a reload of the same tab: the <ref> is already in.
    try { if (sessionStorage.getItem(EDIT_INSERT_DONE + token)) return; } catch (e) { /* go on */ }

    var deadline = Date.now() + EDIT_INSERT_WAIT_MS;
    (function poll() {
      var payload = takeStagedInsert(token);
      if (payload && (payload.ref || payload.mode) && payload.pageTitle === pageTitle) {
        try { sessionStorage.setItem(EDIT_INSERT_DONE + token, '1'); } catch (e) { /* best effort */ }
        mw.loader.using(['mediawiki.util', 'jquery.textSelection']).then(function () {
          applyPendingInsertion(payload);
        }, function () {
          applyPendingInsertion(payload);
        });
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(poll, EDIT_INSERT_POLL_MS);
        return;
      }
      showEditBanner('CNfirmed: nothing arrived from the article tab. ' +
        'Make the edit by hand, or use Copy <ref> in the panel there and paste it in place of the tag.', 'warn');
    })();
  }

  // Best effort: a browser may refuse the clipboard to a page that was not
  // just clicked, and the banner already says what to do.
  function copyQuietly(text) {
    try { navigator.clipboard.writeText(text).catch(function () {}); } catch (e) { /* ignore */ }
  }

  function applyPendingInsertion(payload) {
    var mode = payload.mode || 'insert';
    var ta = document.getElementById('wpTextbox1');
    if (!ta || ta.readOnly) {
      if (mode === 'select' || mode === 'remove') {
        showEditBanner(ta ? 'CNfirmed: this page cannot be edited from your account here.'
          : 'CNfirmed: source editor not found. Switch to the wikitext editor and try again.', 'warn');
        return;
      }
      showEditBanner(
        (ta ? 'CNfirmed: this page cannot be edited from your account here. '
          : 'CNfirmed: source editor not found. Switch to the wikitext editor and try again. ') +
        'Your <ref> snippet is on the clipboard if you need to paste it manually.',
        'warn'
      );
      copyQuietly(payload.ref);
      return;
    }

    // Through jQuery.textSelection when it is there: syntax highlighting
    // (CodeMirror) keeps its own copy of the text and only hears about
    // changes made this way, so writing ta.value alone was lost on save.
    var $ta = $(ta);
    var api = typeof $ta.textSelection === 'function';
    var text = api ? $ta.textSelection('getContents') : ta.value;
    var n = payload.cnIndexInSection || 0;
    var newText = null;
    var start;
    var end;
    var message;
    var kind = 'ok';

    if (mode === 'select') {
      var span = taggedSentenceSpan(text, n);
      if (!span) {
        showEditBanner('CNfirmed: could not locate the {{citation needed}} tag in this section — ' +
          'the page may have changed. Find the sentence and edit it by hand.', 'warn');
        return;
      }
      start = span.start;
      end = span.end;
      message = 'CNfirmed: the tagged sentence is selected. Correct or reword it, then save; ' +
        'leave the {{citation needed}} tag on it unless you add a source.';
    } else if (mode === 'remove') {
      var cut = removeTaggedSentence(text, n);
      if (!cut.removed) {
        showEditBanner('CNfirmed: could not locate the {{citation needed}} tag in this section — ' +
          'the page may have changed. Remove the sentence by hand.', 'warn');
        return;
      }
      newText = cut.text;
      start = end = cut.caret;
      message = 'CNfirmed: the tagged sentence was taken out. Check it with "Show changes" before saving.';
      if (cut.namedRefs.length) {
        kind = 'warn';
        message += ' It defined the reference named "' + cut.namedRefs.join('", "') +
          '": if another sentence reuses it, move the definition there.';
      }
    } else if (mode === 'append') {
      var what = payload.tag ? 'The tag' : 'Your <ref> snippet';
      var found = locateClaimText(text, payload.claim || '', payload.before || '');
      if (!found) {
        showEditBanner('CNfirmed: could not find the selected text in this section, or found it twice — ' +
          'the page may have changed, or the text comes from a template. ' + what +
          ' has been copied to the clipboard: paste it after the text.', 'warn');
        copyQuietly(payload.ref);
        return;
      }
      start = citationPointAfter(text, found.end);
      end = start + payload.ref.length;
      newText = text.slice(0, start) + payload.ref + text.slice(start);
      message = payload.tag
        ? 'CNfirmed: {{citation needed}} added after the selected text — review and save.'
        : 'CNfirmed: <ref> added after the selected text — review and save.';
    } else {
      var result = replaceNthCitationNeeded(text, n, payload.ref);
      if (!result.replaced) {
        showEditBanner(
          'CNfirmed: could not locate the {{citation needed}} tag in this section — '
          + 'the page may have changed. Your <ref> snippet has been copied to the clipboard.',
          'warn'
        );
        copyQuietly(payload.ref);
        return;
      }
      newText = result.text;
      start = result.replacementStart;
      end = start + payload.ref.length;
      message = 'CNfirmed: <ref> inserted in place of the {{citation needed}} tag — review and save.';
    }

    if (api) {
      if (newText !== null) $ta.textSelection('setContents', newText);
      try {
        $ta.textSelection('setSelection', { start: start, end: end });
        $ta.textSelection('scrollToCaretPosition');
      } catch (e) { /* the text is in; the selection is a nicety */ }
    } else {
      if (newText !== null) ta.value = newText;
      try {
        if (newText !== null) ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        ta.setSelectionRange(start, end);
      } catch (e) {}
    }

    showEditBanner(message, kind);
  }

  // Every en.wikipedia template that renders as <sup class="Template-Fact">,
  // with its redirects: the page finds tags by that class, so the wikitext
  // side must count the same set or the Nth tag is the wrong one (or none).
  // Not only {{Citation needed}}: {{Better source needed}}, {{Citation needed
  // span}} and the other sourcing tags below render the same way. Compared
  // after stripping subst:/safesubst: prefixes, normalising
  // underscores/dashes/whitespace, and lowercasing — so "Citation_needed",
  // "CITATION-NEEDED", and "citation needed" all match.
  var CN_ALIASES = {
    // {{Citation needed}} and its redirects
    'citation needed': true, 'facts': true, 'citeneeded': true, 'citationneeded': true,
    'cite needed': true, 'citation required': true, 'uncited': true, 'cn': true,
    'needs citation': true, 'reference needed': true, 'me fact': true, 'cb': true, 'sourceme': true,
    'refneeded': true, 'source needed': true, 'citation missing': true, 'fact': true,
    'cite missing': true, 'proveit': true, 'talkfact': true, 'fact t': true,
    'reference necessary': true, 'refnec': true, 'source?': true, 'refplease': true,
    'reference required': true, 'needcite': true, 'needsref': true, 'ref?': true,
    'citationeeded': true, 'are you sure?': true, 'citesource': true, 'cite source': true,
    'ref needed': true, 'citation requested': true, 'needs citations': true,
    'fake citation needed': true, 'fake fact': true, 'fcitation needed': true,
    'request citation': true, 'prove it': true, 'ctn': true, 'fake cn': true, 'citation need': true,
    'prov statement': true, 'ciation needed': true, 'fakecn': true, 'cit': true,
    'unsourced inline': true, 'fact?': true, 'need citation': true, 'no source given': true,
    'need ref': true, 'citaiton needed': true, 'needcitation': true, 'citationrequired': true,
    'unreferenced inline': true, 'cita requerida': true, 'needs reference': true, 'citn': true,
    'citazione necessaria': true, 'cn needed': true, 'needs cite': true,
    'dummy citation needed': true, 'needs source': true, 'citeneed': true, 'need reference': true,
    'need a reference': true, 'ai retrieved source': true, 'ai retrieved': true,
    'citation nedded': true, 'sourceneeded': true, 'need source': true,
    // {{Citation needed span}} and its redirects
    'citation needed span': true, 'fact span': true, 'cn span': true, 'citation span': true,
    'cns': true, 'cnspan': true, 'ctn span': true, 'cit span': true, 'cspan': true,
    'citations needed span': true, 'refsou': true, 'cite needed span': true,
    'citation needed inline': true,
    // {{Additional citation needed}} and its redirects
    'additional citation needed': true, 'acn': true, 'additional citation': true,
    'additional citations needed': true, 'another citation needed': true,
    'single source inline': true, 'morecitationsneeded': true,
    'additional citation(s) needed': true, 'additional source needed': true,
    'further citation needed': true, 'additional': true, 'inlinemcn': true,
    'more citations needed inline': true, 'more citations inline': true,
    // {{Medical citation needed}} and its redirects
    'medical citation needed': true, 'medcn': true, 'medref inline': true, 'medcite': true,
    'citation needed (medicine)': true, 'citation needed (medical)': true,
    'citation needed medical': true, 'medical source needed': true, 'med cn': true,
    'medrs needed': true,
    // {{Better source needed}} and its redirects
    'better source needed': true, 'better cite': true, 'better citation': true,
    'better reference': true, 'bettersource': true, 'refimprove inline': true, 'bsn': true,
    'better': true, 'dubious source': true, 'need better citation': true, 'bcn': true,
    'better ref needed': true, 'bettersourceneeded': true, 'better citation needed': true,
    'betterfact': true, 'better reference needed': true, 'better source': true, 'brn': true,
    'better cite needed': true,
    // {{Primary source inline}} and its redirects
    'primary source inline': true, 'primary source claim': true, 'psc': true,
    'primary inline': true, 'npsn': true, 'psi': true, 'non primary source needed': true,
    'secondary source needed': true, 'primary src inline': true, 'primarysourceinline': true,
    'ssn': true,
    // {{Third-party inline}}
    'third party inline': true
  };

  // The aliases above that wrap the claim's text instead of following it.
  var CN_SPAN_ALIASES = {
    'citation needed span': true, 'fact span': true, 'cn span': true, 'citation span': true,
    'cns': true, 'cnspan': true, 'ctn span': true, 'cit span': true, 'cspan': true,
    'citations needed span': true, 'refsou': true, 'cite needed span': true,
    'citation needed inline': true
  };

  // The text a {{Citation needed span}} wraps: |text=, |1= or the first
  // unnamed argument.
  function spannedText(inner) {
    var parsed = parseTemplateBody(inner);
    var t = parsed.named.text;
    if (t === undefined) t = parsed.named['1'];
    if (t === undefined) t = parsed.positional[0];
    return t || '';
  }

  function normaliseTemplateName(raw) {
    return raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*(?:safesubst|subst)\s*:\s*/i, '')
      .replace(/[_\-\s]+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function replaceNthCitationNeeded(text, n, replacement) {
    var i = 0;
    var count = 0;
    while (i < text.length - 1) {
      // Skip past comments and <nowiki> regions — CN templates inside them
      // are not rendered, so they must not throw off the index.
      var skip = skipNonRendered(text, i);
      if (skip > i) { i = skip; continue; }

      if (text.charCodeAt(i) === 123 /* { */ && text.charCodeAt(i + 1) === 123) {
        var end = findTemplateEnd(text, i);
        if (end > 0) {
          var inner = text.slice(i + 2, end - 2);
          var pipe = inner.indexOf('|');
          var name = normaliseTemplateName(pipe >= 0 ? inner.slice(0, pipe) : inner);
          if (Object.prototype.hasOwnProperty.call(CN_ALIASES, name)) {
            if (count === n) {
              // {{Citation needed span}} wraps the claim itself: keep it.
              var kept = CN_SPAN_ALIASES[name] ? spannedText(inner) : '';
              return {
                replaced: true,
                text: text.slice(0, i) + kept + replacement + text.slice(end),
                replacementStart: i + kept.length
              };
            }
            count++;
          }
          i = end;
          continue;
        }
      }
      i++;
    }
    return { replaced: false, text: text, replacementStart: -1 };
  }

  // The span the editor selects or removes for the Nth tag: its sentence
  // (taggedSentenceRange), kept to the tag's own line so a heading or a
  // {{Main}} line above the paragraph is never part of it, and without the
  // whitespace after it.
  function taggedSentenceSpan(text, n) {
    var tag = citationNeededOffsets(text)[n];
    if (!tag) return null;
    var r = taggedSentenceRange(text, tag.start, tag.end);
    var lineStart = text.lastIndexOf('\n', tag.start - 1) + 1;
    var lineEnd = text.indexOf('\n', tag.end);
    if (lineEnd === -1) lineEnd = text.length;
    var start = Math.max(r.start, lineStart);
    var end = Math.min(Math.max(r.end, tag.end), lineEnd);
    while (start < tag.start && /\s/.test(text.charAt(start))) start++;
    while (end > tag.end && /\s/.test(text.charAt(end - 1))) end--;
    return { start: start, end: end };
  }

  // The text with the Nth tag's sentence taken out, and the spacing around it
  // put right: one space between the sentences either side, no trailing
  // space, and no empty paragraph left behind.
  function removeTaggedSentence(text, n) {
    var span = taggedSentenceSpan(text, n);
    if (!span) return { removed: false, text: text };
    var before = text.slice(0, span.start);
    var after = text.slice(span.end);
    var removed = text.slice(span.start, span.end);
    var lineHead = before.slice(before.lastIndexOf('\n') + 1);
    if (!/\S/.test(lineHead)) {
      // It began its line: the rest of the line moves up, or the line goes.
      before = before.slice(0, before.length - lineHead.length);
      after = after.replace(/^[ \t]+/, '');
      if (after.charAt(0) === '\n') {
        after = after.slice(1);
        if (/\n\n$/.test(before) && after.charAt(0) === '\n') after = after.replace(/^\n+/, '');
      } else if (after) {
        after = lineHead + after;
      }
    } else if (!after || after.charAt(0) === '\n') {
      before = before.replace(/[ \t]+$/, '');
    } else {
      after = after.replace(/^[ \t]+/, '');
      if (!/\s$/.test(before)) before += ' ';
    }
    // A named reference defined in the sentence may be reused elsewhere,
    // and those uses lose their definition with it.
    var namedRefs = [];
    var m;
    var def = /<ref\b([^>]*[^\/>])?>/gi;
    while ((m = def.exec(removed))) {
      var name = refAttributes(m[1] || '').name;
      if (name) namedRefs.push(name);
    }
    return { removed: true, text: before + after, caret: before.length, removedText: removed, namedRefs: namedRefs };
  }

  function skipNonRendered(text, i) {
    if (text.charCodeAt(i) === 60 /* < */) {
      if (text.substr(i, 4) === '<!--') {
        var endC = text.indexOf('-->', i + 4);
        return endC === -1 ? text.length : endC + 3;
      }
      if (text.substr(i, 8).toLowerCase() === '<nowiki>') {
        var endN = text.toLowerCase().indexOf('</nowiki>', i + 8);
        return endN === -1 ? text.length : endN + 9;
      }
    }
    return i;
  }

  function findTemplateEnd(text, start) {
    var depth = 0;
    var i = start;
    while (i < text.length - 1) {
      if (text.charCodeAt(i) === 123 && text.charCodeAt(i + 1) === 123) {
        depth++;
        i += 2;
        continue;
      }
      if (text.charCodeAt(i) === 125 /* } */ && text.charCodeAt(i + 1) === 125) {
        depth--;
        i += 2;
        if (depth === 0) return i;
        continue;
      }
      i++;
    }
    return -1;
  }

  function showEditBanner(message, kind) {
    var box = document.createElement('div');
    box.className = 'cnfirmed-edit-banner cnfirmed-edit-banner-' + (kind || 'ok');
    box.style.cssText = [
      'position:fixed', 'top:64px', 'right:16px', 'z-index:1000',
      'max-width:340px', 'padding:10px 12px',
      'border:1px solid ' + (kind === 'warn' ? '#fc3' : '#36c'),
      'background:' + (kind === 'warn' ? '#fef6e7' : '#eaf3ff'),
      'color:#202122', 'font-size:13px', 'line-height:1.4',
      'border-radius:3px', 'box-shadow:0 1px 2px rgba(0,0,0,0.1)'
    ].join(';');
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(function () {
      box.style.transition = 'opacity 0.3s';
      box.style.opacity = '0';
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 350);
    }, 8000);
  }

  var toastTimer = null;
  function toast(message) {
    var existing = document.querySelector('.cnfirmed-toast');
    if (existing) existing.remove();
    var t = document.createElement('div');
    t.className = 'cnfirmed-toast';
    t.textContent = message;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('cnfirmed-toast-visible'); });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove('cnfirmed-toast-visible');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2600);
  }
})();

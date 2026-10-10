// {{Wikipedia:USync |repo=https://github.com/alex-o-748/source-finder |ref=refs/heads/main |path=userscript/cnfirmed.js}}

/**
 * CNfirmed user script — finds and verifies sources for {{citation needed}}
 * claims by calling Claude / Gemini / OpenAI directly from the browser using
 * the user's own API key (stored in localStorage) — or by searching with
 * Tavily (the user's Tavily key) and judging the results with GPT-OSS on
 * Hugging Face, both through the publicai-proxy Worker, since Wikipedia's CSP
 * blocks those services. Internet Archive passages
 * are checked against the claim by the Verify API
 * (https://citation-verifier.toolforge.org), which needs no key.
 *
 * Add to User:Yourname/common.js:
 *
 *   importScript('User:Alaexis/cnfirmed.js');
 *
 * The first time you click a 🔍 badge or "Verify all", you'll be prompted for
 * an API key for the selected provider. Keys are kept in localStorage on the
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
    // Tavily does the searching and an open-weight model on Hugging Face reads
    // what it found; the model never searches on its own. Both go through
    // the Worker (Wikipedia's CSP blocks the services themselves), which
    // pays for the model, so the only key is the user's Tavily key.
    tavilyhf: {
      name: 'Tavily + GPT-OSS',
      keyStorage: 'cnfirmed-key-tavily',
      keyLabel: 'Tavily API key',
      keyService: 'Tavily',
      // Must be in the Worker's HF_ALLOWED_MODELS.
      defaultModel: 'openai/gpt-oss-20b',
      modelOverride: 'cnfirmedModelHf',
      run: callTavilyGptOss
    }
  };

  function keyLabel(providerId) {
    var p = PROVIDERS[providerId];
    return p.keyLabel || p.name + ' API key';
  }

  function getProvider() {
    var p = localStorage.getItem('cnfirmed-provider') || 'claude';
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

  function modelFor(providerId) {
    var p = PROVIDERS[providerId];
    return window[p.modelOverride] || p.defaultModel;
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
    'You find and verify sources for a Wikipedia claim currently tagged with',
    '{{citation needed}}. You will receive a CLAIM, surrounding CONTEXT, and',
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

    '#p-cnfirmed .cnfirmed-tool-link{color:inherit;text-decoration:none;border-bottom:1px dotted currentColor}',
    '#p-cnfirmed .cnfirmed-tool-link:hover,#p-cnfirmed .cnfirmed-tool-link:focus{color:#36c}',

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
    'sup.cnfirmed-active{background:var(--cnf-hl);box-shadow:0 0 0 2px var(--cnf-hl);border-radius:2px}',
    '.cnfirmed-flash{background:var(--cnf-hl) !important;transition:background 0.4s}',

    '#cnfirmed-panel{position:fixed;top:0;right:0;z-index:10001;display:flex;flex-direction:column;' +
      'width:400px;height:100vh;box-sizing:border-box;background:var(--cnf-bg);color:var(--cnf-ink);' +
      'border-left:1px solid var(--cnf-line);box-shadow:-2px 0 8px rgba(0,0,0,0.12);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue","Liberation Sans",sans-serif;' +
      'font-size:14px;line-height:1.45}',
    '#cnfirmed-panel[hidden],#cnfirmed-panel [hidden]{display:none !important}',
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
  var archiveCacheKey = 'cnfirmed:ia:' + lang + ':' + pageTitle + ':' + revid;

  var cnSups = [];        // rendered <sup> nodes, in document order
  var badges = [];        // matching <button class="cnfirmed-badge"> nodes
  var claimContexts = []; // { claim, context, section, links } per CN
  var state = {};         // { [index]: { status, result?, error?, provider? } }
  var wikiState = {};     // { [index]: { status, candidates?, warnings?, error? } }
  var archiveState = {};  // { [index]: { status, candidates?, funnel?, error? } }
  var booted = false;     // claims extracted and caches read; see bootstrap()

  // ---- Boot sequence ----------------------------------------------------

  $(function () {
    if (WG_ACTION === 'edit' || WG_ACTION === 'submit') {
      handlePendingEditorInsertion();
      return;
    }

    cnSups = Array.prototype.slice.call(
      document.querySelectorAll('sup.Template-Fact')
    );

    if (cnSups.length === 0) {
      mw.loader.using(['mediawiki.util'])
        .then(buildEmptyPortlet)
        .catch(function (err) {
          console.error('[CNfirmed] failed to load empty portlet:', err);
        });
      return;
    }

    insertBadges();

    mw.loader.using(['mediawiki.util'])
      .then(function () {
        bootstrap();
      })
      .catch(function (err) {
        console.error('[CNfirmed] failed to load:', err);
      });
  });

  function buildEmptyPortlet() {
    if (!mw.util || !mw.util.addPortletLink) return;
    if (document.getElementById('p-cnfirmed')) return;
    if (!ensurePortlet('CNfirmed')) return;
    mw.util.addPortletLink(
      'p-cnfirmed',
      'https://en.wikipedia.org/wiki/Category:All_articles_with_unsourced_statements',
      'No {{citation needed}} tags — try one →',
      't-cnfirmed-test',
      'CNfirmed loaded, but this page has no citation-needed tags. Pick an article from this category to try the script.'
    );
    linkifyPortletHeading();
  }

  // Turn the literal "CNfirmed" inside the portlet heading into a link to the
  // on-wiki docs page, so users have one click from the sidebar to "what is
  // this?". Robust across skins (legacy h3, Vector 2022 span heading-label).
  function linkifyPortletHeading() {
    var portlet = document.getElementById('p-cnfirmed');
    if (!portlet) return;
    if (portlet.querySelector('.cnfirmed-tool-link')) return;
    var url = (mw.util && typeof mw.util.getUrl === 'function')
      ? mw.util.getUrl('User:Alaexis/CNfirmed')
      : '/wiki/User:Alaexis/CNfirmed';
    var headings = portlet.querySelectorAll(
      'h2, h3, h4, .vector-menu-heading-label, .mw-portlet-heading, label'
    );
    for (var i = 0; i < headings.length; i++) {
      if (replaceTextWithAnchor(headings[i], 'CNfirmed', url, 'cnfirmed-tool-link')) return;
    }
  }

  function replaceTextWithAnchor(root, target, url, className) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var idx = node.nodeValue.indexOf(target);
      if (idx < 0) continue;
      var before = node.nodeValue.slice(0, idx);
      var after = node.nodeValue.slice(idx + target.length);
      var a = document.createElement('a');
      a.href = url;
      a.textContent = target;
      a.className = className;
      a.title = 'About CNfirmed';
      var parent = node.parentNode;
      parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(a, node);
      parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
      return true;
    }
    return false;
  }

  // The sidebar box, now only for pages without a tag (everything else lives
  // in the panel). mw.util.addPortlet() leaves placement to the caller unless given a
  // sibling to go before, so the box is appended after the last section of
  // the main menu, wherever the skin keeps it.
  function ensurePortlet(label) {
    var el = document.getElementById('p-cnfirmed');
    if (el) return el;
    if (!mw.util || typeof mw.util.addPortlet !== 'function') return null;
    el = mw.util.addPortlet('p-cnfirmed', label);
    if (!el) return null;
    if (!el.parentNode) {
      var anchor = document.getElementById('p-interaction') ||
        document.getElementById('p-navigation') ||
        document.getElementById('p-tb');
      if (!anchor || !anchor.parentNode) return null;
      anchor.parentNode.appendChild(el);
    }
    return el;
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

  function insertBadges() {
    cnSups.forEach(function (sup, i) {
      var badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'cnfirmed-badge';
      badge.setAttribute('data-cn-index', String(i));
      badge.setAttribute('aria-label', 'Find sources for this claim (CNfirmed)');
      badge.title = 'Find sources with CNfirmed';
      badge.appendChild(icon('search'));
      sup.parentNode.insertBefore(badge, sup.nextSibling);
      badges.push(badge);
    });

    document.addEventListener('click', onBadgeActivate);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelVisible()) closePanel();
    });
  }

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
    addEntryLink();
    for (var i = 0; i < cnSups.length; i++) renderBadge(i);
  }

  // One link to open the panel on the list of claims, where Source Verifier
  // puts its own: beside the page tabs, or in the tools menu on other skins.
  function addEntryLink() {
    if (!mw.util || typeof mw.util.addPortletLink !== 'function') return;
    var portlet = {
      'vector-2022': 'p-associated-pages', vector: 'p-cactions',
      monobook: 'p-cactions', timeless: 'p-associated-pages'
    }[mw.config.get('skin')] || 'p-tb';
    var label = 'CNfirmed (' + cnSups.length + ')';
    var tip = 'Find sources for the ' + cnSups.length + ' citation-needed tag(s) on this page';
    var link = mw.util.addPortletLink(portlet, '#', label, 'ca-cnfirmed', tip) ||
      mw.util.addPortletLink('p-tb', '#', label, 'ca-cnfirmed', tip);
    if (!link) {
      console.warn('[CNfirmed] nowhere to put the panel link; the badges still open it');
      return;
    }
    link.addEventListener('click', function (e) {
      e.preventDefault();
      togglePanel();
    });
  }

  function hydrateFromCache() {
    try {
      var raw = localStorage.getItem(cacheKey);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') state = parsed;
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

  // ---- Finding sources --------------------------------------------------

  // Free first, paid second. Opening a claim runs both free searches at once:
  // the citations Wikipedia already holds, and Internet Archive books (whose
  // passages the Verify API then checks). The paid web search only starts by
  // itself when both came back empty and a key is set; otherwise it waits for
  // a click.
  var autoWebConsidered = {};

  function startClaim(i) {
    var wiki = runWikiStage(i);
    var books = runBooks(i);
    renderPanel(i);
    return Promise.all([wiki, books]).then(function () {
      renderPanel(i);
      maybeAutoWeb(i);
    });
  }

  function runBooks(i) {
    if (archiveQueriesFor(i).length === 0) return Promise.resolve(null);
    return runArchiveStage(i).then(function (a) {
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
    if (!getKey(getProvider())) return;
    runOne(i);
  }

  function runOne(i) {
    var providerId = getProvider();
    var key = getKey(providerId);
    if (!key) {
      toast('Add your ' + keyLabel(providerId) + ' first');
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
        var msg = (err && err.message) ? err.message : String(err);
        state[i] = { status: 'error', error: msg, provider: providerId };
        persist(); renderPanel(i);
      });
  }

  // "Find sources for all": both free searches for every claim, one claim at
  // a time — the Wikipedia corpus is fetched once, and the Archive check
  // shares the Verify API's 30 requests a minute with everyone else.
  var batch = null; // { done, total, promise } while it runs

  function findAllFree() {
    if (batch) return batch.promise;
    var indexes = [];
    for (var i = 0; i < cnSups.length; i++) indexes.push(i);
    batch = { done: 0, total: indexes.length };
    renderPanel();
    batch.promise = indexes.reduce(function (chain, index) {
      return chain.then(function () {
        return runWikiStage(index)
          .then(function () { return runBooks(index); })
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
    for (var i = 0; i < cnSups.length; i++) {
      var ctx = claimContexts[i];
      var s = state[i];
      if (!ctx || !ctx.claim || (s && s.status !== 'idle')) continue;
      if (claimStatus(i).kind === 'nothing') out.push(i);
    }
    return out;
  }

  function searchWebForNothing() {
    var providerId = getProvider();
    if (!getKey(providerId)) {
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
                state[k] = {
                  status: 'error',
                  error: (err && err.message) ? err.message : String(err),
                  provider: providerId
                };
              })
              .then(function () {
                inFlight--;
                persist(); renderPanel(k);
                if (idx >= queue.length && inFlight === 0) {
                  toast('CNfirmed: web search finished');
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
  // Free, unmetered, and needs no API key or model at all, so it runs on a
  // plain badge click even when no provider key is set. Mirrors
  // src/core/{wikitext,wikitextRefs,relevance,wikiSources}.ts.
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

  function anchorScoreOf(query, text, extraNames) {
    var folded = foldText(joinDigitGroups(normaliseDigits(text)));
    var have = tokenSetOf(text);
    var matched = [];
    var seen = Object.create(null);
    var total = 0;
    var hit = 0;
    query.numbers.forEach(function (n) {
      total += 2;
      if ((have[n] || folded.indexOf(n) !== -1) && !seen[n]) {
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

  function sameArticleCandidates(corpus, ctx, index) {
    var background = tokenSetOf(pageTitle.replace(/_/g, ' ') + ' ' + (ctx.section || ''));
    // Deliberately just the tagged sentence, not ctx.context (the whole
    // paragraph): a paragraph strings several sentences together, each with
    // its own citation, so including it would let a neighbouring reference
    // match trivially against its own sentence sitting right there in the
    // query.
    var query = weightedTokensOf(ctx.claim, background);
    var range = corpus.claimOffsets
      ? paragraphRangeAt(corpus.local.wikitext, corpus.claimOffsets[index].start)
      : null;
    var own = corpus.claimOffsets
      ? taggedSentenceRange(corpus.local.wikitext, corpus.claimOffsets[index].start, corpus.claimOffsets[index].end)
      : null;

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

      var distance = Math.abs(ref.occurrence.offset - (corpus.claimOffsets ? corpus.claimOffsets[index].start : 0));
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

  function runWikiStage(index) {
    var current = wikiState[index];
    if (current && current.status === 'done') return Promise.resolve(current);
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
      if (parsed && typeof parsed === 'object') wikiState = parsed;
    } catch (e) { /* ignore */ }
  }

  function persistWiki() {
    try {
      var serialisable = {};
      Object.keys(wikiState).forEach(function (k) {
        var s = wikiState[k];
        if (s && s.status === 'done') {
          serialisable[k] = { status: 'done', candidates: s.candidates, warnings: s.warnings };
        }
      });
      localStorage.setItem(wikiCacheKey, JSON.stringify(serialisable));
    } catch (e) { /* ignore */ }
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
    return '"' + String(term).replace(/["\\]/g, ' ').trim() + '"';
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

  function archiveDetailsOf(response) {
    var md = (response && response.metadata) || {};
    return {
      publisher: iaFirst(md.publisher),
      isbn: iaFirst(md.isbn),
      dark: response.is_dark === true,
      restricted: String(iaFirst(md['access-restricted-item']) || '').toLowerCase() === 'true'
    };
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

  function iaDetailsUrl(identifier) {
    return 'https://archive.org/details/' + encodeURIComponent(identifier);
  }

  function iaViewerUrl(identifier, terms) {
    var q = terms.numbers[0] || terms.names[0] || terms.subject;
    return iaDetailsUrl(identifier) + '?q=' + encodeURIComponent(q);
  }

  // url-access=registration for a lending-library book, as InternetArchiveBot
  // writes it: the link works, after signing in with a free account.
  function formatArchiveCitation(hit, access, details) {
    var parts = ['title=' + escapePipes(hit.title)];
    if (hit.creator) parts.push('author=' + escapePipes(iaCleanCreator(hit.creator)));
    if (details && details.publisher) parts.push('publisher=' + escapePipes(details.publisher));
    if (hit.year !== null) parts.push('year=' + hit.year);
    if (details && details.isbn) parts.push('isbn=' + escapePipes(details.isbn));
    parts.push('url=' + iaDetailsUrl(hit.identifier));
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

  function toArchiveCandidate(s, details, terms) {
    var hit = s.hit;
    var best = s.passages[0];
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
      viewerUrl: iaViewerUrl(hit.identifier, terms)
    };
    if (s.fullText) evidence.fullText = true;
    return {
      url: iaDetailsUrl(hit.identifier),
      title: hit.title,
      relevance: byline + ' — matched ' + (matched.join(', ') || 'claim wording'),
      snippet: best.text,
      evidence: evidence,
      citation: formatArchiveCitation(hit, s.access, details)
    };
  }

  function iaSearchUrl(query) {
    return IA_SEARCH_URL + '?service_backend=fts' +
      '&user_query=' + encodeURIComponent(query) +
      '&hits_per_page=' + IA_MAX_HITS;
  }

  function iaFetchJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('Internet Archive: HTTP ' + res.status);
      return res.json();
    });
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
          return iaFetchJson(iaSearchUrl(query))
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
      return read.then(function () {
        funnel.lookedUp = shortlist.length + extras.length;
        var candidates = [];
        function lookUp(list, cap) {
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
                  candidates.push(toArchiveCandidate(s, details, terms));
                  added++;
                }, function (err) {
                  funnel.errors.push('metadata ' + s.hit.identifier + ': ' + err.message);
                  candidates.push(toArchiveCandidate(s, null, terms));
                  added++;
                });
            });
          }, Promise.resolve());
        }
        return lookUp(shortlist, IA_MAX_CANDIDATES)
          .then(function () { return lookUp(extras, IA_FULL_TEXT_LEADS); })
          .then(function () {
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
      ' → ' + f.candidates + ' lead(s)';
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

  function runArchiveStage(index) {
    var current = archiveState[index];
    if (current && current.status === 'done') return Promise.resolve(current);
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
      if (parsed && typeof parsed === 'object') archiveState = parsed;
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

  // ---- Checking the Archive passages against the claim ------------------
  // The search matches words, and most passages that share a claim's words do
  // not say what it says. Each lead's passages are sent to the Verify API
  // (POST /v1/verify, alex-o-748/citation-checker-script's docs/verify-api.md),
  // the same benchmarked claim-vs-source check the citation-checker userscript
  // runs. It needs no key, so the check runs whenever the search finds leads.
  // Override the host with window.cnfirmedVerifyUrl (e.g. a local server).

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

  // One call per lead, one after another, to go easy on the shared budget.
  // A verdict per candidate, in order.
  function checkArchiveCandidates(ctx, candidates) {
    var out = [];
    return candidates.reduce(function (chain, c) {
      return chain.then(function () {
        return callVerifyApi(ctx.claim, archiveSourceContent(c)).then(function (r) {
          out.push(toArchiveVerdict(r));
        });
      });
    }, Promise.resolve()).then(function () { return out; });
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
    a.checking = checkArchiveCandidates(claimContexts[index], a.candidates)
      .then(function (verdicts) {
        a.candidates.forEach(function (c, k) { c.check = verdicts[k]; });
        a.check = { status: 'done', by: 'verify-api' };
        console.log('[CNfirmed] Internet Archive claim', index, 'checked:',
          verdicts.map(function (v) { return v ? v.verdict : 'none'; }).join(', '));
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

  // ---- Tavily search + an open-weight model on Hugging Face ---------------
  // Both calls go through the CNfirmed Cloudflare Worker: Wikipedia's
  // Content-Security-Policy blocks api.tavily.com and router.huggingface.co,
  // and the Worker is on its allowlist.
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

  function tavilySearch(ctx, apiKey) {
    return fetch(PROXY_BASE + '/tavily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
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
        if (!res.ok) throw new Error('Tavily API ' + res.status + ': ' + truncate(t, 200));
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

  function callHfChat(system, user) {
    return fetch(PROXY_BASE + '/hf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelFor('tavilyhf'),
        // gpt-oss reasons before it answers, and that counts against this.
        max_tokens: 8000,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    }).then(function (res) {
      return res.text().then(function (t) {
        var data;
        try { data = JSON.parse(t); } catch (e) { data = null; }
        if (!res.ok) {
          var err = data && data.error;
          var msg = (err && (err.message || (typeof err === 'string' ? err : ''))) || truncate(t, 200);
          throw new Error('Hugging Face (via proxy) ' + res.status + ': ' + msg);
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
      return callHfChat(SYSTEM_PROMPT + '\n' + RESULTS_ADDENDUM, user).then(function (text) {
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
      ref: s.citation && s.citation.ref
    };
  }

  function archiveItem(c, verdict, checkDone, key) {
    var ev = c.evidence || {};
    var tier = verdict === 'supports' ? 'supports' : verdict === 'partial' ? 'partial' : 'lead';
    var verdictText = verdict === 'supports' ? 'Supports the claim'
      : verdict === 'partial' ? 'Supports part of the claim'
      : checkDone ? 'Lead, the check gave no verdict' : 'Lead, not checked';
    var words = c.check && c.check.quote;
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
      url: ev.viewerUrl || c.url,
      meta: ['Internet Archive', ev.year,
        ev.access === 'borrow' ? 'borrow with a free account' : 'free to read'].filter(Boolean).join(' · '),
      quoteLabel: words ? 'The words that state it:' : 'Passage:',
      // A passage from the whole text is already cut with "…".
      quote: words || (ev.fullText ? c.snippet : '…' + c.snippet + '…'),
      warnings: [],
      note: notes.join(' '),
      ref: c.citation && c.citation.ref
    };
  }

  function wikiItem(c, key) {
    var ev = c.evidence || {};
    var same = ev.origin === 'same-article';
    var host = c.url ? hostOf(c.url) : '';
    var where = same ? 'already cited in this article' : 'cited on ' + ev.lang + '.wikipedia';
    return {
      key: key,
      tier: 'lead',
      verdictText: 'Lead, not checked',
      title: c.title,
      url: c.url || null,
      meta: (host ? host + ' · ' : '') + where,
      quoteLabel: same ? 'Cited in this article for:' : 'Cited on ' + ev.lang + '.wikipedia for:',
      quote: truncate(ev.sentence || c.snippet || '', 400),
      warnings: [],
      note: same && /^<ref name=/.test(c.ref || '')
        ? 'Insert re-uses the citation already in the article.' : '',
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
    if (archiveQueriesFor(i).length === 0) books = 'none';
    else if (a.status !== 'done') books = a.status;
    else if ((a.candidates || []).length && (!a.check || a.check.status === 'running')) books = 'running';
    else books = 'done';
    return { wiki: w.status, books: books, web: s.status };
  }

  function collectItems(i) {
    var ctx = claimContexts[i] || {};
    var all = [];
    var counts = { web: null, books: null };

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
      var bc = { total: 0, supports: 0, partial: 0, rejected: 0, unclear: 0 };
      (a.candidates || []).forEach(function (c, k) {
        bc.total++;
        var verdict = checkDone && c.check ? c.check.verdict : null;
        if (verdict && !archiveCheckWanted(verdict)) { bc.rejected++; return; }
        if (verdict === 'supports') bc.supports++;
        else if (verdict === 'partial') bc.partial++;
        else bc.unclear++;
        all.push(archiveItem(c, verdict, checkDone, 'ia' + k));
      });
      counts.books = bc;
    }

    var w = wikiState[i];
    if (w && w.status === 'done') {
      (w.candidates || []).forEach(function (c, k) { all.push(wikiItem(c, 'wiki' + k)); });
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
  function applyBodyMargin() {
    if (!panel) return;
    var make = panelVisible() && window.innerWidth > NARROW_SCREEN;
    document.body.style.marginRight = make ? panel.root.style.width : '';
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
  }

  function closePanel() {
    if (!panel) return;
    panel.root.hidden = true;
    applyBodyMargin();
    setActive(null);
  }

  function togglePanel() {
    if (panelVisible()) closePanel();
    else openOverview();
  }

  function setActive(i) {
    cnSups.forEach(function (sup, k) { sup.classList.toggle('cnfirmed-active', k === i); });
  }

  function openClaim(i, scroll) {
    if (!booted || !cnSups[i]) return;
    currentIndex = i;
    panelView = 'claim';
    showPanel();
    setActive(i);
    if (scroll) {
      cnSups[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(cnSups[i]);
    }
    drawPanel();
    startClaim(i);
  }

  function openOverview() {
    if (!booted) return;
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
    drawHeader();
    drawClaimBox();
    panel.body.textContent = '';
    var pad = el('div', 'cnf-pad');
    if (panelView === 'claim' && currentIndex !== null) drawClaimView(pad, currentIndex);
    else if (panelView === 'settings') drawSettings(pad);
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
      var count = button('cnf-ib', (i + 1) + ' of ' + cnSups.length, openOverview, 'All claims on this page');
      count.setAttribute('aria-label', 'Claim ' + (i + 1) + ' of ' + cnSups.length + '. Show all claims');
      var next = iconButton('next', 'Next claim', function () { openClaim(i + 1, true); });
      next.disabled = i === cnSups.length - 1;
      head.appendChild(prev);
      head.appendChild(count);
      head.appendChild(next);
    } else {
      head.appendChild(el('span', 'cnf-title', panelView === 'settings' ? 'Settings' : 'All claims'));
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
    if (ctx.section) box.appendChild(el('div', 'cnf-section', ctx.section));
    box.appendChild(el('p', 'cnf-claim-text', ctx.claim || '(no claim text found)'));
    box.appendChild(button('cnf-linkbtn', 'Show in article', function () {
      cnSups[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
      flash(cnSups[i]);
    }));
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
      actions.appendChild(button('cnf-btn cnf-btn-pri', 'Insert in editor', function () {
        openEditorWithRef(i, { citation: { ref: item.ref } });
      }, 'Open the section editor with this <ref> in place of the {{citation needed}} tag'));
      actions.appendChild(button('cnf-btn', 'Copy <ref>', function () { copyRef(item.ref); }));
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
    return providerId === 'tavilyhf' ? 'One search, billed to your Tavily key' : 'One API call, billed to your key';
  }

  // Where it looked, and the only place a search is started by hand.
  function drawSearched(i, st, counts) {
    var section = el('section');
    section.setAttribute('aria-label', 'Where CNfirmed looked');
    section.appendChild(el('h2', 'cnf-label', 'Searched'));
    var retry = function () { startClaim(i); };

    var w = wikiState[i] || {};
    var wikiWhere = 'this article and other languages';
    if (st.wiki === 'done') {
      var n = (w.candidates || []).length;
      section.appendChild(sourceRow('Wikipedia', wikiWhere, 'done',
        n ? plural(n, 'lead') : 'Nothing in this article or other languages'));
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
        runBooks(i).then(function () { renderPanel(i); });
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
    } else if (getKey(providerId)) {
      section.appendChild(sourceRow('Web', webWhere, 'idle', webCostNote(providerId), 'Search', function () { runOne(i); }));
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
    for (var i = 0; i < cnSups.length; i++) {
      var st = claimStatus(i);
      statuses.push(st);
      tally[st.kind]++;
    }

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
    head.appendChild(el('p', 'cnf-ov-summary', plural(cnSups.length, 'claim') +
      (cnSups.length === 1 ? ' needs' : ' need') + ' a citation' + (bits.length ? ': ' + bits.join(', ') : '') + '.'));
    pad.appendChild(head);

    if (batch) {
      var busy = button('cnf-btn cnf-btn-pri', 'Searching… ' + batch.done + ' of ' + batch.total);
      busy.disabled = true;
      pad.appendChild(busy);
    } else if (tally.idle || tally.error) {
      var start = el('div');
      start.appendChild(button('cnf-btn cnf-btn-pri', 'Find sources for all (free)', findAllFree));
      start.appendChild(el('p', 'cnf-ov-summary', 'Wikipedia and Internet Archive books. No key needed.'));
      pad.appendChild(start);
    }

    var list = el('div');
    statuses.forEach(function (st, k) {
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
      var hasKey = !!getKey(providerId);
      var n = forWeb.length;
      var box = el('div', 'cnf-box');
      box.appendChild(el('div', 'cnf-box-title', 'Search the web for the ' + plural(n, 'claim') + ' with nothing'));
      box.appendChild(el('p', null, hasKey
        ? n + (n === 1 ? ' search' : ' searches') + ' with ' + PROVIDERS[providerId].name + ', billed to your ' +
          (providerId === 'tavilyhf' ? 'Tavily key.' : 'API key.')
        : 'Needs a ' + keyLabel(providerId) + '.'));
      box.appendChild(button('cnf-btn cnf-btn-pri', hasKey ? 'Search the web (' + n + ')' : 'Add key',
        hasKey ? searchWebForNothing : openSettings));
      pad.appendChild(box);
    }
  }

  var PROVIDER_BLURBS = {
    claude: 'Anthropic. Uses your API key.',
    gemini: 'Google. Uses your API key.',
    openai: 'Uses your API key.',
    tavilyhf: 'Tavily searches, GPT-OSS reads the results. Uses your Tavily key.'
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
    var keyName = el('label', 'cnf-field-label', keyLabel(current));
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

    var free = el('div', 'cnf-free');
    free.appendChild(el('b', null, 'Free, no key needed'));
    free.appendChild(el('p', 'cnf-note', 'Citations already on Wikipedia (this article and other languages), ' +
      'books on the Internet Archive, and the check of their passages by the Verify API.'));
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
  // The "Insert <ref> in editor" CTA stages the chosen <ref> in sessionStorage,
  // then navigates to the section's edit URL with a pre-filled summary. The
  // same script runs again on the edit page, picks up the staged payload, and
  // replaces the corresponding {{citation needed}} template in the textarea.

  var EDIT_INSERT_PREFIX = 'cnfirmed:pending-insert:';
  var sectionEditLinksCache = null;

  function pendingInsertKey() {
    return EDIT_INSERT_PREFIX + lang + ':' + pageTitle;
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

  function getSectionEditLinks() {
    if (sectionEditLinksCache) return sectionEditLinksCache;
    sectionEditLinksCache = cnSups.map(sectionEditLinkFor);
    return sectionEditLinksCache;
  }

  function buildLeadEditUrl() {
    if (mw.util && typeof mw.util.getUrl === 'function') {
      return mw.util.getUrl(pageTitle, { action: 'edit' });
    }
    return '/w/index.php?title=' + encodeURIComponent(pageTitle) + '&action=edit';
  }

  function appendQueryParam(url, key, value) {
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + encodeURIComponent(key) + '=' + encodeURIComponent(value);
  }

  function openEditorWithRef(i, suggestion) {
    if (!suggestion || !suggestion.citation || !suggestion.citation.ref) {
      toast('No <ref> to insert.');
      return;
    }
    var links = getSectionEditLinks();
    var link = links[i];
    var k = 0;
    for (var j = 0; j < i; j++) if (links[j] === link) k++;
    var editUrl = link || buildLeadEditUrl();

    var payload = {
      pageTitle: pageTitle,
      revid: revid,
      cnIndexInSection: k,
      ref: suggestion.citation.ref,
      sectionLabel: (claimContexts[i] && claimContexts[i].section) || null,
      stagedAt: Date.now()
    };
    try {
      sessionStorage.setItem(pendingInsertKey(), JSON.stringify(payload));
    } catch (e) {
      toast('Could not stage edit (sessionStorage unavailable).');
      return;
    }

    var summary = 'Added reference (via [[User:Alaexis/CNfirmed|CNfirmed]])';
    window.location.href = appendQueryParam(editUrl, 'summary', summary);
  }

  // Edit-mode: locate the staged payload and apply it to the textarea.

  function handlePendingEditorInsertion() {
    var key = EDIT_INSERT_PREFIX + lang + ':' + pageTitle;
    var raw = null;
    try { raw = sessionStorage.getItem(key); } catch (e) { return; }
    if (!raw) return;
    var payload;
    try { payload = JSON.parse(raw); } catch (e) {
      try { sessionStorage.removeItem(key); } catch (e2) {}
      return;
    }
    try { sessionStorage.removeItem(key); } catch (e) {}

    if (!payload || !payload.ref) return;

    mw.loader.using(['mediawiki.util']).then(function () { applyPendingInsertion(payload); });
  }

  function applyPendingInsertion(payload) {
    var ta = document.getElementById('wpTextbox1');
    if (!ta) {
      showEditBanner(
        'CNfirmed: source editor textarea not found. Switch to the wikitext editor and try again — '
        + 'your <ref> snippet is on the clipboard if you need to paste it manually.',
        'warn'
      );
      try { navigator.clipboard.writeText(payload.ref); } catch (e) {}
      return;
    }

    var text = ta.value;
    var result = replaceNthCitationNeeded(text, payload.cnIndexInSection || 0, payload.ref);
    if (!result.replaced) {
      showEditBanner(
        'CNfirmed: could not locate the {{citation needed}} tag in this section — '
        + 'the page may have changed. Your <ref> snippet has been copied to the clipboard.',
        'warn'
      );
      try { navigator.clipboard.writeText(payload.ref); } catch (e) {}
      return;
    }

    ta.value = result.text;
    try {
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {}

    try {
      ta.focus();
      ta.setSelectionRange(result.replacementStart, result.replacementStart + payload.ref.length);
      ta.scrollTop = Math.max(0, ta.scrollHeight * (result.replacementStart / Math.max(1, result.text.length)) - 100);
    } catch (e) {}

    showEditBanner(
      'CNfirmed: <ref> inserted in place of the {{citation needed}} tag — review and save.',
      'ok'
    );
  }

  // Aliases that all redirect to {{Citation needed}} on en.wikipedia and render
  // as <sup class="Template-Fact">. Compared after stripping subst:/safesubst:
  // prefixes, normalising underscores/dashes/whitespace, and lowercasing — so
  // "Citation_needed", "CITATION-NEEDED", and "citation needed" all match.
  var CN_ALIASES = {
    'cn': true,
    'cb': true,
    'fact': true,
    'citation needed': true,
    'citationneeded': true,
    'cite needed': true,
    'citeneeded': true,
    'refneeded': true,
    'ref needed': true,
    'need citation': true,
    'needs citation': true,
    'citation requested': true,
    'source needed': true,
    'sourceneeded': true,
    'need source': true,
    'needs source': true,
    'cn needed': true
  };

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
              return {
                replaced: true,
                text: text.slice(0, i) + replacement + text.slice(end),
                replacementStart: i
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

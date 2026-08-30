// {{Wikipedia:USync |repo=https://github.com/alex-o-748/source-finder |ref=refs/heads/main |path=userscript/cnfirmed.js}}

/**
 * CNfirmed user script — finds and verifies sources for {{citation needed}}
 * claims by calling Claude / Gemini / OpenAI directly from the browser using
 * the user's own API key (stored in localStorage).
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
 *   - A small 🔍 badge appears next to every [citation needed] superscript.
 *     Click it to verify that one claim.
 *   - A "CNfirmed" portlet in the sidebar holds the provider/key controls and
 *     one row per CN tag with live status. Click a row to scroll to the badge.
 *   - "Verify all" runs the whole article (with a confirm prompt — costs scale
 *     linearly with the number of claims).
 *
 * Reuses User:Polygnotus/Helpers/Sidebar.js for portlet plumbing.
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

  var SIDEBAR_HELPER_URL =
    'https://en.wikipedia.org/w/index.php?title=User:Polygnotus/Helpers/Sidebar.js&action=raw&ctype=text/javascript';

  // ---- Providers --------------------------------------------------------

  var PROVIDERS = {
    claude: {
      name: 'Claude',
      keyStorage: 'cnfirmed-key-claude',
      defaultModel: 'claude-sonnet-4-6',
      modelOverride: 'cnfirmedModelClaude',
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
    }
  };

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

  mw.util.addCSS([
    '.cnfirmed-badge {',
    '  display: inline-block;',
    '  margin-left: 2px;',
    '  font-size: 0.85em;',
    '  cursor: pointer;',
    '  user-select: none;',
    '  opacity: 0.55;',
    '  transition: opacity 0.15s;',
    '  vertical-align: baseline;',
    '}',
    '.cnfirmed-badge:hover, .cnfirmed-badge:focus { opacity: 1; outline: none; }',
    '.cnfirmed-badge.cnfirmed-running { opacity: 1; animation: cnfirmed-spin 1.2s linear infinite; }',
    '.cnfirmed-badge[data-cnfirmed-status="SUPPORTED"] { color: #14866d; opacity: 1; }',
    '.cnfirmed-badge[data-cnfirmed-status="PARTIALLY SUPPORTED"] { color: #b08800; opacity: 1; }',
    '.cnfirmed-badge[data-cnfirmed-status="NOT SUPPORTED"] { color: #b32424; opacity: 1; }',
    '.cnfirmed-badge[data-cnfirmed-status="SOURCE UNAVAILABLE"] { color: #72777d; opacity: 1; }',
    '.cnfirmed-badge[data-cnfirmed-status="error"] { color: #b32424; opacity: 1; }',
    '.cnfirmed-badge[data-cnfirmed-status="wiki"] { color: #3056a9; opacity: 1; }',
    '@keyframes cnfirmed-spin { to { transform: rotate(360deg); } }',

    '#p-cnfirmed .cnfirmed-tool-link {',
    '  color: inherit; text-decoration: none;',
    '  border-bottom: 1px dotted currentColor;',
    '}',
    '#p-cnfirmed .cnfirmed-tool-link:hover,',
    '#p-cnfirmed .cnfirmed-tool-link:focus { color: #36c; }',

    '#p-cnfirmed .cnfirmed-controls {',
    '  padding: 4px 6px 8px 6px; border-bottom: 1px solid #eaecf0;',
    '  margin-bottom: 4px; font-size: 0.85em;',
    '}',
    '#p-cnfirmed .cnfirmed-controls-row {',
    '  display: flex; align-items: center; gap: 4px; margin-bottom: 4px;',
    '}',
    '#p-cnfirmed .cnfirmed-controls-row:last-child { margin-bottom: 0; }',
    '#p-cnfirmed .cnfirmed-provider-select { flex: 1; font-size: 0.95em; padding: 1px 2px; }',
    '#p-cnfirmed .cnfirmed-key-btn {',
    '  font-size: 0.85em; padding: 1px 6px; cursor: pointer;',
    '  background: #f8f9fa; border: 1px solid #c8ccd1; border-radius: 2px;',
    '}',
    '#p-cnfirmed .cnfirmed-key-btn:hover { background: #eaecf0; }',
    '#p-cnfirmed .cnfirmed-key-status { font-size: 0.85em; color: #54595d; }',
    '#p-cnfirmed .cnfirmed-key-status.cnfirmed-key-set { color: #14866d; }',
    '#p-cnfirmed .cnfirmed-key-status.cnfirmed-key-missing { color: #b08800; }',
    '#p-cnfirmed .cnfirmed-wiki-btn { flex: 1; text-align: center; }',

    '#p-cnfirmed .cnfirmed-row { cursor: pointer; padding: 2px 0; }',
    '#p-cnfirmed .cnfirmed-row:hover { background: rgba(0,0,0,0.04); }',
    '#p-cnfirmed .cnfirmed-row-claim {',
    '  display: block; font-size: 0.85em; line-height: 1.3;',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '  max-width: 100%;',
    '}',
    '#p-cnfirmed .cnfirmed-row-meta { display: flex; gap: 4px; align-items: center; font-size: 0.75em; }',
    '.cnfirmed-pill {',
    '  display: inline-block; padding: 0 4px; border-radius: 3px;',
    '  font-size: 0.75em; line-height: 1.4; font-weight: bold;',
    '}',
    '.cnfirmed-pill[data-status="idle"] { background: #eaecf0; color: #54595d; }',
    '.cnfirmed-pill[data-status="running"] { background: #36c; color: #fff; }',
    '.cnfirmed-pill[data-status="SUPPORTED"] { background: #14866d; color: #fff; }',
    '.cnfirmed-pill[data-status="PARTIALLY SUPPORTED"] { background: #b08800; color: #fff; }',
    '.cnfirmed-pill[data-status="NOT SUPPORTED"] { background: #b32424; color: #fff; }',
    '.cnfirmed-pill[data-status="SOURCE UNAVAILABLE"] { background: #72777d; color: #fff; }',
    '.cnfirmed-pill[data-status="error"] { background: #b32424; color: #fff; }',
    '.cnfirmed-pill[data-status="wiki"] { background: #3056a9; color: #fff; }',
    '.cnfirmed-rel { font-size: 0.75em; color: #72777d; }',
    '.cnfirmed-rel[data-rel="high"] { color: #14866d; }',
    '.cnfirmed-rel[data-rel="medium"] { color: #b08800; }',
    '.cnfirmed-rel[data-rel="low"] { color: #b32424; }',

    '.cnfirmed-flash { background: #fef6e7 !important; transition: background 0.4s; }',

    '.cnfirmed-panel {',
    '  position: fixed; z-index: 9999;',
    '  bottom: 12px; left: 50%; transform: translateX(-50%);',
    '  width: 420px; max-width: calc(100vw - 16px);',
    '  background: #fff; color: #202122;',
    '  border: 1px solid #a2a9b1; border-radius: 4px;',
    '  box-shadow: 0 4px 18px rgba(0,0,0,0.25);',
    '  font-size: 14px; line-height: 1.4; display: none;',
    '}',
    '.cnfirmed-panel.cnfirmed-panel-visible { display: block; }',
    '.cnfirmed-panel-header {',
    '  display: flex; align-items: center; gap: 6px;',
    '  padding: 5px 6px 5px 10px;',
    '  background: #f8f9fa; border-bottom: 1px solid #eaecf0;',
    '  border-radius: 4px 4px 0 0; user-select: none;',
    '}',
    '.cnfirmed-panel-title {',
    '  flex: 1; font-weight: bold; font-size: 0.85em; color: #54595d;',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
    '.cnfirmed-panel-close {',
    '  flex: none; border: none; background: transparent; cursor: pointer;',
    '  font-size: 18px; line-height: 1; padding: 0 4px; color: #54595d;',
    '}',
    '.cnfirmed-panel-close:hover { color: #202122; }',
    '.cnfirmed-panel-body { padding: 8px 10px; max-height: 70vh; overflow: auto; }',

    '.cnfirmed-popover { max-width: 380px; }',
    '.cnfirmed-quote {',
    '  font-style: italic; color: #54595d;',
    '  border-left: 3px solid #c8ccd1; padding: 4px 8px;',
    '  margin: 6px 0; font-size: 0.9em;',
    '}',
    '.cnfirmed-toolbar { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }',
    '.cnfirmed-note { font-size: 0.85em; color: #54595d; margin-top: 4px; }',
    '.cnfirmed-wiki {',
    '  border-left: 3px solid #3056a9; padding-left: 8px; margin-bottom: 10px;',
    '}',
    '.cnfirmed-wiki-head {',
    '  font-size: 0.8em; font-weight: bold; text-transform: uppercase;',
    '  letter-spacing: 0.04em; color: #54595d; margin-bottom: 4px;',
    '}',
    '.cnfirmed-wiki-row + .cnfirmed-wiki-row {',
    '  margin-top: 8px; padding-top: 8px; border-top: 1px solid #eaecf0;',
    '}',
    '.cnfirmed-origin {',
    '  display: inline-block; padding: 0 4px; border-radius: 3px;',
    '  font-size: 0.7em; font-weight: bold; text-transform: uppercase;',
    '  background: #eaecf0; color: #54595d; vertical-align: 2px;',
    '}',
    '.cnfirmed-origin[data-origin="sister-wiki"] { background: #3056a9; color: #fff; }',
    '.cnfirmed-origin[data-origin="same-article"] { background: #14866d; color: #fff; }',
    '.cnfirmed-toast {',
    '  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);',
    '  background: #202122; color: #fff; padding: 6px 12px; border-radius: 3px;',
    '  font-size: 0.9em; z-index: 10000; opacity: 0;',
    '  transition: opacity 0.2s; max-width: 80vw;',
    '}',
    '.cnfirmed-toast.cnfirmed-toast-visible { opacity: 1; }'
  ].join('\n'));

  // ---- State ------------------------------------------------------------

  var lang = mw.config.get('wgContentLanguage') || 'en';
  var pageTitle = mw.config.get('wgPageName');
  var revid = mw.config.get('wgCurRevisionId');
  var cacheKey = 'cnfirmed:' + lang + ':' + pageTitle + ':' + revid;
  var wikiCacheKey = 'cnfirmed:wiki:' + lang + ':' + pageTitle + ':' + revid;

  var cnSups = [];        // rendered <sup> nodes, in document order
  var badges = [];        // matching <span class="cnfirmed-badge"> nodes
  var claimContexts = []; // { claim, context, section, links } per CN
  var state = {};         // { [index]: { status, result?, error?, provider? } }
  var wikiState = {};     // { [index]: { status, candidates?, warnings?, error? } }
  var helper = null;      // SidebarHelper instance
  var popup = null;       // self-managed floating panel { $element, $body, $title }

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

    mw.loader.using(['mediawiki.util', 'oojs-ui-windows', 'oojs-ui-core', 'oojs-ui-widgets'])
      .then(function () {
        return loadSidebarHelper();
      })
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
    if (typeof mw.util.addPortlet === 'function') {
      mw.util.addPortlet('p-cnfirmed', 'CNfirmed');
    }
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

  function loadSidebarHelper() {
    if (window.SidebarHelper) return Promise.resolve();
    return mw.loader.getScript(SIDEBAR_HELPER_URL);
  }

  function insertBadges() {
    cnSups.forEach(function (sup, i) {
      var badge = document.createElement('span');
      badge.className = 'cnfirmed-badge';
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      badge.setAttribute('data-cn-index', String(i));
      badge.setAttribute('title', 'Find sources with CNfirmed');
      badge.textContent = '🔍';
      sup.parentNode.insertBefore(badge, sup.nextSibling);
      badges.push(badge);
    });

    document.addEventListener('click', onBadgeActivate);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target || !e.target.classList || !e.target.classList.contains('cnfirmed-badge')) return;
      e.preventDefault();
      onBadgeActivate(e);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelVisible()) closePopover();
    });
  }

  function onBadgeActivate(e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('cnfirmed-badge')) return;
    var idx = parseInt(t.getAttribute('data-cn-index'), 10);
    if (isNaN(idx)) return;
    e.preventDefault();
    onBadgeClick(idx);
  }

  function bootstrap() {
    hydrateFromCache();
    hydrateWikiCache();
    extractAllClaims();
    buildSidebar();
    for (var i = 0; i < cnSups.length; i++) renderBadge(i);
  }

  function hydrateFromCache() {
    try {
      var raw = localStorage.getItem(cacheKey);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') state = parsed;
    } catch (e) { /* ignore */ }
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

  // ---- Sidebar ----------------------------------------------------------

  function buildSidebar() {
    if (!window.SidebarHelper) return;
    helper = window.SidebarHelper({
      id: 'p-cnfirmed',
      storageKey: 'cnfirmed-collapsed',
      heading: 'CNfirmed (' + cnSups.length + ')',
      btnClass: 'cnfirmed-collapse-btn',
      onExpand: function () {}
    });
    helper.replaceRows(buildSidebarUl());
    if (helper.markDataLoaded) helper.markDataLoaded();
    ensureControlsBar();
    addVerifyAllButton();
    linkifyPortletHeading();
  }

  function buildSidebarUl() {
    var ul = document.createElement('ul');
    for (var i = 0; i < cnSups.length; i++) {
      ul.appendChild(buildRow(i));
    }
    return ul;
  }

  function buildRow(i) {
    var li = document.createElement('li');
    li.className = 'cnfirmed-row';
    li.setAttribute('data-cn-index', String(i));

    var c = claimContexts[i];
    var s = state[i] || { status: 'idle' };

    var claimSpan = document.createElement('span');
    claimSpan.className = 'cnfirmed-row-claim';
    claimSpan.textContent = c && c.claim ? truncate(c.claim, 80) : '(claim)';

    var meta = document.createElement('span');
    meta.className = 'cnfirmed-row-meta';

    var pill = document.createElement('span');
    pill.className = 'cnfirmed-pill';
    var w = wikiState[i] || {};
    var pillStatus = s.status;
    if (s.status === 'done' && s.result && s.result.suggestions[0]) {
      pillStatus = s.result.suggestions[0].verdict.verdict;
    } else if (w.status === 'running' && s.status === 'idle') {
      pillStatus = 'running';
    } else if (w.status === 'done' && w.candidates && w.candidates.length &&
               s.status !== 'running') {
      pillStatus = 'wiki';
    }
    pill.setAttribute('data-status', pillStatus);
    pill.textContent = pillLabel(pillStatus);
    meta.appendChild(pill);

    if (s.status === 'done' && s.result && s.result.suggestions[0]) {
      var rel = document.createElement('span');
      rel.className = 'cnfirmed-rel';
      var relValue = s.result.suggestions[0].verdict.reliability;
      rel.setAttribute('data-rel', relValue);
      rel.textContent = relValue;
      meta.appendChild(rel);
    }

    li.appendChild(claimSpan);
    li.appendChild(meta);

    li.addEventListener('click', function () {
      var sup = cnSups[i];
      if (sup) {
        sup.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(sup);
      }
      onBadgeClick(i);
    });
    return li;
  }

  function pillLabel(status) {
    switch (status) {
      case 'idle': return 'idle';
      case 'running': return 'running…';
      case 'wiki': return '\u25c8 on wiki';
      case 'SUPPORTED': return '✓ supported';
      case 'PARTIALLY SUPPORTED': return '~ partial';
      case 'NOT SUPPORTED': return '✗ not supported';
      case 'SOURCE UNAVAILABLE': return '? unavailable';
      case 'error': return 'error';
      default: return status;
    }
  }

  function renderRow(i) {
    var ul = document.querySelector('#p-cnfirmed ul');
    if (!ul) return;
    var existing = ul.querySelector('li[data-cn-index="' + i + '"]');
    var fresh = buildRow(i);
    if (existing) ul.replaceChild(fresh, existing);
    else ul.appendChild(fresh);
  }

  function renderBadge(i) {
    var badge = badges[i];
    if (!badge) return;
    var s = state[i] || { status: 'idle' };
    badge.classList.remove('cnfirmed-running');
    if (s.status === 'running') {
      badge.classList.add('cnfirmed-running');
      badge.removeAttribute('data-cnfirmed-status');
      return;
    }
    var w = wikiState[i] || {};
    if (s.status === 'done' && s.result && s.result.suggestions[0]) {
      badge.setAttribute('data-cnfirmed-status', s.result.suggestions[0].verdict.verdict);
    } else if (s.status === 'error') {
      badge.setAttribute('data-cnfirmed-status', 'error');
    } else if (w.status === 'done' && w.candidates && w.candidates.length) {
      badge.setAttribute('data-cnfirmed-status', 'wiki');
    } else {
      badge.removeAttribute('data-cnfirmed-status');
    }
  }

  function ensureControlsBar() {
    var portlet = document.getElementById('p-cnfirmed');
    if (!portlet) return;
    if (portlet.querySelector('.cnfirmed-controls')) {
      renderControlsBar();
      return;
    }
    var bar = document.createElement('div');
    bar.className = 'cnfirmed-controls';
    var ul = portlet.querySelector('ul');
    if (ul) ul.parentNode.insertBefore(bar, ul);
    else portlet.appendChild(bar);
    renderControlsBar();
  }

  function renderControlsBar() {
    var bar = document.querySelector('#p-cnfirmed .cnfirmed-controls');
    if (!bar) return;
    bar.innerHTML = '';

    var providerId = getProvider();
    var hasKey = !!getKey(providerId);

    // Row 1: provider <select>
    var row1 = document.createElement('div');
    row1.className = 'cnfirmed-controls-row';
    var label = document.createElement('span');
    label.textContent = 'Provider:';
    row1.appendChild(label);
    var select = document.createElement('select');
    select.className = 'cnfirmed-provider-select';
    Object.keys(PROVIDERS).forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = PROVIDERS[id].name;
      if (id === providerId) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', function () {
      setProvider(select.value);
      renderControlsBar();
    });
    row1.appendChild(select);
    bar.appendChild(row1);

    // Row 2: key status + buttons
    var row2 = document.createElement('div');
    row2.className = 'cnfirmed-controls-row';
    var status = document.createElement('span');
    status.className = 'cnfirmed-key-status ' + (hasKey ? 'cnfirmed-key-set' : 'cnfirmed-key-missing');
    status.textContent = hasKey ? 'API key: set' : 'API key: not set';
    row2.appendChild(status);

    var spacer = document.createElement('span');
    spacer.style.flex = '1';
    row2.appendChild(spacer);

    var setBtn = document.createElement('button');
    setBtn.className = 'cnfirmed-key-btn';
    setBtn.textContent = hasKey ? 'Change' : 'Set key';
    setBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      promptForKey(providerId);
    });
    row2.appendChild(setBtn);

    if (hasKey) {
      var rmBtn = document.createElement('button');
      rmBtn.className = 'cnfirmed-key-btn';
      rmBtn.textContent = 'Remove';
      rmBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Remove the stored ' + PROVIDERS[providerId].name + ' API key?')) return;
        setKey(providerId, '');
        renderControlsBar();
        toast(PROVIDERS[providerId].name + ' API key removed');
      });
      row2.appendChild(rmBtn);
    }

    bar.appendChild(row2);

    // Row 3: the free stage. Deliberately outside the API-key controls — it
    // needs no key, and that is the point.
    var row3 = document.createElement('div');
    row3.className = 'cnfirmed-controls-row';
    var wikiBtn = document.createElement('button');
    wikiBtn.className = 'cnfirmed-key-btn cnfirmed-wiki-btn';
    wikiBtn.textContent = 'Find sources on Wikipedia (free)';
    wikiBtn.title = 'Look for citations in this article and on other language ' +
      'editions. No API key, no cost.';
    wikiBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      findWikiSourcesForAll();
    });
    row3.appendChild(wikiBtn);
    bar.appendChild(row3);
  }

  function promptForKey(providerId) {
    var p = PROVIDERS[providerId];
    var existing = getKey(providerId);
    return new Promise(function (resolve) {
      var $input = $('<input>').attr({
        type: 'password',
        placeholder: p.name + ' API key',
        autocomplete: 'off',
        spellcheck: 'false'
      }).val(existing).css({
        width: '100%', padding: '4px 6px', 'box-sizing': 'border-box',
        'font-family': 'monospace'
      });
      var $msg = $('<div>').append(
        $('<p>').text(p.name + ' API key (stored in this browser\'s localStorage):'),
        $input,
        $('<p>').css({ 'font-size': '0.85em', color: '#54595d', 'margin-top': '6px' })
          .text('The key is sent only to ' + p.name + '\'s API. Leave blank and Save to remove it.')
      );
      OO.ui.confirm($msg, {
        title: 'Set ' + p.name + ' API key',
        actions: [
          { action: 'reject', label: 'Cancel', flags: 'safe' },
          { action: 'accept', label: 'Save', flags: ['primary', 'progressive'] }
        ]
      }).done(function (confirmed) {
        if (confirmed) {
          setKey(providerId, $input.val());
          renderControlsBar();
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  function addVerifyAllButton() {
    var portlet = document.getElementById('p-cnfirmed');
    if (!portlet) return;
    var heading = portlet.querySelector('.vector-menu-heading');
    if (!heading || heading.querySelector('.cnfirmed-verify-all')) return;
    var btn = document.createElement('button');
    btn.className = 'cnfirmed-verify-all';
    btn.textContent = 'Verify all';
    btn.title = 'Check Wikipedia\u2019s own sources for every claim (free), then ' +
      'offer to web-search the ones it could not answer.';
    btn.style.cssText = 'position:absolute;top:50%;right:24px;transform:translateY(-50%);' +
      'font-size:10px;padding:1px 6px;cursor:pointer;background:#36c;color:#fff;' +
      'border:none;border-radius:2px;';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      verifyAll();
    });
    heading.appendChild(btn);
  }

  // ---- Verification orchestration ---------------------------------------

  // Free first, paid second. The wiki-local stage needs no API key, so a badge
  // click always does something useful; the web search is only reached when
  // Wikipedia's own sources come up empty, or the user asks for it.
  function onBadgeClick(i) {
    openPopover(i);
    var s = state[i] || { status: 'idle' };
    if (s.status === 'running') return;
    var alreadySearched = s.status === 'done' || s.status === 'error';

    // The free stage runs on every click — it is cached, so this is a no-op
    // the second time — and only then is the paid search considered.
    runWikiStage(i).then(function (w) {
      renderPanel(i);
      if (alreadySearched) return;
      if (w.status === 'done' && w.candidates && w.candidates.length > 0) return;
      // Nothing on wiki. Fall through to the paid path, as before, but only
      // when a key is already set — never prompt for one unasked.
      if (getKey(getProvider())) runOne(i);
    });
  }

  function runOne(i) {
    var providerId = getProvider();
    var key = getKey(providerId);
    if (!key) {
      toast('Set your ' + PROVIDERS[providerId].name + ' API key first');
      promptForKey(providerId).then(function (ok) {
        if (ok && getKey(providerId)) runOne(i);
      });
      return;
    }

    var ctx = claimContexts[i];
    if (!ctx || !ctx.claim) {
      var msg = 'Could not extract a claim from the surrounding text.';
      state[i] = { status: 'error', error: msg, provider: providerId };
      renderRow(i); renderBadge(i); persist(); renderPanel(i);
      return;
    }

    state[i] = { status: 'running', provider: providerId };
    renderRow(i); renderBadge(i); renderPanel(i);

    PROVIDERS[providerId].run(ctx, key)
      .then(function (suggestions) {
        var ranked = rankSuggestions(suggestions);
        var result = { claim: ctx, suggestions: ranked, provider: providerId };
        state[i] = { status: 'done', result: result, provider: providerId };
        persist(); renderRow(i); renderBadge(i); renderPanel(i);
      })
      .catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        state[i] = { status: 'error', error: msg, provider: providerId };
        persist(); renderRow(i); renderBadge(i); renderPanel(i);
      });
  }

  // Runs the free wiki-local stage over every claim. No key, no model, no
  // confirmation needed — nothing here costs anything.
  function scanWikiAll() {
    var pending = [];
    for (var i = 0; i < cnSups.length; i++) {
      var w = wikiState[i];
      if (!w || w.status !== 'done') pending.push(i);
    }
    if (pending.length === 0) return Promise.resolve();
    toast('Checking Wikipedia sources for ' + pending.length + ' claim(s)…');
    // The corpus is fetched once; everything after that is local, so a plain
    // sequential walk is both simple and fast.
    return pending.reduce(function (chain, index) {
      return chain.then(function () { return runWikiStage(index); });
    }, Promise.resolve()).then(function () {
      renderPanel(popoverIndex);
    });
  }

  function wikiHitCount() {
    var hits = 0;
    for (var i = 0; i < cnSups.length; i++) {
      var w = wikiState[i];
      if (w && w.status === 'done' && w.candidates && w.candidates.length) hits++;
    }
    return hits;
  }

  function findWikiSourcesForAll() {
    return scanWikiAll().then(function () {
      var hits = wikiHitCount();
      toast('CNfirmed: ' + hits + '/' + cnSups.length +
        ' claim(s) have a source already on Wikipedia');
    }).catch(function (err) {
      toast('Wiki lookup failed: ' + ((err && err.message) || err));
    });
  }

  // "Verify all" now means: free stage everywhere, then pay only for the
  // claims Wikipedia could not answer.
  function verifyAll() {
    return scanWikiAll().then(function () {
      var queue = [];
      var onWiki = 0;
      for (var i = 0; i < cnSups.length; i++) {
        if (state[i] && state[i].status === 'done') continue;
        var w = wikiState[i];
        if (w && w.status === 'done' && w.candidates && w.candidates.length) {
          onWiki++;
          continue;
        }
        queue.push(i);
      }

      if (queue.length === 0) {
        toast(onWiki > 0
          ? 'Every remaining claim already has a source on Wikipedia'
          : 'All claims already verified (clear cache to re-run)');
        return;
      }

      var providerId = getProvider();
      if (!getKey(providerId)) {
        toast('Set your ' + PROVIDERS[providerId].name + ' API key first');
        return promptForKey(providerId).then(function (ok) {
          if (ok && getKey(providerId)) return verifyAll();
        });
      }

      var msg = (onWiki > 0
        ? onWiki + ' claim(s) already have a source on Wikipedia, for free.\n\n'
        : '') +
        'Search the web for the remaining ' + queue.length + ' claim(s) using ' +
        PROVIDERS[providerId].name + '? That is ' + queue.length +
        ' API call(s) — costs scale linearly.';
      if (!confirm(msg)) return;
      return runWebSearchQueue(queue, providerId);
    });
  }

  function runWebSearchQueue(queue, providerId) {
    if (helper && helper.setHeadingLabel) {
      helper.setHeadingLabel('CNfirmed (0/' + queue.length + ')');
    }
    var done = 0;
    var concurrency = 2;
    var inFlight = 0;
    var idx = 0;
    return new Promise(function (resolve) {
      function next() {
        while (inFlight < concurrency && idx < queue.length) {
          var i = queue[idx++];
          inFlight++;
          state[i] = { status: 'running', provider: providerId };
          renderRow(i); renderBadge(i);
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
                inFlight--; done++;
                persist(); renderRow(k); renderBadge(k); renderPanel(k);
                if (helper && helper.setHeadingLabel) {
                  helper.setHeadingLabel('CNfirmed (' + done + '/' + queue.length + ')');
                }
                if (idx >= queue.length && inFlight === 0) {
                  if (helper && helper.setHeadingLabel) {
                    helper.setHeadingLabel('CNfirmed (' + cnSups.length + ')');
                  }
                  toast('CNfirmed: web search complete');
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
   'most some any all can could would should may might will shall must ' +
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

  function foldText(text) {
    return normaliseDigits(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function wordsOf(text) {
    return normaliseDigits(text)
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
    var src = normaliseDigits(text).replace(/[‘’“”]/g, "'");
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
    var folded = foldText(text);
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
    wikiCorpusPromise = wikiFetchWikitext(WIKI_CODE, pageTitle).then(function (page) {
      var local = indexWikiArticle(WIKI_CODE, page.title, page.wikitext);
      var offsets = citationNeededOffsets(page.wikitext);
      var corpus = {
        local: local,
        sisters: [],
        linkTranslations: {},
        // Only trust the DOM-to-wikitext mapping when the counts agree; when
        // they do not, scoring falls back to section matching alone.
        claimOffsets: offsets.length === cnSups.length ? offsets : null,
        warnings: []
      };
      wikiCorpus = corpus;

      return wikiFetchLangLinks(WIKI_CODE, [page.title]).then(function (links) {
        var available = links[page.title] || {};
        var chosen = [];
        WIKI_SISTER_LANGS.forEach(function (code) {
          if (chosen.length >= WIKI_MAX_SISTERS) return;
          if (code === WIKI_CODE || !available[code]) return;
          chosen.push({ lang: code, title: available[code] });
        });
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
    var query = weightedTokensOf(ctx.claim + ' ' + ctx.context, background);
    var range = corpus.claimOffsets
      ? paragraphRangeAt(corpus.local.wikitext, corpus.claimOffsets[index].start)
      : null;

    var out = [];
    corpus.local.refs.forEach(function (ref) {
      if (ref.occurrence.group) return;
      var sameParagraph = !!range &&
        ref.occurrence.offset >= range.start && ref.occurrence.offset < range.end;
      var sameSection = !!ctx.section && ref.section === ctx.section;
      var proximity = sameParagraph ? 1 : sameSection ? 0.55 : 0.15;

      var lexical = coverageOf(query, refTextOf(ref.source) + ' ' + ref.sentence);
      // Outside the claim's own section, proximity says nothing: the reference
      // has to earn its place on what it is actually about.
      if (!sameParagraph && !sameSection && lexical < 0.3) return;

      var score = 0.6 * lexical + 0.4 * proximity;
      if (score < WIKI_MIN_SCORE) return;
      if (ref.source.url && isUnreliableDomain(ref.source.url)) return;
      if (!ref.source.url && score < WIKI_MIN_SCORE + 0.2) return;

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
      wikiState[index] = {
        status: 'done',
        candidates: findWikiCandidates(corpus, index),
        warnings: corpus.warnings
      };
      persistWiki();
      renderRow(index); renderBadge(index);
      return wikiState[index];
    }).catch(function (err) {
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

  // ---- Provider implementations -----------------------------------------

  function buildUserMessage(ctx) {
    return 'Claim: ' + ctx.claim + '\n\n' +
      'Context: ' + ctx.context + '\n\n' +
      'Section: ' + (ctx.section || '(none)') + '\n\n' +
      'Article: ' + pageTitle.replace(/_/g, ' ');
  }

  function callClaude(ctx, apiKey) {
    var body = {
      model: modelFor('claude'),
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 6 }
      ],
      messages: [{ role: 'user', content: buildUserMessage(ctx) }]
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
        var text = (data.content || [])
          .filter(function (b) { return b && b.type === 'text'; })
          .map(function (b) { return b.text; })
          .join('\n');
        return parseSuggestions(text);
      });
    });
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

  // ---- Popover (OOUI) ---------------------------------------------------

  var popoverIndex = null;

  // Self-managed floating panel. We deliberately do NOT use OO.ui.PopupWidget
  // here: its FloatableElement/ClippableElement/autoClose machinery proved
  // flaky without a configured anchor container — the popover frequently
  // failed to appear at all (the badge would spin, verification would finish,
  // but nothing showed), or snapped to the top of the article. This panel is a
  // plain DOM dialog docked to the bottom of the viewport (position: fixed), so
  // it stays in a stable, predictable place as the article scrolls and is
  // always visible while you look at the tag. It stays open until the user
  // dismisses it (× button, Escape, or opening a different claim).
  function ensurePopover() {
    if (popup) return popup;
    var $el = $('<div class="cnfirmed-panel" role="dialog" aria-label="CNfirmed">');
    var $header = $('<div class="cnfirmed-panel-header">');
    var $title = $('<span class="cnfirmed-panel-title">').text('CNfirmed');
    var $close = $('<button type="button" class="cnfirmed-panel-close" aria-label="Close">×</button>');
    $close.on('click', closePopover);
    $header.append($title, $close);
    var $body = $('<div class="cnfirmed-panel-body cnfirmed-popover">');
    $el.append($header, $body);
    $(document.body).append($el);
    popup = { $element: $el, $body: $body, $title: $title };
    return popup;
  }

  function openPopover(i) {
    popoverIndex = i;
    var p = ensurePopover();
    var ctx = claimContexts[i];
    p.$title.text(ctx && ctx.claim ? truncate(ctx.claim, 60) : 'CNfirmed');
    renderPanel(i);
    p.$element.addClass('cnfirmed-panel-visible');
  }

  // One renderer for the whole panel: the free wiki-local leads on top, then
  // whatever the paid web search has to say (or the button that starts it).
  function renderPanel(i) {
    if (i === null || i === undefined) return;
    if (popoverIndex !== i || !popup) return;
    var $el = popup.$body;
    $el.empty();
    renderWikiInto($el, i, wikiState[i] || { status: 'idle' });

    var s = state[i] || { status: 'idle' };
    if (s.status === 'running') {
      renderProgressInto($el, { phase: 'verifying', provider: s.provider });
    } else if (s.status === 'error') {
      $el.append($('<div>').css({ color: '#b32424', 'margin-top': '8px' })
        .text('Web search error: ' + s.error));
      renderWebSearchCta($el, i, 'Try the web search again');
    } else if (s.status === 'done' && s.result) {
      renderResultInto($el, i, s.result);
    } else {
      renderWebSearchCta($el, i, null);
    }
  }

  // The free stage: citations Wikipedia already holds for a sentence like this
  // one. Evidence, not a verdict — the editor reads the source and decides.
  function renderWikiInto($el, i, w) {
    var $section = $('<div class="cnfirmed-wiki">');
    if (w.status === 'running' || w.status === 'idle') {
      $section.append($('<div>').text('Checking sources already on Wikipedia…'));
      $section.append($('<div class="cnfirmed-note">')
        .text('This article\u2019s own references, and the same fact on other language editions. Free, no API key.'));
      $el.append($section);
      return;
    }
    if (w.status === 'error') {
      $section.append($('<div class="cnfirmed-note">')
        .css('color', '#b32424').text('Wiki lookup failed: ' + w.error));
      $el.append($section);
      return;
    }

    var candidates = w.candidates || [];
    if (candidates.length === 0) {
      $section.append($('<div class="cnfirmed-note">')
        .text('No citation on Wikipedia matches this claim.'));
      $el.append($section);
      return;
    }

    $section.append(
      $('<div class="cnfirmed-wiki-head">').text('Already on Wikipedia (' + candidates.length + ')')
    );
    candidates.slice(0, 3).forEach(function (c) {
      $section.append(renderWikiCandidate(i, c));
    });
    if (candidates.length > 3) {
      $section.append($('<button>').text('Show all (' + candidates.length + ')')
        .css('margin-top', '4px')
        .on('click', function () { showAllWikiDialog(i, candidates); }));
    }
    (w.warnings || []).forEach(function (warning) {
      $section.append($('<div class="cnfirmed-note">').text('! ' + warning));
    });
    $el.append($section);
  }

  function renderWikiCandidate(i, c) {
    var $row = $('<div class="cnfirmed-wiki-row">');
    var origin = c.evidence.origin;
    $row.append(
      $('<span class="cnfirmed-origin">').attr('data-origin', origin)
        .text(origin === 'sister-wiki' ? c.evidence.lang + '.wiki' : 'this article'),
      ' ',
      c.url
        ? $('<a>').attr({ href: c.url, target: '_blank', rel: 'noopener' }).text(c.title)
        : $('<span>').text(c.title)
    );
    if (c.url) {
      var domain = hostOf(c.url);
      if (domain) {
        $row.append($('<span class="cnfirmed-note">').text(' — ' + domain));
      }
    }
    $row.append($('<div class="cnfirmed-quote">').text(c.relevance));
    if (c.evidence.matchedAnchors && c.evidence.matchedAnchors.length) {
      $row.append($('<div class="cnfirmed-note">')
        .text('matched: ' + c.evidence.matchedAnchors.join(', ')));
    }

    var $tools = $('<div class="cnfirmed-toolbar">');
    $tools.append($('<button>').text('Copy <ref>').on('click', function () {
      navigator.clipboard.writeText(c.ref).then(function () {
        toast('Copied <ref> to clipboard');
      }, function () { toast('Copy failed'); });
    }));
    $tools.append(
      $('<button>').text('Insert <ref> in editor')
        .attr('title', 'Open the source editor with this <ref> substituted in for the {{citation needed}} tag')
        .on('click', function () {
          openEditorWithRef(i, { citation: { ref: c.ref } });
        })
    );
    $row.append($tools);
    return $row;
  }

  function showAllWikiDialog(i, candidates) {
    var $list = $('<div>');
    candidates.forEach(function (c) {
      $list.append(renderWikiCandidate(i, c).css({
        'border-bottom': '1px solid #eaecf0', padding: '6px 0'
      }));
    });
    OO.ui.alert($list, {
      title: 'Sources already on Wikipedia: ' + truncate(claimContexts[i].claim, 60),
      size: 'large'
    });
  }

  function renderWebSearchCta($el, i, label) {
    var providerId = getProvider();
    var hasKey = !!getKey(providerId);
    var $cta = $('<div class="cnfirmed-toolbar">');
    $cta.append(
      $('<button>')
        .text(label || ('Search the web with ' + PROVIDERS[providerId].name))
        .on('click', function () { runOne(i); })
    );
    $el.append($cta);
    $el.append($('<div class="cnfirmed-note">').text(
      hasKey
        ? 'One API call, billed to your key.'
        : 'Needs a ' + PROVIDERS[providerId].name + ' API key — you will be asked for one.'
    ));
  }

  function closePopover() {
    popoverIndex = null;
    if (popup) popup.$element.removeClass('cnfirmed-panel-visible');
  }

  function panelVisible() {
    return !!popup && popup.$element.hasClass('cnfirmed-panel-visible');
  }

  function renderProgressInto($el, progress) {
    var providerName = progress && progress.provider
      ? PROVIDERS[progress.provider].name
      : PROVIDERS[getProvider()].name;
    $el.append($('<div>').text('Searching with ' + providerName + '…'));
    $el.append($('<div>').css({ 'font-size': '0.85em', color: '#54595d', 'margin-top': '4px' })
      .text('Finding and verifying candidate sources. This usually takes 10–30 seconds.'));
  }

  function renderResultInto($el, i, result) {
    $el.append($('<div class="cnfirmed-wiki-head">')
      .text('From the web (' + PROVIDERS[result.provider || getProvider()].name + ')'));
    if (!result.suggestions || result.suggestions.length === 0) {
      $el.append($('<div>').text('No suitable sources found.'));
      $el.append($('<div class="cnfirmed-note">')
        .text('The model did not return any candidates that pass the WP:RSP filter.'));
      return;
    }
    var top = result.suggestions[0];
    var verdict = top.verdict.verdict;
    var rel = top.verdict.reliability;

    var $head = $('<div>').css({ 'margin-bottom': '6px' });
    $head.append(
      $('<span class="cnfirmed-pill">').attr('data-status', verdict).text(pillLabel(verdict))
    );
    $head.append(' ');
    $head.append(
      $('<span class="cnfirmed-rel">').attr('data-rel', rel).text('reliability: ' + rel)
    );
    $head.append(
      $('<span>').css({ float: 'right', 'font-size': '0.8em', color: '#54595d' })
        .text('confidence ' + top.verdict.confidence + '/100')
    );
    $el.append($head);

    var $title = $('<div>').css({ 'font-weight': 'bold' });
    var $a = $('<a>').attr({ href: top.source.url, target: '_blank', rel: 'noopener' })
      .text(top.source.title || top.source.url);
    $title.append($a);
    var domain = hostOf(top.source.url);
    if (domain) $title.append($('<span>').css({ color: '#72777d', 'font-weight': 'normal', 'font-size': '0.85em' }).text(' — ' + domain));
    $el.append($title);

    if (top.verdict.comments) {
      $el.append($('<div class="cnfirmed-quote">').text(top.verdict.comments));
    }
    if (top.verdict.reliabilityReason && rel === 'low') {
      $el.append(
        $('<div>').css({ 'font-size': '0.85em', color: '#b32424' })
          .text('⚠ ' + top.verdict.reliabilityReason)
      );
    }

    var $tools = $('<div class="cnfirmed-toolbar">');
    var $copy = $('<button>').text('Copy <ref>').on('click', function () {
      navigator.clipboard.writeText(top.citation.ref).then(function () {
        toast('Copied <ref> to clipboard');
      }, function () {
        toast('Copy failed');
      });
    });
    $tools.append($copy);
    var $insert = $('<button>')
      .text('Insert <ref> in editor')
      .attr('title', 'Open the source editor with this <ref> already substituted in for the {{citation needed}} tag')
      .on('click', function () { openEditorWithRef(i, top); });
    $tools.append($insert);
    if (result.suggestions.length > 1) {
      var $more = $('<button>').text('Show all (' + result.suggestions.length + ')')
        .on('click', function () { showAllDialog(i, result); });
      $tools.append($more);
    }
    $el.append($tools);
  }

  function showAllDialog(i, result) {
    var $list = $('<div>');
    result.suggestions.forEach(function (s) {
      var $row = $('<div>').css({
        'border-bottom': '1px solid #eaecf0',
        padding: '6px 0'
      });
      $row.append($('<div>').append(
        $('<span class="cnfirmed-pill">').attr('data-status', s.verdict.verdict).text(pillLabel(s.verdict.verdict)),
        ' ',
        $('<span class="cnfirmed-rel">').attr('data-rel', s.verdict.reliability).text(s.verdict.reliability),
        ' ',
        $('<a>').attr({ href: s.source.url, target: '_blank', rel: 'noopener' }).text(s.source.title || s.source.url)
      ));
      if (s.verdict.comments) {
        $row.append($('<div class="cnfirmed-quote">').text(s.verdict.comments));
      }
      var $copy = $('<button>').text('Copy <ref>').css('margin-top', '4px').on('click', function () {
        navigator.clipboard.writeText(s.citation.ref).then(function () { toast('Copied'); });
      });
      $row.append($copy);
      var $insertRow = $('<button>')
        .text('Insert <ref> in editor')
        .css({ 'margin-top': '4px', 'margin-left': '4px' })
        .on('click', function () { openEditorWithRef(i, s); });
      $row.append($insertRow);
      $list.append($row);
    });
    OO.ui.alert($list, {
      title: 'CNfirmed candidates: ' + truncate(result.claim.claim, 60),
      size: 'large'
    });
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

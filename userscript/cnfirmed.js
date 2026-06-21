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
    '.cnfirmed-popover .cnfirmed-quote {',
    '  font-style: italic; color: #54595d;',
    '  border-left: 3px solid #c8ccd1; padding: 4px 8px;',
    '  margin: 6px 0; font-size: 0.9em;',
    '}',
    '.cnfirmed-popover .cnfirmed-toolbar { display: flex; gap: 6px; margin-top: 8px; }',
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

  var cnSups = [];        // rendered <sup> nodes, in document order
  var badges = [];        // matching <span class="cnfirmed-badge"> nodes
  var claimContexts = []; // { claim, context, section } per CN, extracted on demand
  var state = {};         // { [index]: { status, result?, error?, provider? } }
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
    if (!block) return { claim: '', context: '', section: null };

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
    var pos = text.indexOf(marker);
    if (pos < 0) {
      return { claim: text, context: text, section: section };
    }
    var before = text.slice(0, pos).replace(/\s+$/, '');
    var after = text.slice(pos + marker.length).replace(/^\s+/, '');
    var claim = lastSentenceOf(before) || before;
    var context = (before + ' ' + after).replace(/\s+/g, ' ').trim();
    return { claim: claim, context: context, section: section };
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
    var pillStatus = s.status;
    if (s.status === 'done' && s.result && s.result.suggestions[0]) {
      pillStatus = s.result.suggestions[0].verdict.verdict;
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
    if (s.status === 'done' && s.result && s.result.suggestions[0]) {
      badge.setAttribute('data-cnfirmed-status', s.result.suggestions[0].verdict.verdict);
    } else if (s.status === 'error') {
      badge.setAttribute('data-cnfirmed-status', 'error');
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

  function onBadgeClick(i) {
    var s = state[i];
    if (s && s.status === 'done' && s.result) {
      openPopover(i, s.result, null);
      return;
    }
    if (s && s.status === 'running') {
      openPopover(i, null, { phase: 'verifying' });
      return;
    }
    runOne(i);
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
      renderRow(i); renderBadge(i); persist();
      updatePopoverError(i, msg);
      return;
    }

    state[i] = { status: 'running', provider: providerId };
    renderRow(i); renderBadge(i);
    openPopover(i, null, { phase: 'finding', provider: providerId });

    PROVIDERS[providerId].run(ctx, key)
      .then(function (suggestions) {
        var ranked = rankSuggestions(suggestions);
        var result = { claim: ctx, suggestions: ranked, provider: providerId };
        state[i] = { status: 'done', result: result, provider: providerId };
        persist(); renderRow(i); renderBadge(i);
        updatePopoverResult(i, result);
      })
      .catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        state[i] = { status: 'error', error: msg, provider: providerId };
        persist(); renderRow(i); renderBadge(i);
        updatePopoverError(i, msg);
      });
  }

  function verifyAll() {
    var providerId = getProvider();
    if (!getKey(providerId)) {
      toast('Set your ' + PROVIDERS[providerId].name + ' API key first');
      promptForKey(providerId).then(function (ok) { if (ok) verifyAll(); });
      return;
    }
    var pending = 0;
    for (var i = 0; i < cnSups.length; i++) {
      var s = state[i] || {};
      if (s.status !== 'done') pending++;
    }
    if (pending === 0) {
      toast('All claims already verified (clear cache to re-run)');
      return;
    }
    var msg = 'Verify ' + pending + ' unverified claim(s) using ' +
      PROVIDERS[providerId].name + '? This will make ' + pending +
      ' API call(s) (one per claim) — costs scale linearly.';
    if (!confirm(msg)) return;

    if (helper && helper.setHeadingLabel) {
      helper.setHeadingLabel('CNfirmed (0/' + cnSups.length + ')');
    }
    var done = 0;
    var queue = [];
    for (var j = 0; j < cnSups.length; j++) {
      if (!(state[j] && state[j].status === 'done')) queue.push(j);
    }
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
                persist(); renderRow(k); renderBadge(k);
                if (helper && helper.setHeadingLabel) {
                  helper.setHeadingLabel('CNfirmed (' + done + '/' + cnSups.length + ')');
                }
                if (idx >= queue.length && inFlight === 0) {
                  if (helper && helper.setHeadingLabel) {
                    helper.setHeadingLabel('CNfirmed (' + cnSups.length + ')');
                  }
                  toast('CNfirmed: verify-all complete');
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

  function openPopover(i, result, progress) {
    popoverIndex = i;
    var p = ensurePopover();
    var ctx = claimContexts[i];
    p.$title.text(ctx && ctx.claim ? truncate(ctx.claim, 60) : 'CNfirmed');
    p.$body.empty();
    if (result) renderResultInto(p.$body, i, result);
    else renderProgressInto(p.$body, progress);
    p.$element.addClass('cnfirmed-panel-visible');
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

  function updatePopoverProgress(i, progress) {
    if (popoverIndex !== i || !popup) return;
    popup.$body.empty();
    renderProgressInto(popup.$body, progress);
  }

  function updatePopoverResult(i, result) {
    if (popoverIndex !== i || !popup) return;
    popup.$body.empty();
    renderResultInto(popup.$body, i, result);
  }

  function updatePopoverError(i, message) {
    if (popoverIndex !== i || !popup) return;
    popup.$body.empty();
    popup.$body.append($('<div>').css('color', '#b32424').text('Error: ' + message));
  }

  function renderResultInto($el, i, result) {
    if (!result.suggestions || result.suggestions.length === 0) {
      $el.append($('<div>').text('No suitable sources found.'));
      $el.append($('<div>').css({ 'font-size': '0.85em', color: '#54595d', 'margin-top': '4px' })
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

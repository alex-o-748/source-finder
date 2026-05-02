/**
 * CNfirmed user script — finds and verifies sources for {{citation needed}}
 * claims via a self-hosted backend that wraps the CNfirmed core library.
 *
 * Install: copy this file to User:Yourname/cnfirmed.js, then add to
 * User:Yourname/common.js:
 *
 *   window.cnfirmedBackend = 'http://localhost:3939';   // optional override
 *   importScript('User:Yourname/cnfirmed.js');
 *
 * The backend must be reachable from your browser. Run it locally with
 * `npm run server` from the source-finder repo (default port 3939).
 *
 * UX:
 *   - A small 🔍 badge appears next to every [citation needed] superscript.
 *     Click it to verify that one claim.
 *   - A "CNfirmed" portlet appears in the sidebar with one row per CN tag,
 *     showing live status. Click a row to scroll to the badge.
 *   - "Verify all" runs the whole article (with a confirm prompt — costs
 *     scale with the number of claims).
 *
 * Reuses User:Polygnotus/Helpers/Sidebar.js for portlet plumbing.
 */
/* eslint-disable */
(function () {
  'use strict';

  // ---- Boot guards ------------------------------------------------------

  if (window.cnfirmedLoaded) return;
  window.cnfirmedLoaded = true;

  if (mw.config.get('wgNamespaceNumber') !== 0) return;
  if (mw.config.get('wgAction') !== 'view') return;
  if (!/wikipedia\.org$/.test(mw.config.get('wgServer') || '')) return;

  var BACKEND = (window.cnfirmedBackend || 'http://localhost:3939').replace(/\/$/, '');

  var SIDEBAR_HELPER_URL =
    'https://en.wikipedia.org/w/index.php?title=User:Polygnotus/Helpers/Sidebar.js&action=raw&ctype=text/javascript';

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

    '.cnfirmed-popover { max-width: 360px; }',
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
    '  transition: opacity 0.2s;',
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
  var claims = [];        // from /scan, indexed identically
  var state = {};         // { [index]: { status, result?, error? } }
  var helper = null;      // SidebarHelper instance
  var popup = null;       // OO.ui.PopupWidget singleton

  // ---- Boot sequence ----------------------------------------------------

  $(function () {
    // Discover CN tags first so we can bail if there are none.
    cnSups = Array.prototype.slice.call(
      document.querySelectorAll('sup.Template-Fact')
    );
    if (cnSups.length === 0) return;

    insertBadges();

    mw.loader.using(['mediawiki.util', 'oojs-ui-windows', 'oojs-ui-core'])
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
    buildSidebar();          // empty shell first
    fetchScan();              // populates claims[] then re-renders
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

  // ---- Sidebar ----------------------------------------------------------

  function buildSidebar() {
    if (!window.SidebarHelper) return;
    helper = window.SidebarHelper({
      id: 'p-cnfirmed',
      storageKey: 'cnfirmed-collapsed',
      heading: 'CNfirmed (' + cnSups.length + ')',
      btnClass: 'cnfirmed-collapse-btn',
      onExpand: function () { /* nothing — data already loaded on boot */ }
    });
    helper.replaceRows(buildSidebarUl());
    addVerifyAllButton();
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

    var c = claims[i];
    var s = state[i] || { status: 'idle' };

    var claimSpan = document.createElement('span');
    claimSpan.className = 'cnfirmed-row-claim';
    claimSpan.textContent = c ? truncate(c.claim, 80) : 'Loading…';

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
    if (existing) {
      ul.replaceChild(fresh, existing);
    } else {
      ul.appendChild(fresh);
    }
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

  // ---- Network: /scan ---------------------------------------------------

  function fetchScan() {
    var url = BACKEND + '/scan?article=' + encodeURIComponent(pageTitle);
    fetch(url, { method: 'GET' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.claims)) {
          throw new Error('unexpected /scan response');
        }
        claims = data.claims;
        if (claims.length !== cnSups.length) {
          console.warn(
            '[CNfirmed] DOM has ' + cnSups.length +
            ' CN tags but extractor found ' + claims.length +
            '. Indexing may misalign.'
          );
        }
        // Rebuild sidebar with claim text now available.
        if (helper) {
          helper.replaceRows(buildSidebarUl());
          addVerifyAllButton();
          helper.markDataLoaded();
        }
        // Repaint badges from cache (in case state was hydrated before
        // claims were known).
        for (var i = 0; i < cnSups.length; i++) renderBadge(i);
      })
      .catch(function (err) {
        console.error('[CNfirmed] /scan failed:', err);
        toast('CNfirmed: backend unreachable at ' + BACKEND);
      });
  }

  // ---- Network: SSE consumer -------------------------------------------

  function streamSSE(url, init, handlers) {
    return fetch(url, init).then(function (res) {
      if (!res.ok || !res.body) {
        throw new Error('HTTP ' + res.status);
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            if (buf.trim()) parseSSEBlock(buf, handlers);
            handlers.close && handlers.close();
            return;
          }
          buf += decoder.decode(chunk.value, { stream: true });
          var parts = buf.split('\n\n');
          buf = parts.pop() || '';
          parts.forEach(function (block) { parseSSEBlock(block, handlers); });
          return pump();
        });
      }
      return pump();
    });
  }

  function parseSSEBlock(block, handlers) {
    var lines = block.split('\n');
    var event = 'message';
    var data = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
    }
    if (!data) return;
    var parsed;
    try { parsed = JSON.parse(data); } catch (e) { return; }
    if (handlers.event) handlers.event(event, parsed);
  }

  // ---- Network: /verify-claim ------------------------------------------

  function onBadgeClick(i) {
    var s = state[i];
    if (s && s.status === 'done' && s.result) {
      openPopover(i, s.result, null);
      return;
    }
    if (s && s.status === 'running') {
      openPopover(i, null, { phase: s.lastPhase || 'verifying' });
      return;
    }
    state[i] = { status: 'running' };
    renderRow(i);
    renderBadge(i);
    openPopover(i, null, { phase: 'finding' });

    var url = BACKEND + '/verify-claim';
    streamSSE(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        articleTitle: pageTitle,
        revid: revid,
        claimIndex: i
      })
    }, {
      event: function (event, data) {
        if (event === 'claim-progress') {
          state[i].lastPhase = data.phase;
          updatePopoverProgress(i, data);
        } else if (event === 'claim-result') {
          state[i] = { status: 'done', result: data.result };
          persist();
          renderRow(i);
          renderBadge(i);
          updatePopoverResult(i, data.result);
        } else if (event === 'error') {
          state[i] = { status: 'error', error: data.message };
          persist();
          renderRow(i);
          renderBadge(i);
          updatePopoverError(i, data.message);
        }
      }
    }).catch(function (err) {
      state[i] = { status: 'error', error: err.message };
      persist();
      renderRow(i);
      renderBadge(i);
      updatePopoverError(i, err.message);
    });
  }

  // ---- Network: /verify-article (verify all) ----------------------------

  function verifyAll() {
    var pending = 0;
    for (var i = 0; i < cnSups.length; i++) {
      var s = state[i] || {};
      if (s.status !== 'done') pending++;
    }
    var msg = 'Verify ' + pending + ' unverified claim(s)? ' +
      'This will use roughly ' + (pending * 4) + ' Claude calls (1 search + 3 verifications each).';
    if (!confirm(msg)) return;

    // Mark all as running.
    for (var j = 0; j < cnSups.length; j++) {
      if (!(state[j] && state[j].status === 'done')) {
        state[j] = { status: 'running' };
        renderRow(j);
        renderBadge(j);
      }
    }

    var url = BACKEND + '/verify-article';
    streamSSE(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleTitle: pageTitle })
    }, {
      event: function (event, data) {
        if (event === 'started' && helper) {
          helper.setHeadingLabel('CNfirmed (0/' + data.total + ')');
        } else if (event === 'claim-progress' && helper) {
          helper.setHeadingLabel('CNfirmed (' + data.done + '/' + data.total + ')');
        } else if (event === 'claim-result') {
          state[data.index] = { status: 'done', result: data.result };
          persist();
          renderRow(data.index);
          renderBadge(data.index);
        } else if (event === 'done' && helper) {
          helper.setHeadingLabel('CNfirmed (' + cnSups.length + ')');
          toast('CNfirmed: verify-all complete');
        } else if (event === 'error') {
          toast('CNfirmed: ' + data.message);
        }
      }
    }).catch(function (err) {
      toast('CNfirmed: verify-all failed — ' + err.message);
    });
  }

  // ---- Popover (OOUI) ---------------------------------------------------

  var popoverIndex = null;

  function ensurePopover() {
    if (popup) return popup;
    popup = new OO.ui.PopupWidget({
      padded: true,
      width: 380,
      autoClose: true,
      align: 'center',
      classes: ['cnfirmed-popover']
    });
    $(document.body).append(popup.$element);
    return popup;
  }

  function openPopover(i, result, progress) {
    popoverIndex = i;
    var p = ensurePopover();
    var $body = p.$body || p.$element;
    $body.empty();
    if (result) renderResultInto($body, i, result);
    else renderProgressInto($body, progress);
    var sup = cnSups[i];
    var badge = badges[i];
    p.$element.css({
      position: 'absolute',
      'z-index': 9999
    });
    var anchor = badge || sup;
    if (anchor) {
      var rect = anchor.getBoundingClientRect();
      p.$element.css({
        left: (window.scrollX + rect.left) + 'px',
        top: (window.scrollY + rect.bottom + 6) + 'px'
      });
    }
    p.toggle(true);
  }

  function renderProgressInto($el, progress) {
    var phase = (progress && progress.phase) || 'finding';
    var msg;
    if (phase === 'finding') msg = 'Finding candidate sources…';
    else if (phase === 'verifying' && progress.candidate)
      msg = 'Verifying ' + (progress.i || '?') + '/' + (progress.n || '?') +
            ': ' + (progress.candidate.title || progress.candidate.url);
    else if (phase === 'verifying') msg = 'Verifying candidates…';
    else msg = phase;
    $el.append($('<div>').text(msg));
  }

  function updatePopoverProgress(i, progress) {
    if (popoverIndex !== i || !popup) return;
    var $body = popup.$body || popup.$element;
    $body.empty();
    renderProgressInto($body, progress);
  }

  function updatePopoverResult(i, result) {
    if (popoverIndex !== i || !popup) return;
    var $body = popup.$body || popup.$element;
    $body.empty();
    renderResultInto($body, i, result);
  }

  function updatePopoverError(i, message) {
    if (popoverIndex !== i || !popup) return;
    var $body = popup.$body || popup.$element;
    $body.empty();
    $body.append($('<div>').css('color', '#b32424').text('Error: ' + message));
  }

  function renderResultInto($el, i, result) {
    if (!result.suggestions || result.suggestions.length === 0) {
      $el.append($('<div>').text('No candidate sources found.'));
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
    var domain = '';
    try { domain = new URL(top.source.url).hostname.replace(/^www\./, ''); } catch (e) {}
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
    if (result.suggestions.length > 1) {
      var $more = $('<button>').text('Show all (' + result.suggestions.length + ')')
        .on('click', function () { showAllDialog(i, result); });
      $tools.append($more);
    }
    $el.append($tools);
  }

  function showAllDialog(i, result) {
    var $list = $('<div>');
    result.suggestions.forEach(function (s, idx) {
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
      $list.append($row);
      void idx;
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
    }, 2200);
  }
})();

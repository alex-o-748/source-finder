// Recording harness for the CNfirmed tutorial.
//
// - Every request the browser makes goes through a disk cache, so a scene can
//   be re-recorded with the same data, and Wikimedia's rate limits (quick to
//   reach from a shared cloud IP) are only met once per request.
// - The tutorial reenacts the author's own CNfirmed edits, so an article in
//   PAGES is served as its revision *before* that edit: the old revision's
//   HTML (with the current page's section [edit] links put back), its
//   wikitext for the API, and its text in the editor.
// - The user script is loaded the way importScript loads it, from the local
//   repository checkout.
// - A fake cursor, click ripples and captions are drawn in the page, and
//   frames are captured with the DevTools screencast.

import { createRequire } from 'node:module';
// Playwright from node_modules or NODE_PATH, or PW_PATH (a global install's index.js).
export const { chromium } = createRequire(import.meta.url)(process.env.PW_PATH || 'playwright');
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.dirname(new URL(import.meta.url).pathname);
export const CACHE = path.join(ROOT, 'cache');
export const REPO = process.env.CNFIRMED_REPO || path.resolve(ROOT, '..');
fs.mkdirSync(CACHE, { recursive: true });

// title → revision before the author's CNfirmed edit
export const PAGES = {
  Battle_of_France: 1381720666,
  United_States_Congress: 1379599281,
  Airbus: 1380076173,
  'Dwight_D._Eisenhower': 1379911963
};

const SCRIPT_URL_RE = /^https:\/\/en\.wikipedia\.org\/w\/index\.php\?title=User:Alaexis\/CNfirmed\.js&action=raw/;
const DROP_PARAMS = ['cnfirmed-insert', 'cnfirmedInsert'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!process.env.QUIET) console.log('[harness]', ...a); };

function normTitle(t) { return decodeURIComponent(String(t || '')).replace(/ /g, '_'); }

// ---- URL rewriting for the old-revision reenactment -----------------------

function rewrite(urlStr, method, resourceType) {
  const u = new URL(urlStr);
  for (const p of DROP_PARAMS) u.searchParams.delete(p);
  const out = { upstream: u.toString(), key: u.toString(), kind: 'plain' };
  if (u.hostname !== 'en.wikipedia.org') return out;

  const wikiMatch = u.pathname.match(/^\/wiki\/(.+)$/);
  if (wikiMatch && method === 'GET' && resourceType === 'document') {
    const t = normTitle(wikiMatch[1]);
    if (PAGES[t]) return { ...out, kind: 'article', title: t };
  }
  if (u.pathname === '/w/api.php' && method === 'GET') {
    const titles = u.searchParams.get('titles');
    const prop = u.searchParams.get('prop') || '';
    const rvprop = u.searchParams.get('rvprop') || '';
    if (titles && PAGES[normTitle(titles)] && /revisions/.test(prop) && /content/.test(rvprop)) {
      u.searchParams.delete('titles');
      u.searchParams.delete('redirects');
      u.searchParams.set('revids', String(PAGES[normTitle(titles)]));
      return { ...out, upstream: u.toString(), key: u.toString() };
    }
  }
  if (u.pathname === '/w/index.php') {
    const t = normTitle(u.searchParams.get('title'));
    const action = u.searchParams.get('action');
    if (PAGES[t] && (action === 'edit' || action === 'submit') && method === 'GET') {
      u.searchParams.set('oldid', String(PAGES[t]));
      return { ...out, upstream: u.toString(), key: u.toString() };
    }
  }
  return out;
}

// ---- Cache ---------------------------------------------------------------

function keyHash(method, key, body) {
  return crypto.createHash('sha1').update(method + ' ' + key + '\n' + (body || '')).digest('hex');
}

function cacheGet(h) {
  const meta = path.join(CACHE, h + '.json');
  if (!fs.existsSync(meta)) return null;
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  m.body = fs.readFileSync(path.join(CACHE, h + '.bin'));
  return m;
}

function cachePut(h, entry) {
  const { body, ...meta } = entry;
  fs.writeFileSync(path.join(CACHE, h + '.bin'), body);
  fs.writeFileSync(path.join(CACHE, h + '.json'), JSON.stringify(meta, null, 1));
}

const HOP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'keep-alive']);

async function fetchUpstream(route, url, { method, postData, headers }) {
  let wait = 5000;
  for (let attempt = 1; attempt <= 25; attempt++) {
    const t0 = Date.now();
    let resp;
    try {
      resp = await route.fetch({ url, method, postData, headers, timeout: 240000, maxRedirects: 10 });
    } catch (e) {
      if (/Target page, context or browser has been closed|Route is already handled/.test(String(e))) throw e;
      log('fetch error', url.slice(0, 120), String(e).slice(0, 120), 'retry', attempt);
      await sleep(wait); wait = Math.min(wait * 2, 60000);
      continue;
    }
    const status = resp.status();
    // 429/503: wait and ask again, as long as it takes. 502/504 (a gateway
    // giving up on a slow upstream): twice more, then let the script see it.
    const gateway = status === 502 || status === 504;
    if (status === 429 || status === 503 || (gateway && attempt <= 2)) {
      const ra = Number(resp.headers()['retry-after']) || 0;
      const ms = Math.min(Math.max(ra * 1000, wait), 120000) + Math.random() * 3000;
      log(status, url.slice(0, 140), 'waiting', Math.round(ms / 1000) + 's', 'attempt', attempt);
      await sleep(ms); wait = Math.min(wait * 1.5, 60000);
      continue;
    }
    const body = await resp.body();
    const hdrs = {};
    for (const [k, v] of Object.entries(resp.headers())) if (!HOP.has(k.toLowerCase())) hdrs[k] = v;
    return { status, headers: hdrs, body, ms: Date.now() - t0, url };
  }
  throw new Error('gave up on ' + url);
}

// Old revision's HTML with the current revision's section [edit] links.
function transplantEditLinks(oldHtml, curHtml) {
  const spans = {};
  const re = /<h([1-6]) id="([^"]+)"[^>]*>[\s\S]*?<\/h\1>(<span class="mw-editsection">[\s\S]*?<\/span><\/span>)/g;
  let m;
  while ((m = re.exec(curHtml))) spans[m[2]] = m[3];
  let n = 0;
  const html = oldHtml.replace(/(<h([1-6]) id="([^"]+)"[^>]*>[\s\S]*?<\/h\2>)(<\/div>)/g, (all, h, lvl, id, close) => {
    if (!spans[id]) return all;
    n++;
    return h + spans[id] + close;
  });
  log('edit links put back:', n);
  return html;
}

// ---- Routing -------------------------------------------------------------

// A model call that came back without an answer is not kept: the script
// retries it, and the retry must reach the model, not this cache.
function failedModelReply(url, entry) {
  if (!/workers\.dev\/hf/.test(url)) return false;
  if (entry.status >= 400) return true;
  try {
    const msg = JSON.parse(entry.body.toString('utf8')).choices[0].message;
    return !msg.content;
  } catch (e) { return true; }
}

export function latencyDefault(url, recordedMs) {
  if (/\/w\/load\.php|upload\.wikimedia\.org|\/static\//.test(url)) return 0;
  if (/archive\.org/.test(url)) return Math.min(recordedMs * 0.12, 2600);
  if (/workers\.dev/.test(url)) return Math.min(recordedMs * 0.15, 3200);
  if (/toolforge/.test(url)) return Math.min(recordedMs * 0.2, 2500);
  if (/api\.php|rest_v1/.test(url)) return Math.min(recordedMs, 350);
  return Math.min(recordedMs, 250);
}

// Replay latency, changeable mid-scene: LATENCY.fn(url, recordedMs) → ms.
export const LATENCY = { fn: latencyDefault };

export async function installRoutes(context, opts = {}) {
  const latency = (u, ms) => (opts.latency || LATENCY.fn)(u, ms);
  const stats = { hit: 0, miss: 0, misses: [] };
  context._tutStats = stats;
  await context.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) return route.continue();

    if (SCRIPT_URL_RE.test(url)) {
      const body = fs.readFileSync(path.join(REPO, 'userscript/cnfirmed.js'));
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' }, body });
    }
    // Never load captchas (nothing here edits); and whatever the scene blocks.
    if (/hcaptcha|intake-analytics|\/v2\/events|\/beacon\//.test(url) || (opts.block && opts.block(url))) return route.abort();

    const rw = rewrite(url, method, req.resourceType());
    const postData = req.postDataBuffer();
    const h = keyHash(method, rw.key, postData ? postData.toString('utf8') : '');
    let entry = cacheGet(h);
    try {
      if (!entry) {
        stats.miss++; stats.misses.push(method + ' ' + rw.key.slice(0, 160));
        if (opts.offline) {
          log('OFFLINE MISS', method, rw.key.slice(0, 160));
          return route.abort();
        }
        if (rw.kind === 'article') {
          const oldUrl = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(rw.title)}&oldid=${PAGES[rw.title]}`;
          const old = await fetchUpstream(route, oldUrl, { method: 'GET' });
          const cur = await fetchUpstream(route, url, { method: 'GET' });
          const html = transplantEditLinks(old.body.toString('utf8'), cur.body.toString('utf8'));
          entry = { url, status: 200, headers: cur.headers, body: Buffer.from(html, 'utf8'), ms: old.ms };
        } else {
          entry = await fetchUpstream(route, rw.upstream, { method, postData: postData || undefined, headers: req.headers() });
        }
        entry.method = method;
        entry.key = rw.key;
        if (!failedModelReply(url, entry)) cachePut(h, entry);
      } else {
        stats.hit++;
        const d = latency(url, entry.ms || 0);
        if (d > 0) await sleep(d);
      }
      await route.fulfill({ status: entry.status, headers: entry.headers, body: entry.body });
    } catch (e) {
      if (!/closed|already handled/.test(String(e))) log('route error', url.slice(0, 120), String(e).slice(0, 200));
      try { await route.abort(); } catch (_) {}
    }
  });
}

// ---- In-page overlay: cursor, ripples, captions, script loader -------------

export const OVERLAY = () => {
  if (window.top !== window) return;
  const CSS = `
  #tut-cursor{position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;
    transform:translate(var(--x,-200px),var(--y,-200px));will-change:transform}
  #tut-cursor svg{display:block;width:24px;height:24px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4))}
  .tut-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;
    border-radius:50%;border:2.5px solid rgba(51,102,204,.95);background:rgba(51,102,204,.16);animation:tutRipple .55s ease-out forwards}
  @keyframes tutRipple{from{transform:scale(.25);opacity:1}to{transform:scale(1.35);opacity:0}}
  #tut-caption{position:fixed;bottom:30px;z-index:2147483645;pointer-events:none;box-sizing:border-box;
    padding:7px 13px 8px;border-radius:3px;background:rgba(32,33,34,.93);color:#fff;
    font:500 20px/1.32 Inter,"Liberation Sans",sans-serif;letter-spacing:-0.005em;
    opacity:0;transform:translate(-50%,8px);transition:opacity .28s ease,transform .28s ease;text-align:center;white-space:pre-line}
  #tut-caption.on{opacity:1;transform:translate(-50%,0)}
  #tut-ring{position:fixed;z-index:2147483644;pointer-events:none;border:3px solid #f0b400;border-radius:6px;
    box-shadow:0 0 0 4px rgba(240,180,0,.25);opacity:0;transition:opacity .25s}
  #tut-ring.on{opacity:1}
  #siteNotice,#centralNotice,.mw-revision,#mw-revision-info,#mw-revision-nav,
  .cdx-message.mw-revision,#mw-editing-old-revision,.mw-editing-old-revision,
  #mw-anon-edit-warning,.mw-anon-edit-warning,#mw-temp-user-banner,.mw-temp-account-banner{display:none !important}
  `;
  const CURSOR = '<svg viewBox="0 0 24 24"><path d="M3.5 2.2 3.6 19.4 8.1 15.2 11.1 22 14.2 20.7 11.3 14 17.6 13.8Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  function setup() {
    if (document.getElementById('tut-cursor') || !document.body) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'tut-cursor'; c.innerHTML = CURSOR; document.body.appendChild(c);
    const cap = document.createElement('div'); cap.id = 'tut-caption'; document.body.appendChild(cap);
    const ring = document.createElement('div'); ring.id = 'tut-ring'; document.body.appendChild(ring);
    const init = window.__tutInitPos;
    if (init) { c.style.setProperty('--x', init[0] + 'px'); c.style.setProperty('--y', init[1] + 'px'); }
    if (!window.__tutShowCursor) c.style.display = 'none';
  }
  window.__tutShowCursor = true;
  window.addEventListener('mousemove', (e) => {
    const c = document.getElementById('tut-cursor');
    if (c) { c.style.setProperty('--x', e.clientX + 'px'); c.style.setProperty('--y', e.clientY + 'px'); }
  }, true);
  window.addEventListener('mousedown', (e) => {
    const r = document.createElement('div'); r.className = 'tut-ripple';
    r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    document.body.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
  window.__tutCursorAt = (x, y) => {
    window.__tutInitPos = [x, y];
    const c = document.getElementById('tut-cursor');
    if (c) { c.style.setProperty('--x', x + 'px'); c.style.setProperty('--y', y + 'px'); }
  };
  window.__tutCursorVisible = (on) => {
    window.__tutShowCursor = on;
    const c = document.getElementById('tut-cursor'); if (c) c.style.display = on ? '' : 'none';
  };
  function captionBox() {
    const root = document.documentElement;
    const panel = document.getElementById('cnfirmed-panel');
    let right = window.innerWidth;
    if (panel && !panel.hidden && root.classList.contains('cnfirmed-panel-open')) right -= panel.getBoundingClientRect().width;
    return right;
  }
  window.__tutCaption = (text) => {
    setup();
    const cap = document.getElementById('tut-caption');
    const right = captionBox();
    cap.style.left = (right / 2) + 'px';
    cap.style.maxWidth = Math.min(right - 48, 760) + 'px';
    if (!text) { cap.classList.remove('on'); return; }
    if (cap.classList.contains('on') && cap.textContent !== text) {
      cap.classList.remove('on');
      setTimeout(() => { cap.textContent = text; cap.classList.add('on'); }, 260);
    } else { cap.textContent = text; cap.classList.add('on'); }
  };
  window.__tutRing = (sel, pad) => {
    setup();
    const ring = document.getElementById('tut-ring');
    const el = sel ? document.querySelector(sel) : null;
    if (!el) { ring.classList.remove('on'); return; }
    const r = el.getBoundingClientRect(); pad = pad || 4;
    Object.assign(ring.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + 2 * pad) + 'px', height: (r.height + 2 * pad) + 'px' });
    ring.classList.add('on');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup); else setup();

  // No Page Previews cards popping up under the moving cursor.
  try { if (location.hostname.endsWith('wikipedia.org')) localStorage.setItem('mwe-popups-enabled', '0'); } catch (e) {}

  // importScript('User:Alaexis/CNfirmed.js'), as common.js would do it.
  if (location.hostname === 'en.wikipedia.org' && !window.__tutNoScript) {
    const t = setInterval(() => {
      if (!(window.mw && mw.loader && mw.loader.using && window.jQuery)) return;
      clearInterval(t);
      mw.loader.using(['mediawiki.util']).then(() => {
        if (window.__tutNoScript) return;
        mw.loader.load('https://en.wikipedia.org/w/index.php?title=User:Alaexis/CNfirmed.js&action=raw&ctype=text/javascript');
      });
    }, 25);
  }
};

// ---- Browser -------------------------------------------------------------

export const VIEW = { width: 1280, height: 720, scale: 1.5 };

export async function launch(opts = {}) {
  const browser = await chromium.launch({
    proxy: { server: process.env.HTTPS_PROXY || 'http://127.0.0.1:35663' },
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--hide-scrollbars']
  });
  const context = await browser.newContext({
    viewport: { width: VIEW.width, height: VIEW.height },
    deviceScaleFactor: VIEW.scale,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    permissions: ['clipboard-read', 'clipboard-write']
  });
  // Vector 2022: contents and appearance menus collapsed, as a reader who
  // hid them would have it, so the article keeps its width beside the panel.
  await context.addCookies([{ name: 'enwikimwclientpreferences',
    value: 'vector-feature-toc-pinned-clientpref-0%2Cvector-feature-appearance-pinned-clientpref-0',
    domain: 'en.wikipedia.org', path: '/' }]);
  if (opts.init) await context.addInitScript(opts.init);
  await context.addInitScript(OVERLAY);
  await installRoutes(context, opts);
  return { browser, context };
}

// ---- Screencast recorder ---------------------------------------------------

export class Recorder {
  constructor(dir) {
    this.dir = dir;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this.frames = [];
    this.recording = false;
    this.session = null;
    this.n = 0;
    this.marks = {};
  }
  // A named moment in the take, for compose.py's speed-ups.
  mark(name) {
    this.marks[name] = Date.now() / 1000 - this.t0;
  }
  async attach(page) {
    if (this.session) {
      try { await this.session.send('Page.stopScreencast'); } catch (_) {}
      try { await this.session.detach(); } catch (_) {}
    }
    this.page = page;
    const s = await page.context().newCDPSession(page);
    this.session = s;
    s.on('Page.screencastFrame', (f) => {
      if (this.recording && s === this.session) {
        const file = path.join(this.dir, String(++this.n).padStart(6, '0') + '.jpg');
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
        this.frames.push({ t: Date.now() / 1000, file });
      }
      s.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await s.send('Page.startScreencast', { format: 'jpeg', quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  }
  async start() {
    this.recording = true;
    this.t0 = Date.now() / 1000;
    // A frame now, so the scene starts on the current picture.
    if (this.page) await this.snap();
  }
  async snap() {
    const file = path.join(this.dir, String(++this.n).padStart(6, '0') + '.jpg');
    await this.page.screenshot({ path: file, type: 'jpeg', quality: 93 });
    this.frames.push({ t: Date.now() / 1000, file });
  }
  async stop() {
    this.recording = false;
    this.tEnd = Date.now() / 1000;
    try { await this.session.send('Page.stopScreencast'); } catch (_) {}
    const list = this.frames.slice().sort((a, b) => a.t - b.t);
    fs.writeFileSync(path.join(this.dir, 'timeline.json'), JSON.stringify({ t0: this.t0, tEnd: this.tEnd, marks: this.marks, frames: list.map((f) => ({ t: f.t, file: path.basename(f.file) })) }));
    return list;
  }
}

// ---- Director: scripted mouse, captions, waits ------------------------------

export class Director {
  constructor(page, rec) {
    this.page = page;
    this.rec = rec;
    this.x = 900; this.y = 420;
  }
  async use(page) {
    this.page = page;
    await page.evaluate(([x, y]) => window.__tutCursorAt && window.__tutCursorAt(x, y), [this.x, this.y]).catch(() => {});
    if (this.rec) await this.rec.attach(page);
  }
  async caption(text, hold = 0) {
    if (this.rec && this.rec.t0) console.log(`  ${(Date.now() / 1000 - this.rec.t0).toFixed(1)}s caption: ${(text || '—').slice(0, 70)}`);
    await this.page.evaluate((t) => window.__tutCaption && window.__tutCaption(t), text || '');
    if (hold) await sleep(hold);
  }
  async ring(sel, hold = 0, pad) {
    await this.page.evaluate(([s, p]) => window.__tutRing && window.__tutRing(s, p), [sel, pad]);
    if (hold) { await sleep(hold); await this.page.evaluate(() => window.__tutRing && window.__tutRing(null)); }
  }
  async pointOf(target, dx = 0.5, dy = 0.5) {
    if (target && typeof target.x === 'number') return target;
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 120000 });
    const b = await loc.boundingBox();
    return { x: b.x + b.width * dx, y: b.y + b.height * dy };
  }
  async move(target, { duration = 650, dx, dy } = {}) {
    const p = await this.pointOf(target, dx, dy);
    const x0 = this.x, y0 = this.y;
    const dist = Math.hypot(p.x - x0, p.y - y0);
    const dur = Math.max(180, Math.min(duration, 250 + dist * 0.9));
    const steps = Math.max(8, Math.round(dur / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.x = x0 + (p.x - x0) * e; this.y = y0 + (p.y - y0) * e;
      await this.page.mouse.move(this.x, this.y);
      await sleep(dur / steps);
    }
  }
  async click(target, opts = {}) {
    await this.move(target, opts);
    await sleep(opts.before ?? 160);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    await sleep(opts.after ?? 250);
  }
  async scrollBy(dy, duration = 900) {
    await this.page.evaluate(([dy, duration]) => new Promise((res) => {
      const y0 = window.scrollY, t0 = performance.now();
      function step(t) {
        const k = Math.min(1, (t - t0) / duration);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        window.scrollTo(0, y0 + dy * e);
        if (k < 1) requestAnimationFrame(step); else res();
      }
      requestAnimationFrame(step);
    }), [dy, duration]);
  }
  async scrollToEl(target, { at = 0.4, duration = 900 } = {}) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    const b = await loc.boundingBox();
    const dy = b.y - VIEW.height * at;
    await this.scrollBy(dy, duration);
  }
  wait(ms) { return sleep(ms); }
}

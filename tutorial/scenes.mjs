// The tutorial's scenes. Each records into takes/<name>/.
//   node scenes.mjs install article diff-bof all web pick airbus diff-airbus settings
import { launch, Recorder, Director, LATENCY, latencyDefault, sleep } from './harness.mjs';
import path from 'node:path';

const W = 'https://en.wikipedia.org';

// "Insert in editor", "Remove sentence": the editor tab cannot be shown here
// (this machine's IP range is blocked from editing), so the click is shown
// and the scene cuts to the edit as it was saved. window.open records the
// URL instead of opening the tab.
const STUB_OPEN = () => {
  window.open = function (u) { window.__tutOpened = u; return { closed: false }; };
};

async function setup(name, { latency } = {}) {
  LATENCY.fn = latency || latencyDefault;
  const { browser, context } = await launch({ init: STUB_OPEN });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, String(e).slice(0, 200)));
  page.on('console', (m) => {
    if ((m.type() === 'error' || process.env.DEBUG_CONSOLE) && /CNfirmed/.test(m.text())) console.log(`[${name}]`, m.text().slice(0, 300));
  });
  const rec = new Recorder(path.join('takes', name));
  const d = new Director(page, rec);
  return { browser, context, page, rec, d };
}

async function finish({ browser, context, rec }, name) {
  await rec.stop();
  const s = context._tutStats;
  console.log(`[${name}] ${rec.frames.length} frames, ${s.hit} hits, ${s.miss} misses`, s.misses.slice(0, 5));
  await browser.close();
}

async function open(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 600000 });
  await page.evaluate(() => document.fonts.ready);
}

function badge(i) { return `.cnfirmed-badge[data-cn-index="${i}"]`; }
function panelButton(page, text) { return page.locator('#cnfirmed-panel button', { hasText: text }).first(); }
async function waitPanelText(page, re, timeout = 300000) {
  await page.waitForFunction((src) => {
    const p = document.getElementById('cnfirmed-panel');
    return p && new RegExp(src).test(p.innerText);
  }, re.source, { timeout });
}
async function panelIdle(page, timeout = 300000) {
  await page.waitForFunction(() => {
    const p = document.getElementById('cnfirmed-panel');
    return p && !p.querySelector('.cnfirmed-spin');
  }, null, { timeout, polling: 250 });
}
async function scrollPanelTo(page, locator, at = 0.3, duration = 800) {
  const box = await locator.boundingBox();
  await page.evaluate(([y, at, duration]) => new Promise((res) => {
    const body = document.querySelector('#cnfirmed-panel .cnf-body');
    const y0 = body.scrollTop, dy = y - window.innerHeight * at, t0 = performance.now();
    function step(t) {
      const k = Math.min(1, (t - t0) / duration);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      body.scrollTop = y0 + dy * e;
      if (k < 1) requestAnimationFrame(step); else res();
    }
    requestAnimationFrame(step);
  }), [box.y, at, duration]);
}
async function badgeIndexFor(page, phrase) {
  return page.evaluate((phrase) => {
    for (const b of document.querySelectorAll('.cnfirmed-badge')) {
      const p = b.closest('p, li, td, dd') || b.parentElement;
      if (p && p.textContent.includes(phrase)) return Number(b.getAttribute('data-cn-index'));
    }
    return -1;
  }, phrase);
}

// Viewport points just before the first and just after the last character
// of the text running from `start` to `end` inside `root`.
async function textEnds(page, root, start, end) {
  return page.evaluate(([root, start, end]) => {
    const host = document.querySelector(root);
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const nodes = []; let text = '';
    for (let n; (n = walker.nextNode());) { nodes.push([n, text.length]); text += n.data; }
    const a = text.indexOf(start); const b = text.indexOf(end, a) + end.length;
    function at(pos) {
      for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= pos) return [nodes[k][0], pos - nodes[k][1]];
    }
    const [sn, so] = at(a); const [en, eo] = at(b - 1);
    const r1 = document.createRange(); r1.setStart(sn, so); r1.setEnd(sn, so + 1);
    const r2 = document.createRange(); r2.setStart(en, eo); r2.setEnd(en, eo + 1);
    const q1 = r1.getClientRects()[0], q2 = r2.getClientRects()[0];
    return { x1: q1.left + 1, y1: q1.top + q1.height / 2, x2: q2.right - 0.5, y2: q2.top + q2.height / 2 };
  }, [root, start, end]);
}

async function dragSelect(d, page, pts) {
  await d.move({ x: pts.x1, y: pts.y1 });
  await sleep(200);
  await page.mouse.down();
  const steps = 40, x0 = pts.x1, y0 = pts.y1;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    // left to right along each line: move down only in the last part
    const x = x0 + (pts.x2 - x0) * e, y = y0 + (pts.y2 - y0) * Math.min(1, e * 1.4);
    d.x = x; d.y = y;
    await page.mouse.move(x, y);
    await sleep(28);
  }
  await page.mouse.up();
}

const SCENES = {
  // The install line on the script's page.
  async install() {
    const S = await setup('install');
    const { page, d, rec } = S;
    await open(page, `${W}/wiki/User:Alaexis/CNfirmed`);
    await d.use(page);
    await rec.start();
    await d.wait(500);
    await d.caption('CNfirmed is a user script that finds sources for statements tagged [citation needed].', 3800);
    await d.scrollToEl('.mw-highlight', { at: 0.62, duration: 1100 });
    await d.wait(300);
    await d.move('.mw-highlight pre', { dx: 0.28, dy: 0.5 });
    await d.caption('To install it, add this line to your common.js, or use the Install button on User:Alaexis/CNfirmed.', 4600);
    await d.caption('');
    await d.wait(400);
    await finish(S, 'install');
  },

  // Badges, one claim, both free searches, a book that supports it.
  async article() {
    const S = await setup('article', {
      latency: (u, ms) => /archive\.org|workers\.dev|toolforge/.test(u) ? Math.min(ms * 0.05, 750) : latencyDefault(u, ms)
    });
    const { page, d, rec } = S;
    await open(page, `${W}/wiki/Battle_of_France`);
    await page.waitForSelector('#ca-cnfirmed');
    await d.use(page);
    await rec.start();
    await d.wait(400);
    await d.caption('Open an article with [citation needed] tags. This is Battle of France, before a source was added.', 3600);
    await d.move('#ca-cnfirmed a');
    await d.caption('CNfirmed adds a tab with the number of tagged claims on the page.', 2800);
    const i = await badgeIndexFor(page, 'bridgehead south of the Somme');
    await d.caption('');
    await d.scrollToEl(badge(i), { at: 0.52, duration: 1400 });
    await d.wait(300);
    await d.move(badge(i));
    await d.caption('Each tag gets a small badge. Click it to look for a source.', 2600);
    await d.click(badge(i));
    await d.caption('Two free searches start at once: citations already on Wikipedia, and books on the Internet Archive.');
    await d.move({ x: 1080, y: 560 });
    await d.wait(4200);
    rec.mark('ff-start');
    await d.caption('Shown sped up: the book search takes about a minute.');
    await waitPanelText(page, /FOUND/);
    await panelIdle(page);
    rec.mark('ff-end');
    await d.caption('');
    await d.wait(700);
    const top = page.locator('#cnfirmed-panel .cnf-item').first();
    await d.move(top, { dx: 0.4, dy: 0.12 });
    await d.caption('An open-weight model reads each book’s passages against the claim. This Osprey book supports part of it.', 4400);
    const quote = page.locator('#cnfirmed-panel .cnf-quote').first();
    await d.move(quote, { dy: 0.55 });
    await d.caption('You see the words in the book that state it, and the model’s reason: the dates are there, the French are not.', 4800);
    const warn = page.locator('#cnfirmed-panel .cnf-warnbox').first();
    if (await warn.count()) {
      await scrollPanelTo(page, warn, 0.45);
      await d.move(warn, { dx: 0.3 });
      await d.caption('Warnings say what to check. This scan holds twelve Osprey books, so check the title and author.', 4400);
    }
    const ins = panelButton(page, 'Insert in editor');
    await scrollPanelTo(page, ins, 0.62);
    await d.move(ins);
    await d.caption('Read the book, then Insert in editor: the section’s source editor opens with the <ref> in place of the tag.', 4400);
    await d.click(ins);
    await d.caption('The edit summary is filled in. Nothing is saved until you review the change and publish it.', 3600);
    await finish(S, 'article');
  },

  // The edit the author saved.
  async 'diff-bof'() {
    const S = await setup('diff-bof');
    const { page, d, rec } = S;
    await open(page, `${W}/w/index.php?title=Battle_of_France&diff=1381725946&oldid=1381720666&diffonly=1&diff-type=table`);
    await page.addStyleTag({ content: 'html{zoom:1.2}' });
    await d.use(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await rec.start();
    await d.wait(300);
    await d.caption('The edit as it was saved, after a look at the book: the tag out, Forczyk’s Case Red in, with pages.');
    await d.wait(1200);
    await d.scrollToEl('td.diff-deletedline del', { at: 0.42, duration: 1500 });
    await d.move('td.diff-deletedline del', { dx: 0.5 });
    await d.wait(1600);
    await d.move('td.diff-addedline ins:last-of-type', { dx: 0.5 });
    await d.wait(4200);
    await finish(S, 'diff-bof');
  },

  // All claims: Find sources for all (free), then the web-search offer.
  async all() {
    const S = await setup('all', {
      latency: (u, ms) => /archive\.org|workers\.dev|toolforge/.test(u) ? Math.min(ms * 0.02, 260) : latencyDefault(u, ms)
    });
    const { page, d, rec } = S;
    await open(page, `${W}/wiki/Battle_of_France`);
    await page.waitForSelector('#ca-cnfirmed');
    await page.evaluate(() => window.scrollTo(0, 0));
    await d.use(page);
    await rec.start();
    await d.wait(300);
    await d.click('#ca-cnfirmed a');
    await d.caption('The CNfirmed tab lists every claim on the page with its status.', 3200);
    const all = panelButton(page, 'Find sources for all');
    await d.move(all);
    await d.caption('Find sources for all runs both free searches for each claim, one after another.', 2400);
    await d.click(all);
    await d.move({ x: 1100, y: 640 });
    await d.wait(1200);
    rec.mark('batch-start');
    await d.caption('Shown sped up: for these ten claims the free searches take several minutes.');
    await page.waitForFunction(() => ![...document.querySelectorAll('#cnfirmed-panel button')].some((b) => /Searching…/.test(b.textContent)), null, { timeout: 900000, polling: 250 });
    rec.mark('batch-end');
    await d.caption('');
    await d.wait(600);
    await d.caption('A green tick: a source supports the claim. Half a circle: it supports part of it. Blue: leads to check.', 4600);
    const web = page.locator('#cnfirmed-panel .cnf-box').filter({ hasText: 'Search the web' }).first();
    if (await web.count()) {
      await scrollPanelTo(page, web, 0.5, 1000);
      await d.move(web.locator('button').first());
      await d.caption('For the claims still left with nothing, one button runs a web search.', 3800);
    }
    await d.caption('');
    await d.wait(300);
    await finish(S, 'all');
  },
  // A claim nothing free was found for: the web search.
  async web() {
    const S = await setup('web', {
      latency: (u, ms) => /workers\.dev\/tavily|workers\.dev\/hf/.test(u) ? Math.min(ms * 0.25, 2600)
        : /archive\.org|workers\.dev|toolforge/.test(u) ? Math.min(ms * 0.02, 250) : latencyDefault(u, ms)
    });
    const { page, d, rec } = S;
    await open(page, `${W}/wiki/Battle_of_France`);
    await page.waitForSelector('#ca-cnfirmed');
    const i = await badgeIndexFor(page, 'coast of the Basque Country');
    await page.locator(badge(i)).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 120));
    await d.use(page);
    await rec.start();
    await d.wait(300);
    await d.click(badge(i));
    await d.caption('Another claim. This time neither Wikipedia nor the books have it.');
    await waitPanelText(page, /Nothing (on Wikipedia or in books|in this article)/);
    await panelIdle(page);
    await d.wait(1500);
    const go = page.locator('#cnfirmed-panel button:text-is("Search")').first();
    await d.move(go);
    await d.caption('So search the web. It is free while CNfirmed’s shared searches last: Tavily finds pages, GPT-OSS reads them.', 4600);
    await d.click(go);
    await d.caption('');
    await d.move({ x: 1080, y: 600 });
    await waitPanelText(page, /FOUND/, 600000);
    await panelIdle(page, 600000);
    await d.wait(600);
    const top = page.locator('#cnfirmed-panel .cnf-item').first();
    await d.move(top, { dx: 0.4, dy: 0.1 });
    await d.caption('Each web page comes with the quote the model relied on. Open the page and check that the quote is really there.', 5200);
    await d.caption('');
    await d.wait(300);
    await finish(S, 'web');
  },

  // Text nobody tagged: Tools → Find sources for a claim.
  async pick() {
    const S = await setup('pick', {
      latency: (u, ms) => /archive\.org|workers\.dev|toolforge/.test(u) ? Math.min(ms * 0.04, 600) : latencyDefault(u, ms)
    });
    const { page, d, rec } = S;
    await open(page, `${W}/wiki/Battle_of_France`);
    await page.waitForSelector('#ca-cnfirmed');
    await page.evaluate(() => window.scrollTo(0, 0));
    await d.use(page);
    await rec.start();
    await d.wait(300);
    await d.caption('Text nobody has tagged works too. In the Tools menu, choose Find sources for a claim.');
    const tools = page.locator('#vector-page-tools-dropdown-checkbox, #vector-page-tools-dropdown .vector-dropdown-label').first();
    await d.move('#vector-page-tools-dropdown');
    await d.click('#vector-page-tools-dropdown');
    await d.wait(500);
    await d.click('#t-cnfirmed-pick a');
    await d.wait(700);
    const para = page.locator('#mw-content-text p', { hasText: 'In early September 1939' }).first();
    await d.scrollToEl(para, { at: 0.3, duration: 1000 });
    await d.wait(400);
    const pts = await textEnds(page, '#mw-content-text', 'In early September 1939', 'withdrawn to the start line.');
    await d.caption('Select a sentence, or a fact within one, in the article.');
    await dragSelect(d, page, pts);
    await d.wait(1200);
    const find = panelButton(page, 'Find sources');
    await d.move(find);
    await d.caption('Then click Find sources. It becomes a claim like a tagged one, and the same searches run.', 3200);
    await d.click(find);
    await d.move({ x: 1080, y: 560 });
    await waitPanelText(page, /FOUND|Nothing/, 600000);
    await panelIdle(page, 600000);
    await d.wait(800);
    await d.caption('Its badge sits where the <ref> would go. Here the books support only part of the sentence: the dates are missing.', 5000);
    await d.caption('');
    await d.wait(300);
    await finish(S, 'pick');
  },

  // Airbus: a claim that did not belong; Remove sentence.
  async airbus() {
    const S = await setup('airbus', {
      latency: (u, ms) => /archive\.org|workers\.dev|toolforge/.test(u) ? Math.min(ms * 0.04, 600) : latencyDefault(u, ms)
    });
    const { page, d, rec } = S;
    await open(page, `${W}/wiki/Airbus`);
    await page.waitForSelector('.cnfirmed-badge');
    await page.locator(badge(0)).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 160));
    await d.use(page);
    await rec.start();
    await d.wait(300);
    await d.caption('Sometimes the claim is the problem. On Airbus, the tagged part is about a South African politician.', 3800);
    await d.click(badge(0));
    await d.move({ x: 1080, y: 560 });
    await waitPanelText(page, /FOUND|Nothing/, 600000);
    await panelIdle(page, 600000);
    await d.wait(600);
    const show = page.locator('#cnfirmed-panel button', { hasText: 'Show in article' }).first();
    await d.click(show);
    await d.wait(1300);
    const lead = page.locator('#cnfirmed-panel .cnf-item').first();
    if (await lead.count()) {
      await d.move(lead, { dx: 0.4, dy: 0.1 });
      await d.caption('The Wikipedia search found a lead: a source this article already cites for the sentence before. Leads are not checked.', 5000);
    }
    const ed = page.locator('#cnfirmed-panel button', { hasText: 'Edit sentence' }).first();
    await d.move(ed);
    await d.caption('Edit sentence opens the editor with the sentence selected. Remove sentence opens it with the sentence already taken out.', 5000);
    await d.click(ed);
    await d.caption('Again, you review the change and save it yourself.', 2600);
    await finish(S, 'airbus');
  },

  async 'diff-airbus'() {
    const S = await setup('diff-airbus');
    const { page, d, rec } = S;
    await open(page, `${W}/w/index.php?title=Airbus&diff=1380103475&oldid=1380076173&diffonly=1&diff-type=table`);
    await page.addStyleTag({ content: 'html{zoom:1.2}' });
    await d.use(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await rec.start();
    await d.wait(300);
    await d.caption('Here the clause about Yengeni went: the article is about Airbus.');
    await d.wait(1000);
    await d.scrollToEl('td.diff-deletedline del:last-of-type', { at: 0.45, duration: 1400 });
    await d.move('td.diff-deletedline del:last-of-type', { dx: 0.5 });
    await d.wait(3800);
    await finish(S, 'diff-airbus');
  },

  // The gear: provider and key.
  async settings() {
    const S = await setup('settings');
    const { page, d, rec } = S;
    await open(page, `${W}/wiki/Battle_of_France`);
    await page.waitForSelector('#ca-cnfirmed');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#ca-cnfirmed a').first().click();
    await page.waitForSelector('#cnfirmed-panel button[aria-label="Settings"]');
    await d.use(page);
    await rec.start();
    await d.wait(300);
    const gear = '#cnfirmed-panel button[aria-label="Settings"]';
    await d.move(gear);
    await d.caption('The gear opens the settings.', 1600);
    await d.click(gear);
    await d.wait(400);
    await d.move(page.locator('#cnfirmed-panel .cnf-radio').first(), { dx: 0.3 });
    await d.caption('Pick who searches the web: Tavily with GPT-OSS (free to start), or Claude, Gemini or OpenAI with your own key.', 5200);
    await d.move('#cnfirmed-key');
    await d.caption('Your key is kept in this browser and sent only to the service you chose. The book and Wikipedia searches need no key.', 5200);
    await d.caption('');
    await d.wait(300);
    await finish(S, 'settings');
  }

};

for (const name of process.argv.slice(2)) {
  if (!SCENES[name]) { console.log('no scene', name); continue; }
  const t0 = Date.now();
  await SCENES[name]();
  console.log(`[${name}] done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

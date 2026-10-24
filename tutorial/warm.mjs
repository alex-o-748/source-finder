// Open one claim (by a phrase of its sentence) and let every search finish,
// so the responses land in the cache. Prints the panel and saves a screenshot.
//   node warm.mjs Battle_of_France "bridgehead south of the Somme" [--web]
import { launch, sleep } from './harness.mjs';
import fs from 'node:fs';

const [title, phrase] = process.argv.slice(2);
const web = process.argv.includes('--web');
const { browser, context } = await launch();
const page = await context.newPage();
page.on('console', (m) => { if (/CNfirmed/i.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto('https://en.wikipedia.org/wiki/' + title, { waitUntil: 'load', timeout: 600000 });
await page.waitForSelector('.cnfirmed-badge', { timeout: 120000 });

export async function badgeIndexFor(page, phrase) {
  return page.evaluate((phrase) => {
    const badges = [...document.querySelectorAll('.cnfirmed-badge')];
    for (const b of badges) {
      const p = b.closest('p, li, td, dd, blockquote') || b.parentElement;
      if (p && p.textContent.includes(phrase)) return Number(b.getAttribute('data-cn-index'));
    }
    return -1;
  }, phrase);
}

async function settle(label) {
  let quiet = 0;
  const t0 = Date.now();
  while (quiet < 6) {
    const busy = await page.evaluate(() => {
      const p = document.getElementById('cnfirmed-panel');
      return !!(p && p.querySelector('.cnfirmed-spin'));
    });
    quiet = busy ? 0 : quiet + 1;
    await sleep(1000);
    if ((Date.now() - t0) % 30000 < 1000) console.log(label, 'still busy', Math.round((Date.now() - t0) / 1000) + 's');
  }
  console.log(label, 'settled in', Math.round((Date.now() - t0) / 1000) + 's');
}

const idx = await badgeIndexFor(page, phrase);
console.log('claim index', idx);
await page.locator(`.cnfirmed-badge[data-cn-index="${idx}"]`).scrollIntoViewIfNeeded();
await page.locator(`.cnfirmed-badge[data-cn-index="${idx}"]`).click();
await sleep(2000);
await settle('free');
if (web) {
  const btn = page.locator('#cnfirmed-panel button', { hasText: /web/i }).first();
  console.log('web button:', await btn.count() ? await btn.textContent() : 'none');
  if (await btn.count()) { await btn.click(); await sleep(2000); await settle('web'); }
}
const text = await page.evaluate(() => document.getElementById('cnfirmed-panel').innerText);
console.log('---- panel ----\n' + text + '\n---------------');
const safe = title.replace(/\W+/g, '_') + '_' + idx;
await page.screenshot({ path: `out/warm-${safe}.png` });
fs.writeFileSync(`out/warm-${safe}.txt`, text);
console.log(context._tutStats.hit, 'hits', context._tutStats.miss, 'misses');
await browser.close();

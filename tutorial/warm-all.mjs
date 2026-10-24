// "Find sources for all (free)" on a page, waiting for the batch to finish.
//   node warm-all.mjs Battle_of_France
import { launch, sleep } from './harness.mjs';
import fs from 'node:fs';

const [title] = process.argv.slice(2);
const { browser, context } = await launch();
const page = await context.newPage();
page.on('console', (m) => { if (/CNfirmed\] (Internet Archive claim \d+ :|wiki-local claim|search failed)|judge|warn/i.test(m.text())) console.log('[console]', m.text().slice(0, 220)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto('https://en.wikipedia.org/wiki/' + title, { waitUntil: 'load', timeout: 600000 });
await page.waitForSelector('#ca-cnfirmed a, #ca-cnfirmed', { timeout: 120000 });
await page.locator('#ca-cnfirmed a').first().click();
await page.locator('#cnfirmed-panel button', { hasText: 'Find sources for all' }).click();
const t0 = Date.now();
let last = '';
while (true) {
  await sleep(5000);
  const s = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#cnfirmed-panel button')].find((x) => /Searching…/.test(x.textContent));
    return b ? b.textContent : null;
  });
  if (s !== last) { console.log(Math.round((Date.now() - t0) / 1000) + 's', s); last = s; }
  if (!s) break;
}
await sleep(3000);
const text = await page.evaluate(() => document.getElementById('cnfirmed-panel').innerText);
console.log('---- panel ----\n' + text + '\n---------------');
fs.writeFileSync(`out/all-${title}.txt`, text);
await page.screenshot({ path: `out/all-${title}.png` });
console.log(context._tutStats.hit, 'hits', context._tutStats.miss, 'misses');
await browser.close();

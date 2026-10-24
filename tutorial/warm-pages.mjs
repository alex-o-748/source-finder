// Load plain pages through the cache and screenshot them.
import { launch, sleep } from './harness.mjs';

const urls = process.argv.slice(2);
const { browser, context } = await launch();
const page = await context.newPage();
let n = 0;
for (const u of urls) {
  await page.goto(u, { waitUntil: 'load', timeout: 600000 });
  await sleep(2500);
  await page.screenshot({ path: `out/page-${++n}.png` });
  console.log(n, u);
}
console.log(context._tutStats.hit, 'hits', context._tutStats.miss, 'misses');
await browser.close();

// Title and end cards, rendered at 1280×720 CSS px × 1.5 = 1920×1080.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PW_PATH || 'playwright');

const BASE = `
  *{box-sizing:border-box;margin:0}
  html,body{width:1280px;height:720px;overflow:hidden}
  body{font-family:Inter,sans-serif;color:#fff;-webkit-font-smoothing:antialiased;
    background:radial-gradient(1200px 800px at 12% 8%, #4a74d1 0%, #3359b3 38%, #24438c 72%, #1b356f 100%)}
  .wrap{position:absolute;left:110px;right:110px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center}
  .kicker{font-size:15px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.62);margin-bottom:18px}
  h1{font-size:64px;font-weight:700;letter-spacing:-.02em;line-height:1.05;margin-bottom:22px}
  h2{font-size:44px;font-weight:700;letter-spacing:-.015em;line-height:1.1;margin-bottom:20px}
  p.sub{font-size:23px;line-height:1.45;font-weight:400;color:rgba(255,255,255,.88);max-width:920px;text-wrap:balance}
  .rule{width:72px;height:4px;border-radius:2px;background:#f2b46b;margin:34px 0 30px}
  table{border-collapse:collapse;font-size:20px}
  td{padding:5px 0;vertical-align:top}
  td.k{width:150px;color:rgba(255,255,255,.62)}
  .foot{position:absolute;left:110px;right:110px;bottom:46px;font-size:13px;color:rgba(255,255,255,.5)}
  .tag{display:inline-block;font-size:.62em;font-weight:500;vertical-align:.32em;color:rgba(255,255,255,.75)}
`;

export const CARDS = {
  title: `
    <div class="wrap">
      <div class="kicker">Tutorial · Wikipedia user script</div>
      <h1>CNfirmed</h1>
      <p class="sub">Find sources for <span style="white-space:nowrap">[citation needed]</span> claims, and check that they say what the article says.</p>
    </div>`,
  end: `
    <div class="wrap">
      <h2>Leads, not verdicts.</h2>
      <p class="sub">CNfirmed finds candidates and shows you the words in them that state the claim. You decide what to cite: read the source before you save the edit.</p>
      <div class="rule"></div>
      <table>
        <tr><td class="k">Install</td><td>User:Alaexis/CNfirmed</td></tr>
        <tr><td class="k">Feedback</td><td>User talk:Alaexis/CNfirmed</td></tr>
        <tr><td class="k">Code</td><td>github.com/alex-o-748/source-finder</td></tr>
      </table>
    </div>
    <div class="foot">Recorded on English Wikipedia, October 2026 · Battle of France and Airbus are shown as they were before the author’s own CNfirmed edits to them</div>`
};

export async function renderCards(outDir, which = Object.keys(CARDS)) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  const files = {};
  for (const name of which) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${BASE}</style></head><body>${CARDS[name]}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const file = `${outDir}/card-${name}.png`;
    await page.screenshot({ path: file });
    files[name] = file;
  }
  await browser.close();
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await renderCards(process.argv[2] || 'out'));
}

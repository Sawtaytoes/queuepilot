// The member picker's results: which library each came from, the edition when there is one,
// and this pool's own libraries above a rule.
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const BASE = `http://localhost:${PORT}`;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 760 } });

const shoot = async (query: string, name: string) => {
  await page.fill('#chmsearch', '');
  await page.fill('#chmsearch', query);
  await page.waitForSelector('#chmresults.open li', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `__screenshots__/search-${name}-${TAG}.png` });
};

await page.goto(`${BASE}/channels`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#chmsearch', { timeout: 30000 });
await shoot('batman', 'batman');
await shoot('big buck', 'editions');

await browser.close();
console.log(`shot: __screenshots__/search-*-${TAG}.png`);

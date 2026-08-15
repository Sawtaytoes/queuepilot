// Before/after shots for the reading-artwork fix: the add-search dropdown and the queue grid
// of a KAVITA queue.
//
//   WEB_PORT=18790 SHOT_TAG=after node e2e/shot-kavita-covers.mjs
//
// Writes __screenshots__/kavita-{search,grid}-<tag>.png. Run it against a server booted with a
// reading set and real Kavita credentials (the "before" is the same script against a build of
// `main`, on its own port) — the point of the pair is the artwork, so stubbed bytes would
// prove nothing.
import { mkdirSync } from 'node:fs';
import { chromium } from './playwright.mjs';

const PORT = process.env.WEB_PORT || 18790;
const TAG = process.env.SHOT_TAG || 'after';
const SET = process.env.SHOT_SET || 'manga_webtoons';
const OUT = '__screenshots__';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1100, height: 900 },
  colorScheme: 'dark',
});

await page.goto(`http://localhost:${PORT}/#/q/${SET}`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));
await page.waitForSelector('#grid .tile', { timeout: 30000 });

// --- the grid: three reading entries ---------------------------------------- //
// Give the posters their own moment: a shot taken while they are still in flight would
// "prove" the bug either way.
await page.waitForTimeout(1500);
await page.locator('#grid').screenshot({ path: `${OUT}/kavita-grid-${TAG}.png` });
console.log('wrote', `${OUT}/kavita-grid-${TAG}.png`);

// --- the add-search dropdown ------------------------------------------------- //
await page.locator('#search').fill('dung');
await page.waitForSelector('#results li', { timeout: 30000 });
await page.waitForTimeout(1500);
await page
  .locator('.searchwrap, #search')
  .first()
  .evaluate((el) => el.scrollIntoView({ block: 'start' }));
await page.screenshot({
  path: `${OUT}/kavita-search-${TAG}.png`,
  clip: { x: 0, y: 0, width: 1100, height: 700 },
});
console.log('wrote', `${OUT}/kavita-search-${TAG}.png`);

await browser.close();

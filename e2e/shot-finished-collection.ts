// Before/after shot for the finished-collection tile label: a collection with nothing left
// to play read "2 in order" (its size — the same thing an unresolved tile says) where a
// finished SHOW reads "All watched".
//
//   WEB_PORT=18801 SHOT_TAG=before server/node_modules/.bin/tsx e2e/shot-finished-collection.ts
//
// Writes __screenshots__/finished-collection-<tag>.png. Point it at a server booted against
// the real queues.yaml (the live case is the "Trapped in a Dating Sim" entry in bob_anime),
// stash the diff and re-run for the "before".
import { mkdirSync } from 'node:fs';
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || '18801';
const TAG = process.env.SHOT_TAG || 'after';
const SET = process.env.SHOT_SET || 'bob_anime';
const MATCH = process.env.SHOT_MATCH || 'Dating Sim';
const OUT = '__screenshots__';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  colorScheme: 'dark',
});

await page.goto(`http://localhost:${PORT}/q/${SET}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#grid .tile .cap', { timeout: 30000 });
await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));

// Both densities that show the next-up line: "Cards" is what the owner reported it from,
// "List" is the same label in the one-line layout.
for (const density of ['Cards', 'List']) {
  const opt = page.getByRole('radio', { name: density, exact: true });
  if (!(await opt.count())) throw new Error(`no density control named ${density}`);
  await opt.first().click();
  await page.waitForTimeout(600);

  const tile = page.locator('#grid .tile', { hasText: MATCH }).first();
  await tile.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);

  const path = `${OUT}/finished-collection-${density.toLowerCase()}-${TAG}.png`;
  await tile.screenshot({ path });
  console.log('wrote', path);
}

await browser.close();

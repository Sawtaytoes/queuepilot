// Before/after shots for the tile-chrome pass: the ✓/✕ move off the poster into their own
// gutters in `cards`/`list`, both hide until hover, and a ▶ starts one entry.
//
//   WEB_PORT=18917 server/node_modules/.bin/tsx e2e/shot-tile-controls.ts
//
// Writes __screenshots__/tiles-<density>-<state>.png. Run it against a server booted by
// e2e/dev.sh (fixtures + real Plex posters), stash the diff and re-run for the "before".
import { chromium } from './playwright.js';
import { mkdirSync } from 'node:fs';

const PORT = process.env.WEB_PORT || '18917';
const TAG = process.env.SHOT_TAG || 'after';
const SET = process.env.SHOT_SET || 'bob_anime';
const OUT = '__screenshots__';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 760 },
  colorScheme: 'dark',
});

await page.goto(`http://localhost:${PORT}/q/${SET}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#grid .tile .cap', { timeout: 30000 });
// The owner's UI is dark; the scheme toggle persists to localStorage, so set it directly.
await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));

const shot = async (name: string) => {
  await page.waitForTimeout(350);
  const path = `${OUT}/tiles-${name}-${TAG}.png`;
  await page.locator('#grid').screenshot({ path });
  console.log('wrote', path);
};

// The third density is labelled "List" after this change and "Rows" before it — the shot
// script has to drive BOTH so the before/after pair is the same three views.
//
// Typed as a tuple so the `[label, ...names]` destructuring below yields a definite `label`:
// off a plain `string[][]` under `noUncheckedIndexedAccess` it would read `string | undefined`.
const DENSITIES: [string, ...string[]][] = [['posters', 'Posters'], ['cards', 'Cards'], ['list', 'List', 'Rows']];
for (const [label, ...names] of DENSITIES) {
  // The density control is a radiogroup; its options are labelled by their visible text.
  let clicked = false;
  for (const name of names) {
    const opt = page.getByRole('radio', { name, exact: true });
    if (await opt.count()) { await opt.first().click(); clicked = true; break; }
  }
  if (!clicked) throw new Error(`no density control matching ${names.join('/')}`);

  await page.mouse.move(0, 0);
  await shot(`${label}-rest`);

  // Hover the POSTER, not the tile: hovering the tile often lands on the next-up line,
  // whose tooltip then covers the very chrome these shots exist to show. The poster is
  // inside the tile, so `:hover` on the tile still matches.
  const tile = page.locator('#grid .tile', { has: page.locator('.poster') }).first();
  await tile.locator('.thumb').hover();
  await shot(`${label}-hover`);
  await page.mouse.move(0, 0);
}

// The selection bar's ▶ Play, with exactly one entry selected.
await page.getByRole('radio', { name: 'Cards', exact: true }).first().click();
await page.locator('#grid .tile', { has: page.locator('.poster') }).first().locator('.check').click();
await page.waitForTimeout(300);
await page.locator('#selbar').screenshot({ path: `${OUT}/tiles-selbar-${TAG}.png` });
console.log('wrote', `${OUT}/tiles-selbar-${TAG}.png`);

await browser.close();

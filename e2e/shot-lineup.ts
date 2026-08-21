// Ad-hoc visual capture of the pool editor's Lineup box — the controls this change adds.
// Not a gate; it exists so the change can be LOOKED at (and put on the PR) rather than
// described. Drives the degraded no-Plex path, so it needs no token.
//
// Run against a server started on WEB_PORT with a sets.yaml carrying a rotation channel:
//   SHOT_TAG=after server/node_modules/.bin/tsx e2e/shot-lineup.ts
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18771;
const BASE = `http://localhost:${PORT}`;
const TAG = process.env.SHOT_TAG || 'after';
const DIR = process.env.SHOT_DIR || '__screenshots__';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });

/** Open ⚙ Configure for one pool and wait for the modal to be really open. */
const openConfigure = async (setId: string) => {
  await page.goto(`${BASE}/channels/${setId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chconfigure', { timeout: 20000 });
  await page.click('#chconfigure');
  await page.waitForSelector('#dynmodal[data-open]', { timeout: 10000 });
  // The bindings arrive from Plex a beat later and reflow the modal; on the no-Plex path that
  // settles immediately, but wait for the paint either way so the shot is not mid-layout.
  await page.waitForTimeout(600);
};

const shot = async (name: string) => {
  await page.screenshot({ path: `${DIR}/lineup-${name}-${TAG}.png` });
  console.log(`wrote ${DIR}/lineup-${name}-${TAG}.png`);
};

// 1. A refilling pool, as saved: 60 ahead, top-up on, finished shows restart.
await openConfigure('younger_kids_shorts');
const box = await page.$('.dyn-lineup');
if (box) {
  await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
}
await shot('box');

// 2. The length picker OPEN, so the presets and the Default chip are visible.
const trigger = await page.$('.dyn-lineup .countpick button, .dyn-lineup [role="combobox"], .dyn-lineup button');
if (trigger) {
  await trigger.click();
  await page.waitForTimeout(400);
  await shot('presets');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// 3. A rewatch pool, where the knobs do not reach — the note stands in for the box.
await page.keyboard.press('Escape');
await openConfigure('younger_kids_movies');
const note = await page.$('#dyn-lineup-rewatch-note');
if (note) {
  await note.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
}
await shot('rewatch');

await browser.close();

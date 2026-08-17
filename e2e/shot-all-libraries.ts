// Screenshots for the "no libraries checked = every library" change.
//
// Drives BOTH builds — baseline on $BEFORE_PORT, the change on $AFTER_PORT — against copies
// of the live sets.yaml and the real Board Game Picker, so the pair is the same queue with
// the same stored scope (`libraries: [collection, Roll 'n Write]`) and nothing else differs.
//
// Run:  BEFORE_PORT=18841 AFTER_PORT=18842 server/node_modules/.bin/tsx e2e/shot-all-libraries.ts
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from './playwright.js';

const SHOTS = path.join(import.meta.dirname, '..', '__screenshots__');
mkdirSync(SHOTS, { recursive: true });

const BEFORE = process.env.BEFORE_PORT || '18841';
const AFTER = process.env.AFTER_PORT || '18842';
const SET = 'ready_to_play_games';

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

async function searchShot(port: string, name: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${port}/q/${SET}`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.fill('#search', 'cubitos');
  // The dropdown debounces, then asks the picker over the LAN.
  await page.waitForTimeout(3500);
  await shot(page, name);
  await browser.close();
}

async function modalShot(port: string, name: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${port}/q/${SET}`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await page.click('#qconfigure');
  await page.waitForTimeout(2500);
  await shot(page, name);
  await browser.close();
}

await searchShot(BEFORE, 'all-libraries-search-before');
await searchShot(AFTER, 'all-libraries-search-after');
await modalShot(BEFORE, 'all-libraries-modal-before');
await modalShot(AFTER, 'all-libraries-modal-after');
console.log('shots written to __screenshots__/');

/**
 * The Plex-side copy: the new-channel form's three library groups are ONE optional scope,
 * and the hint under them says which state it is in. Only the AFTER build has it, so this
 * is a single shot rather than a pair.
 */
async function dynModalShot(port: string, name: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`http://localhost:${port}/channels`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await page.click('#newdyn');
  await page.waitForTimeout(2000);
  await page.$eval('#dyn-alllibs', (el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  await shot(page, name);
  await browser.close();
}

await dynModalShot(AFTER, 'all-libraries-channel-form-after');

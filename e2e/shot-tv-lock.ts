// Visual capture of the TV lock: the "Locked on TV" switch in a queue's settings, the new
// Settings page with the household TV PIN, and the navigation entry that reaches it. Not a
// gate — it exists so the change can be LOOKED at. Degraded no-Plex path, fixture data only.
import { chromium } from './playwright.js';
const BASE = `http://localhost:${process.env.WEB_PORT || 18776}`;
const TAG = process.env.SHOT_TAG || 'after';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1100 } });

// 1. A queue's settings: the playback flags, where "Locked on TV" sits.
await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#qconfigure', { timeout: 20000 });
await page.click('#qconfigure');
await page.waitForSelector('#setmodal[data-open]', { timeout: 10000 });
await page.waitForTimeout(800);
const lock = await page.$('#set-locked-on-tv');
if (lock) await lock.click({ force: true });
await page.waitForTimeout(300);
await (await page.$('#set-flags'))?.screenshot({ path: `__screenshots__/tv-lock-queue-${TAG}.png` });
console.log('wrote queue settings');
await page.keyboard.press('Escape');

// 2. The mode landing, whose navigation gains a Settings entry.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `__screenshots__/tv-lock-landing-${TAG}.png` });
console.log('wrote landing');

// 3. The Settings page: no PIN, then a PIN set.
const response = await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
if (await page.$('#settings')) {
  await page.waitForSelector('[data-testid="tv-pin-status"][data-is-loaded="true"]', { timeout: 10000 });
  await page.screenshot({ path: `__screenshots__/tv-lock-settings-empty-${TAG}.png` });
  await page.fill('#tv-pin', '2468');
  await page.click('button[type="submit"]');
  await page.waitForSelector('text=A TV PIN is set.', { timeout: 10000 });
  await page.screenshot({ path: `__screenshots__/tv-lock-settings-set-${TAG}.png` });
  console.log('wrote settings');
} else console.log('no settings page', response?.status());
await b.close();

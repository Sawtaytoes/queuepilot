// Screenshots for the "channel leaves the UI" pass: the two surfaces that still said
// "Channel"/"queue" after the 2026-08-16 rename — the curated set editor's Type picker (the
// one the owner screenshotted) and the filtered-pool editor's chrome (title + delete button).
//
// Run against a server started the way e2e/run.sh starts one. Writes into __screenshots__/
// with a `--tag` suffix so the same script can shoot BEFORE (on main) and AFTER (on the
// branch) without one clobbering the other.
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const BASE = `http://localhost:${PORT}`;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });

// --- the Type picker, open ---------------------------------------------------- //
await page.goto(`${BASE}/queues`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#newqueue', { timeout: 20000 });
await page.click('#newqueue');
await page.waitForSelector('#setmodal[data-open]');
// The overlay clones the trigger and overwrites its `id`, so `data-testid` is the stable
// handle (see SelectListbox's note). Clicking it opens the portalled options list.
await page.click('[data-testid="set-kind"]');
await page.waitForSelector('[role="listbox"] [role="option"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `__screenshots__/taxonomy-type-picker-${TAG}.png` });
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

// --- the filtered-pool editor's chrome ---------------------------------------- //
await page.goto(`${BASE}/channels`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#newdyn', { timeout: 20000 });
await page.click('#newdyn');
await page.waitForSelector('#dynmodal[data-open]');
await page.waitForTimeout(300);
await page.screenshot({ path: `__screenshots__/taxonomy-pool-editor-${TAG}.png` });

await browser.close();
console.log(`shot: __screenshots__/taxonomy-*-${TAG}.png`);

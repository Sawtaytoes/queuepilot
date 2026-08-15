// Shot of the per-entry settings panel, whose Done button moved to the right edge.
//   WEB_PORT=18917 SHOT_TAG=after server/node_modules/.bin/tsx e2e/shot-entry-modal.ts
import { chromium } from './playwright.js';
import { mkdirSync } from 'node:fs';

const PORT = process.env.WEB_PORT || '18917';
const TAG = process.env.SHOT_TAG || 'after';
mkdirSync('__screenshots__', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
await page.goto(`http://localhost:${PORT}/#/q/bob_anime`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#grid .tile .cap', { timeout: 30000 });
await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'dark'));

// The quiet `Edit` chip opens the panel.
await page.locator('#grid .tile .editbtn').first().click();
await page.waitForSelector('#entrymodal', { timeout: 10000 });
await page.waitForTimeout(400);

const path = `__screenshots__/entry-modal-${TAG}.png`;
await page.locator('#entrymodal').screenshot({ path });
console.log('wrote', path);

// `boundingBox()` is null only for an element that is not rendered; both of these were just
// waited for and screenshotted, so a null here is a real failure and should throw.
const box = (await page.locator('#entrymodal').boundingBox())!;
const btn = (await page.locator('#entrymodal .modalbtns button').boundingBox())!;
const gapRight = Math.round(box.x + box.width - (btn.x + btn.width));
const gapLeft = Math.round(btn.x - box.x);
console.log(`Done button: ${gapLeft}px from the left edge, ${gapRight}px from the right`);
console.log(gapRight < gapLeft ? 'RIGHT-ALIGNED ✓' : 'still left-aligned ✗');

await browser.close();

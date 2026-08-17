// The Play landing's reorder handle, revealed on hover.
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 620 } });
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.playrow', { timeout: 30000 });
await page.waitForTimeout(2000);
// Hover one row so its handle is showing — it is quiet until then.
await page.locator('#playqueues li[data-set]').first().hover();
await page.waitForTimeout(400);
await page.screenshot({ path: '__screenshots__/play-reorder-handle.png' });
await browser.close();
console.log('shot: __screenshots__/play-reorder-handle.png');

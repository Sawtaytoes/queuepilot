// The Preferred queued items knob in ⚙ Configure, both options showing.
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const BASE = `http://localhost:${PORT}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

await page.goto(`${BASE}/channels`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#chconfigure', { timeout: 30000 });
await page.click('#chconfigure');
await page.waitForSelector('#dynmodal[data-open]');
await page.waitForSelector('#dyn-collections');
await page.evaluate(() => {
  document.querySelector('#dyn-collections')?.scrollIntoView({ block: 'center' });
});
await page.waitForTimeout(400);
await page.screenshot({ path: '__screenshots__/collection-members-knob.png' });

// Open the picker so both options are on screen.
await page.click('[data-testid="dyn-collection-members"]');
await page.waitForSelector('[role="listbox"] [role="option"]');
await page.waitForTimeout(300);
await page.screenshot({ path: '__screenshots__/collection-members-open.png' });

await browser.close();
console.log('shot: __screenshots__/collection-members-*.png');

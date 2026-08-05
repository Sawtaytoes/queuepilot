import { chromium } from './playwright.mjs';
const PORT = process.env.WEB_PORT || 18769;
const BASE = `http://localhost:${PORT}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.playrow');
// Grid header: navigate into a queue to see Configure inline with Play/search.
await page.goto(`${BASE}/#/queues`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf', { timeout: 15000 }).catch(() => {});
const firstOpen = await page.$('.shelf .open');
if (firstOpen) { await firstOpen.click(); await page.waitForSelector('#queue:not([hidden])'); }
await page.screenshot({ path: '__screenshots__/grid-header.png' });
// Dyn modal: open the create form and screenshot (X + chrome).
await page.goto(`${BASE}/#/channels`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#newdyn', { timeout: 15000 }).catch(() => {});
const nd = await page.$('#newdyn');
if (nd) { await nd.click(); await page.waitForSelector('#dynmodal[open]'); await page.screenshot({ path: '__screenshots__/dynmodal.png' });
  // click backdrop (top-left corner of dialog area) to verify close
  await page.mouse.click(5, 5);
  const stillOpen = await page.$('#dynmodal[open]');
  console.log('backdrop-close works:', !stillOpen);
}
await browser.close();

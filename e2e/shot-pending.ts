// The Pending screen, against the real libraries.
import { chromium } from './playwright.js';

const PORT = process.env.WEB_PORT || 18768;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gopending', { timeout: 30000 });
await page.screenshot({ path: '__screenshots__/pending-landing-link.png' });
await page.click('#gopending');
await page.waitForSelector('#pending:not([hidden])');
// The listing is one container read per video library; give it room.
await page.waitForFunction(
  () => !document.querySelector('#pending [role="status"]'),
  undefined,
  { timeout: 120000 },
).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: '__screenshots__/pending-list.png' });
const menu = await page.$('#pendinggrid [data-testid="pending-addto"]');
if (menu) {
  await menu.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '__screenshots__/pending-addto.png' });
}
console.log('tiles:', (await page.$$('#pendinggrid li')).length);
await browser.close();
console.log('shot: __screenshots__/pending-*.png');

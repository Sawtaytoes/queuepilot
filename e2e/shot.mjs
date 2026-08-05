// Ad-hoc visual screenshot of the Play landing at a wide viewport.
import { chromium } from './playwright.mjs';
const PORT = process.env.WEB_PORT || 18768;
const W = parseInt(process.env.SHOT_W || '1680', 10);
const out = process.env.SHOT_OUT || '__screenshots__/play.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: 1000 } });
await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.playrow', { timeout: 30000 });
await page.screenshot({ path: out, fullPage: true });
console.log('wrote', out, 'at', W + 'px');
await browser.close();

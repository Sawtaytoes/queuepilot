// Visual capture of the Playback Length control in both editors. Not a gate — it exists so
// the change can be LOOKED at. Degraded no-Plex path, so no token needed.
import { chromium } from './playwright.js';
const BASE = `http://localhost:${process.env.WEB_PORT || 18775}`;
const TAG = process.env.SHOT_TAG || 'after';
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1150, height: 1250 } });

// 1. A filtered pool carrying the LEGACY refill shape — it must read Infinite.
await page.goto(`${BASE}/channels/younger`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#chconfigure', { timeout: 20000 });
await page.click('#chconfigure');
await page.waitForSelector('#dynmodal[data-open]', { timeout: 10000 });
await page.waitForTimeout(900);
const pool = await page.$('#dyn-lineup');
if (pool) await pool.screenshot({ path: `__screenshots__/playback-pool-${TAG}.png` });
console.log('wrote pool');

// 2. The picker open — 12 / 24 / 60 / Infinite / Custom.
await page.click('[data-testid="dyn-length"]');
await page.waitForTimeout(500);
await page.screenshot({ path: `__screenshots__/playback-presets-${TAG}.png`, clip: { x: 250, y: 300, width: 640, height: 560 } });
console.log('wrote presets');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.keyboard.press('Escape');

// 3. A REWATCH pool — it gets the control now instead of a note.
await page.goto(`${BASE}/channels/older`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);

// 4. The ORDERED queue editor.
await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
const cfg = await page.$('#qconfigure');
if (cfg) { await cfg.click(); await page.waitForSelector('#setmodal[data-open]', { timeout: 10000 }); await page.waitForTimeout(800); }
const flags = await page.$('#set-flags');
if (flags) await flags.screenshot({ path: `__screenshots__/playback-queue-${TAG}.png` });
console.log('wrote queue');
await b.close();

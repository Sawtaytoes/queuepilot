import { chromium } from './playwright.js';
import { pickValue } from './pick.js';
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, ignoreHTTPSErrors: true });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('https://plex-channels.example.com', { waitUntil: 'domcontentloaded' });

// Landing = the Play list.
await page.waitForSelector('.playcard', { timeout: 60000 });
// Post-v2 IA: Filtered Pools (rule-derived) + Curated Pools (anime) + Ordered Queues.
const dynRows = await page.$$eval('#playgrid li[data-kind="filtered"] .rowname', (els) => els.map((e) => e.textContent));
const curRows = await page.$$eval('#playgrid li[data-kind="curated"] .rowname', (els) => els.map((e) => e.textContent));
const qRows = await page.$$eval('#playgrid li[data-kind="ordered"] .rowname', (els) => els.map((e) => e.textContent));
// Structural, not exact counts: since first-class channels (2026-07-29) each rotation
// channel is its own row (Shows & Shorts, Shows, Shorts, Movies, …) and Bob adds/removes
// channels + queues over time, so all three groups are lower-bounded. The Movies rewatch
// channel must be present — it is the one this smoke previews below.
ok(`live landing: dynamic ${dynRows.length} / curated ${curRows.length} / queues ${qRows.length}`,
  dynRows.length >= 2 && dynRows.includes('Movies') && dynRows.includes('Shows & Shorts')
  && curRows.length >= 1 && qRows.length >= 1);
ok('undo/redo buttons present', Boolean(await page.$('#undo')) && Boolean(await page.$('#redo')));

// Channels: live preview renders poster tiles
await page.click('#gochannels');
await page.waitForSelector('#channels:not([hidden])');
await page.waitForFunction(() => document.querySelectorAll('#chpool li.tile').length > 5, undefined, { timeout: 120000 });
const poolTitle = (await page.textContent('#chpool-title')) ?? '';
ok(`channels preview renders (${poolTitle.trim()})`, /\d+ shows/.test(poolTitle));

// Movies channel: rewatch pool renders with counts.
await pickValue(page, '[data-testid="chchannel"]', 'movies');
await page.waitForFunction(() => /rewatch pool/.test(document.querySelector('#chpool-title')?.textContent || ''), undefined, { timeout: 120000 });
const mTitle = (await page.textContent('#chpool-title')) ?? '';
ok(`movies channel pool renders (${mTitle.trim()})`, /\d+ movies/.test(mTitle));
await pickValue(page, '[data-testid="chchannel"]', 'shows');
await page.waitForSelector('#channels:not([hidden])');

// Play menu lists real devices — do NOT click one. The Shield must appear exactly once
// (default merged with its plex.tv listing).
await page.click('#chplay');
await page.waitForFunction(() => document.querySelectorAll('.playmenu button').length > 0, undefined, { timeout: 20000 });
const devs = await page.$$eval('.playmenu button', (bs) => bs.map((b) => b.textContent ?? ''));
const shields = devs.filter((d) => /SHIELD/i.test(d));
ok(`device menu lists devices (${devs.length}): ${devs.slice(0, 4).join(', ')}`, shields.length >= 1);
ok('no duplicate Shield entry', shields.length === 1);
await page.keyboard.press('Escape');
await page.click('#back');
await page.waitForSelector('#play:not([hidden]) .playcard');

// Queues configurator + header search keyboard on live data (no add — navigate + close).
await page.click('#goqueues');
await page.waitForSelector('#home:not([hidden]) .shelf li.tile', { timeout: 60000 });
const shelves = await page.$$eval('.shelf', (els) => els.map((e) => e.dataset.set));  // HTMLElement -> dataset
ok(`live queue shelves render (${shelves.length})`, shelves.length >= 1);
await page.fill('#gsearch', 'duel');
await page.waitForSelector('#gresults.open li', { timeout: 30000 });
await page.keyboard.press('ArrowDown');
ok('live keyboard highlight', Boolean(await page.$('#gresults li.active')));
await page.keyboard.press('Escape');
await browser.close();
console.log('done');

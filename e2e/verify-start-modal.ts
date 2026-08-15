// Focused verifier for the "Start from…" picker (the modal that replaced the inline
// "Start [au]" box). Drives a REAL browser against the dev harness (e2e/dev.sh must be
// running on :18780 — it serves the rich fixtures + real Plex, so collections resolve).
//
//   bash e2e/dev.sh &            # once
//   server/node_modules/.bin/tsx e2e/verify-start-modal.ts
//
// Checks: no inline start control anywhere; the next-up line opens the picker; a right-click
// opens the tile menu; a SHOW start writes {season, episode}; a COLLECTION start writes
// {series, season, episode} for the picked member; the chip appears and clears again.
import { chromium } from './playwright.js';
import { currentValue, pickIndex, pickValue, readOptions } from './pick.js';
import { readFileSync } from 'node:fs';

const PORT = process.env.WEB_PORT || 18780;
const YAML = process.env.QUEUES_PATH || '/tmp/queues-harness.yaml';
const SHOTS = process.env.SHOT_DIR || '__screenshots__';
let fails = 0;
const ok = (name: string, isPass: boolean) => { console.log(isPass ? `PASS ${name}` : `FAIL ${name}`); if (!isPass) fails++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const tileByTitle = (title: string) => page.locator('#grid li.tile', { hasText: title }).first();

await page.goto(`http://localhost:${PORT}/#/q/bob_anime`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#grid li.tile');
await page.waitForTimeout(2000);

// 1. The inline control is gone for good.
ok('no inline start control on any tile', (await page.locator('.startctl').count()) === 0);
ok('no "Play" label before the eps dropdown', !(await page.locator('#grid .eps').first().innerText()).includes('Play'));

// 2. A show tile: the next-up line opens the picker.
const bebop = tileByTitle('Steins;Gate');
await bebop.locator('.next').click();
await page.waitForSelector('#startmodal[data-open]');
await page.waitForTimeout(1200);
ok('show picker: season row hidden (single-season)', await page.locator('#start-seasonbox').isHidden());
ok('show picker: series row hidden (not a collection)', await page.locator('#start-seriesbox').isHidden());
const epOptions = await readOptions(page, '[data-testid="start-episode"]');
ok('show picker: episodes listed by name', epOptions.length > 3 && /^E\d+ · /.test(epOptions[0] ?? ''));
await page.screenshot({ path: `${SHOTS}/start-modal-show.png` });
await pickIndex(page, '[data-testid="start-episode"]', 11);
const pickedEp = await currentValue(page, '[data-testid="start-episode"]');
await page.click('#start-save');
await page.waitForTimeout(2500);
const yaml1 = readFileSync(YAML, 'utf8');
ok(`show start written to YAML (episode ${pickedEp})`,
  new RegExp(`start:[\\s\\S]{0,60}episode: ${pickedEp}`).test(yaml1));
ok('show tile shows the start chip', (await tileByTitle('Steins;Gate').locator('.startbadge').count()) === 1);

// 3. A collection tile: pick WHICH member, then the episode inside it.
const chaika = tileByTitle('Avenging Battle');
await chaika.locator('.next').click();
await page.waitForSelector('#startmodal[data-open]');
await page.waitForTimeout(1500);
ok('collection picker: series row shown', await page.locator('#start-seriesbox').isVisible());
const members = await readOptions(page, '[data-testid="start-series"]');
ok('collection picker: members in collection order', members.length === 3 && (members[0] ?? '').startsWith('1. '));
ok('collection picker: defaults to the member that plays next',
  (await currentValue(page, '[data-testid="start-series"]')) === '365573');
// Start at the FIRST member instead (earlier members are skipped, so this is a real change).
await pickValue(page, '[data-testid="start-series"]', '365591');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/start-modal-collection.png` });
await pickIndex(page, '[data-testid="start-episode"]', 4);
const collEp = await currentValue(page, '[data-testid="start-episode"]');
await page.click('#start-save');
await page.waitForTimeout(3000);
const yaml2 = readFileSync(YAML, 'utf8');
ok('collection start names the member series', /series: ["']?365591/.test(yaml2));
ok(`collection start pins the episode (${collEp})`,
  new RegExp(`series: ["']?365591[\\s\\S]{0,80}episode: ${collEp}`).test(yaml2));

// 4. Right-click opens the tile menu, and it can clear the override.
const chaika2 = tileByTitle('Chaika');
await chaika2.locator('.thumb').click({ button: 'right' });
await page.waitForSelector('#tilemenu:not([hidden])');
const menuItems = await page.locator('#tilemenu button').allInnerTexts();
ok('menu offers change + clear + remove', menuItems.length === 3
  && /start/i.test(menuItems[0] ?? '') && /clear/i.test(menuItems[1] ?? '') && /Remove/i.test(menuItems[2] ?? ''));
await page.screenshot({ path: `${SHOTS}/start-tilemenu.png` });
await page.locator('#tilemenu button', { hasText: 'clear' }).click();
await page.waitForTimeout(2500);
const yaml3 = readFileSync(YAML, 'utf8');
ok('clearing removes the collection start from YAML', !/series: ["']?365591/.test(yaml3));

ok('no console errors', errors.length === 0);
if (errors.length) console.log(errors);
await page.screenshot({ path: `${SHOTS}/start-after.png` });
await browser.close();
console.log(fails ? `FAILURES: ${fails}` : 'done');
process.exit(fails ? 1 : 0);

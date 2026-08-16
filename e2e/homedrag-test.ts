import { chromium, type BoundingBox, type Page } from './playwright.js';
const ok = (name: string, isPass: boolean) => { console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`); if (!isPass) process.exitCode = 1; };

/**
 * The geometry a drag is built from, or a named failure. A drag driven from a missing
 * element (or from a box-less one — `display: none`, a not-yet-laid-out tile) computes its
 * mouse path from NaN and then "fails" as a silent no-move three assertions later, which is
 * how this suite used to report a broken selector.
 *
 * `waitForSelector`, not `$`: the only wait above is for `li.tile` (ANY tile), so a cold
 * page that has painted tile 1 but not yet tile 4 made the old `$` return null and the drag
 * blow up on `null.boundingBox()` — intermittent, and blaming the drag rather than the
 * timing. A selector that is genuinely wrong still fails here, just 15s later.
 */
async function boxOf(page: Page, selector: string): Promise<BoundingBox> {
  const handle = await page.waitForSelector(selector, { timeout: 15000 }).catch(() => null);
  if (!handle) throw new Error(`drag source/target not found: ${selector}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no bounding box (not rendered?): ${selector}`);
  return box;
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:18768/queues', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf[data-set="bob"] li.tile');

const stripSel = '.shelf[data-set="bob"] .strip';
const keys = await page.$$eval(`${stripSel} li.tile`, (els) => els.map((e) => e.dataset.key));
console.log('bob first 4:', keys.slice(0, 4).join(' | '));

// 1. Intra-shelf: drag tile[0] to slot 3.
const b0 = await boxOf(page, `${stripSel} li.tile:nth-child(1) .thumb`);
const b3 = await boxOf(page, `${stripSel} li.tile:nth-child(4) .thumb`);
await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
await page.mouse.down();
await page.mouse.move(b3.x + b3.width / 2 + 10, b3.y + b3.height / 2, { steps: 14 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Order saved'), undefined, { timeout: 20000 });
const after = await page.$$eval(`${stripSel} li.tile`, (els) => els.map((e) => e.dataset.key));
const landed = after.indexOf(keys[0]); console.log('landed at', landed, ':', JSON.stringify(after.slice(0,5))); ok('intra-shelf drag: tile moved right', landed >= 2 && landed <= 4 && after[0] === keys[1]);

// 2. Cross-shelf: drag bob's (new) first tile into bob_alice.
await page.waitForTimeout(1200); // let refreshData re-render settle
const srcSel = '.shelf[data-set="bob"] .strip li.tile:nth-child(1)';
const dstStrip = '.shelf[data-set="bob_alice"] .strip';
const movedKey = await page.$eval(srcSel, (e) => e.dataset.key);
const sb = await boxOf(page, `${srcSel} .thumb`);
const db = await boxOf(page, dstStrip);
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
await page.mouse.down();
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 + 60, { steps: 5 });
await page.mouse.move(db.x + 100, db.y + db.height / 2, { steps: 14 });
// drop-target highlight while hovering
const hl = await page.$eval('.shelf[data-set="bob_alice"]', (e) => e.classList.contains('drop-target'));
await page.mouse.up();
ok('drop-target highlight on hover', hl);
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Moved to'), undefined, { timeout: 20000 });
const inDst = await page.$$eval(`${dstStrip} li.tile`, (els) => els.map((e) => e.dataset.key));
ok('cross-shelf move landed', inDst.includes(movedKey));

// 3. Reload — persisted server-side.
await page.waitForTimeout(1000);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf[data-set="bob_alice"] li.tile, .shelf[data-set="bob_alice"] .empty');
const dstAfter = await page.$$eval(`${dstStrip} li.tile`, (els) => els.map((e) => e.dataset.key));
const srcAfter = await page.$$eval('.shelf[data-set="bob"] .strip li.tile', (els) => els.map((e) => e.dataset.key));
ok('move persisted (in dest, gone from src)', dstAfter.includes(movedKey) && !srcAfter.includes(movedKey));
await browser.close();
console.log('done');

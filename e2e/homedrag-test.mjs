import { chromium } from './playwright.mjs';
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:18768/#/queues', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf[data-set="bob"] li.tile');

const stripSel = '.shelf[data-set="bob"] .strip';
const keys = await page.$$eval(`${stripSel} li.tile`, (els) => els.map((e) => e.dataset.key));
console.log('bob first 4:', keys.slice(0, 4).join(' | '));

// 1. Intra-shelf: drag tile[0] to slot 3.
const t0 = await page.$(`${stripSel} li.tile:nth-child(1) .thumb`);
const t3 = await page.$(`${stripSel} li.tile:nth-child(4) .thumb`);
const b0 = await t0.boundingBox();
const b3 = await t3.boundingBox();
await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2);
await page.mouse.down();
await page.mouse.move(b3.x + b3.width / 2 + 10, b3.y + b3.height / 2, { steps: 14 });
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Order saved'), null, { timeout: 20000 });
const after = await page.$$eval(`${stripSel} li.tile`, (els) => els.map((e) => e.dataset.key));
const landed = after.indexOf(keys[0]); console.log('landed at', landed, ':', JSON.stringify(after.slice(0,5))); ok('intra-shelf drag: tile moved right', landed >= 2 && landed <= 4 && after[0] === keys[1]);

// 2. Cross-shelf: drag bob's (new) first tile into bob_alice.
await page.waitForTimeout(1200); // let refreshData re-render settle
const srcSel = '.shelf[data-set="bob"] .strip li.tile:nth-child(1)';
const dstStrip = '.shelf[data-set="bob_alice"] .strip';
const movedKey = await page.$eval(srcSel, (e) => e.dataset.key);
const src = await page.$(`${srcSel} .thumb`);
const sb = await src.boundingBox();
const db = await (await page.$(dstStrip)).boundingBox();
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
await page.mouse.down();
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 + 60, { steps: 5 });
await page.mouse.move(db.x + 100, db.y + db.height / 2, { steps: 14 });
// drop-target highlight while hovering
const hl = await page.$eval('.shelf[data-set="bob_alice"]', (e) => e.classList.contains('drop-target'));
await page.mouse.up();
ok('drop-target highlight on hover', hl);
await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Moved to'), null, { timeout: 20000 });
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

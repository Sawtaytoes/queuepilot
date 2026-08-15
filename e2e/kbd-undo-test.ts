import { chromium } from './playwright.js';
const ok = (name: string, isPass: boolean) => { console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`); if (!isPass) process.exitCode = 1; };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://localhost:18768/#/queues', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf');

// Keyboard add in queue view: type → ArrowDown x2 → Enter picks the 2nd result.
await page.click('.shelf[data-set="bob"] .open');
await page.waitForSelector('#queue:not([hidden])');
const before = await page.$$eval('#grid li.tile', (t) => t.length);
await page.fill('#search', 'clash of the titans');
await page.waitForSelector('#results.open li', { timeout: 15000 });
// The SECOND row, whatever it is. This used to hardcode /2010/, which silently
// stopped meaning "the second row" the day `collections=1` started returning a
// "Clash of the Titans Collection" row above the two films — the assertion has been
// red on main since, testing the search's result ORDER rather than the arrow keys.
const secondRowTxt = await page.$$eval('#results li', (ls) => ls[1]?.textContent ?? '');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
const activeTxt = await page.textContent('#results li.active');
await page.keyboard.press('Enter');
await page.waitForFunction((b) => document.querySelectorAll('#grid li.tile').length === b + 1, before, { timeout: 30000 });
ok(`keyboard add picked highlighted row (${(activeTxt ?? '').trim().slice(0, 30)}…)`,
  Boolean(secondRowTxt) && activeTxt === secondRowTxt);

// Header search keyboard: Enter opens Add-to menu, arrows walk it, Enter adds.
await page.click('#back');
await page.waitForSelector('#home:not([hidden]) .shelf');
await page.fill('#gsearch', 'duel');
await page.waitForSelector('#gresults.open li', { timeout: 15000 });
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter'); // opens menu, focuses first queue button
await page.waitForSelector('#gresults .qmenu button');
const isFocusInMenu = await page.evaluate(() => document.activeElement?.closest('.qmenu') != null);
ok('Enter opens Add-to menu with focus inside', isFocusInMenu);
await page.keyboard.press('Enter'); // native button activation = add to first queue
await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Added'), undefined, { timeout: 20000 });
ok('menu Enter adds', true);

// Close the search so the deferred background refresh applies, then read the count.
await page.keyboard.press('Escape');
await page.click('#heading');
await page.waitForFunction(() => {
  const undo = document.querySelector<HTMLButtonElement>('#undo');
  return undo !== null && !undo.disabled;
}, undefined, { timeout: 15000 });
await page.waitForTimeout(2500); // let the deferred refresh land
const kcount = await page.textContent('.shelf[data-set="bob"] .sec');
await page.click('#undo');
await page.waitForFunction((k) => document.querySelector('.shelf[data-set="bob"] .sec')?.textContent === String(Number(k) - 1), kcount, { timeout: 30000 });
ok('undo reverts the add', true);
await page.waitForFunction(() => {
  const redo = document.querySelector<HTMLButtonElement>('#redo');
  return redo !== null && !redo.disabled;
}, undefined, { timeout: 15000 });
await page.click('#redo');
await page.waitForFunction((k) => document.querySelector('.shelf[data-set="bob"] .sec')?.textContent === k, kcount, { timeout: 30000 });
ok('redo restores it', true);
await browser.close();
console.log('done');

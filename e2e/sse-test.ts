import { chromium } from './playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
const ok = (name: string, isPass: boolean) => { console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}`); if (!isPass) process.exitCode = 1; };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:18768/queues', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.shelf[data-set="bob"]');
const before = await page.textContent('.shelf[data-set="bob"] .sec');
// External hand-edit: put a title at the top of the bob queue, like an SMB edit would.
const y = readFileSync('/tmp/queues-ui.yaml', 'utf8');
writeFileSync('/tmp/queues-ui.yaml', y.replace(/^bob:\n/m, 'bob:\n- "The Terminator (1984)"\n'));
await page.waitForFunction(
  (b) => document.querySelector('.shelf[data-set="bob"] .sec')?.textContent === String(Number(b) + 1),
  before, { timeout: 30000 },
);
ok(`live update: bob ${before} -> ${Number(before) + 1} without reload`, true);
await browser.close();
console.log('done');

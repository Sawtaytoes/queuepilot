// Navigation-document browser gate; launcher.test.ts covers the real /go route and
// rebuild. A desktop browser cannot verify Android's app resolver or custom-tab UI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { chromium } from './playwright.js';
import { readerHandoff } from '../server/src/providers/readerHandoff.js';

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url?.startsWith('/fixture-reader')) {
    res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reader fixture</title><h1>Kavita reader fixture</h1><p>Stub destination for the pre-change redirect. Android browser controls are outside this test.</p></html>');
  } else {
    res.end(String(readerHandoff(`http://127.0.0.1:${port}/fixture-reader?incognitoMode=false&readingListId=7`)));
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const port = address.port;
const output = 'docs/images/android-reader-handoff';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height] of [
    ['phone', 384, 824], ['portrait', 1080, 1920],
    ['desktop', 1920, 1080], ['ultrawide', 3440, 1440],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`http://127.0.0.1:${port}/fixture-reader`);
    await page.screenshot({ path: `${output}/before-${name}.png` });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('h1');
    assert.equal(await page.$eval('h1', e => e.textContent), 'Your reading list is ready');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const links = await page.$$eval('a', elements => elements.map(e => ({ href: e.getAttribute('href'), rel: e.getAttribute('rel') })));
    const primary = links[0];
    assert(primary && primary.href);
    assert(primary.href.startsWith('intent://'));
    assert(primary.href.includes('readingListId=7'));
    assert.equal(primary.rel, 'noreferrer noopener');
    await page.screenshot({ path: `${output}/after-${name}.png` });
    await page.click('a:nth-of-type(2)');
    await page.waitForSelector('h1');
    assert.equal(new URL(page.url()).searchParams.get('readingListId'), '7');
    assert.equal(new URL(page.url()).searchParams.get('incognitoMode'), 'false');
    await page.close();
    console.log(`PASS reader handoff ${name}, complete website fallback`);
  }
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

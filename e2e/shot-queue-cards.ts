// Before/after evidence, using only the committed synthetic landing fixture.
import { mkdir } from 'node:fs/promises';
import { startFixtureServer } from './fixture-server.js';
import { chromium } from './playwright.js';
import { killServer } from './stubs/server-process.mjs';

const tag = process.env.QUEUE_CARDS_SHOT_TAG || 'after';
const server = await startFixtureServer(Number(process.env.QUEUE_CARDS_SHOT_PORT || 19428), {
  groups: 'landing.groups.yaml', people: 'landing.people-mapping.yaml',
  queues: 'landing.queues.yaml', sets: 'landing.sets.yaml',
});
const browser = await chromium.launch({ headless: true });
try {
  await mkdir('__screenshots__', { recursive: true });
  for (const scheme of ['dark', 'light'] as const) {
  for (const [name, width, height] of [['narrow',384,824],['tall',1080,1920],['wide',1920,1080],['ultrawide',3440,1440]] as const) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript((scheme) => { localStorage.setItem('charcuterie.scheme', scheme) }, scheme);
    await page.goto(`${server.base}/queues`);
    await page.waitForSelector('.shelf');
    await page.waitForFunction(() => !document.querySelector('#revalidating') && !document.querySelector('#status')?.textContent);
    await page.evaluate((scheme) => document.documentElement.dataset.scheme = scheme, scheme);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `__screenshots__/queue-cards-${tag}-${name}-${scheme}.png`, fullPage: true });
    await page.close();
  }
  }
} finally {
  await browser.close();
  killServer(server.child);
}

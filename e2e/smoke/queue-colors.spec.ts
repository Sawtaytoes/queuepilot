import { expect, test } from '@playwright/test';
import { smokeServers } from './ports.js';

test('queue shelves retain their colors after reload and use the shared categorical palette', async ({ page }, testInfo) => {
  const revalidated = page.waitForResponse((response) => response.url().includes('/api/queues?fresh=1'));
  await page.goto(`${smokeServers.landing}/queues`);
  await revalidated;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => { const status = document.querySelector('#status'); return (!status || !status.textContent) && !document.querySelector('#revalidating'); });
  const shelves = page.locator('.shelf[data-set]');
  await expect(shelves.first()).toBeVisible();
  const firstCount = shelves.first().locator('h2 .sec');
  await expect(firstCount).toBeInViewport();
  const countBounds = await firstCount.boundingBox();
  if (!countBounds) throw new Error('Missing queue count');
  expect(countBounds.x + countBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const colors = await shelves.evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-set'),
    color: getComputedStyle(element, '::before').boxShadow,
    shadow: getComputedStyle(element).boxShadow,
    pointerEvents: getComputedStyle(element, '::before').pointerEvents,
  })));
  expect(colors.length).toBeGreaterThan(1);
  expect(colors.every((entry) => entry.color.endsWith('3px 0px 0px 0px inset'))).toBe(true);
  expect(colors.every((entry) => entry.shadow === 'none' && entry.pointerEvents === 'none')).toBe(true);
  expect(new Set(colors.map((entry) => entry.color)).size).toBeGreaterThan(1);
  const titleBounds = await shelves.first().locator('.lbl').boundingBox();
  await testInfo.attach('queue-edges', { body: await page.screenshot(), contentType: 'image/png' });
  // The shared edge overlays the shelf. Hiding it must not move its content.
  const withoutEdge = await page.addStyleTag({ content: '.shelf::before { box-shadow: none !important; }' });
  expect(await shelves.first().locator('.lbl').boundingBox()).toEqual(titleBounds);
  await withoutEdge.evaluate((element) => element.parentNode?.removeChild(element));
  await page.reload();
  await expect(shelves.first()).toBeVisible();
  const after = await shelves.evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-set'),
    color: getComputedStyle(element, '::before').boxShadow,
    shadow: getComputedStyle(element).boxShadow,
    pointerEvents: getComputedStyle(element, '::before').pointerEvents,
  })));
  expect(after).toEqual(colors);
});

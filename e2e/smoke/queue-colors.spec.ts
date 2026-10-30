import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
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
    id: element.getAttribute('data-set'), color: getComputedStyle(element).boxShadow,
  })));
  expect(colors.length).toBeGreaterThan(1);
  expect(colors.every((entry) => entry.color.endsWith('-6px 0px 0px 0px'))).toBe(true);
  expect(new Set(colors.map((entry) => entry.color)).size).toBeGreaterThan(1);
  await fs.mkdir('../docs/images/queue-colors', { recursive: true });
  if (testInfo.project.name === 'chromium-wide') {
    const titleBounds = await shelves.first().locator('.lbl').boundingBox();
    await page.screenshot({ path: '../docs/images/queue-colors/after.png' });
    await shelves.evaluateAll((elements) => elements.forEach((element) => {
      const html = element as HTMLElement;
      html.dataset.originalStyle = html.getAttribute('style') || '';
      html.style.removeProperty('box-shadow');
    }));
    expect(await shelves.first().locator('.lbl').boundingBox()).toEqual(titleBounds);
    await page.screenshot({ path: '../docs/images/queue-colors/before.png' });
    await shelves.evaluateAll((elements) => elements.forEach((element) => {
      element.setAttribute('style', (element as HTMLElement).dataset.originalStyle || '');
    }));
  }
  await page.reload();
  await expect(shelves.first()).toBeVisible();
  const after = await shelves.evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-set'), color: getComputedStyle(element).boxShadow,
  })));
  expect(after).toEqual(colors);
});

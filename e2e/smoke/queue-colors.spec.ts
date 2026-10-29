import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { smokeServers } from './ports.js';

test('queue shelves retain their colors after reload and use the shared categorical palette', async ({ page }, testInfo) => {
  await page.goto(`${smokeServers.landing}/queues`);
  const shelves = page.locator('.shelf[data-set]');
  await expect(shelves.first()).toBeVisible();
  const colors = await shelves.evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-set'), color: getComputedStyle(element).borderInlineStartColor,
    width: getComputedStyle(element).borderInlineStartWidth,
  })));
  expect(colors.length).toBeGreaterThan(1);
  expect(colors.every((entry) => entry.width === '6px')).toBe(true);
  expect(new Set(colors.map((entry) => entry.color)).size).toBeGreaterThan(1);
  await fs.mkdir('../docs/images/queue-colors', { recursive: true });
  if (testInfo.project.name === 'chromium-wide') {
    await page.screenshot({ path: '../docs/images/queue-colors/after.png' });
    await shelves.evaluateAll((elements) => elements.forEach((element) => {
      const html = element as HTMLElement;
      html.dataset.originalStyle = html.getAttribute('style') || '';
      html.style.removeProperty('border-inline-start');
      html.style.removeProperty('padding-inline-start');
    }));
    await page.screenshot({ path: '../docs/images/queue-colors/before.png' });
    await shelves.evaluateAll((elements) => elements.forEach((element) => {
      element.setAttribute('style', (element as HTMLElement).dataset.originalStyle || '');
    }));
  }
  await page.reload();
  await expect(shelves.first()).toBeVisible();
  const after = await shelves.evaluateAll((elements) => elements.map((element) => ({
    id: element.getAttribute('data-set'), color: getComputedStyle(element).borderInlineStartColor,
    width: getComputedStyle(element).borderInlineStartWidth,
  })));
  expect(after).toEqual(colors);
});

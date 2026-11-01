import { expectNoHorizontalOverflow, expectNoSplitWords } from '@charcuterie/playwright-config/responsive.js';
import { expect, test } from '@playwright/test';

import { startFixtureServer } from '../fixture-server.js';
import { killServer } from '../stubs/server-process.mjs';
import { SMOKE_BASE_PORT } from './ports.js';

// Each project writes to its own fixture server. No household data or shared smoke state.
test('queue cards keep previews, filtering, navigation, and grid reorder', async ({ page }, testInfo) => {
  const server = await startFixtureServer(SMOKE_BASE_PORT + 10 + testInfo.workerIndex, {
    groups: 'landing.groups.yaml',
    people: 'landing.people-mapping.yaml',
    queues: 'landing.queues.yaml',
    sets: 'landing.sets.yaml',
  });
  try {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${server.base}/queues`);
    const cards = page.locator('#shelves .shelf');
    await expect(cards.first()).toBeVisible();
    await expect(page.locator('#revalidating')).toHaveCount(0, { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    const first = cards.first();
    await expect(first.locator('.qpeople')).toBeVisible();
    await expect(first.locator('.shelfedit')).toBeVisible();
    await expect(first.locator('.strip-wrap')).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await expectNoSplitWords(page);
    await page.screenshot({ path: testInfo.outputPath('cards.png'), fullPage: true });
    await testInfo.attach('queue cards', { path: testInfo.outputPath('cards.png'), contentType: 'image/png' });

    await first.getByRole('button', { name: 'Preview queue', exact: true }).click();
    await expect(first.locator('.strip-wrap')).toBeVisible();
    await expect(first.locator('li.tile').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('expanded.png'), fullPage: true });
    await first.getByRole('button', { name: 'Collapse queue', exact: true }).click();
    await page.reload();
    await expect(cards.first().locator('.strip-wrap')).toBeHidden();

    // Hidden cards and their family wrappers must not leave empty grid cells.
    await page.locator('#qfilter').fill('no-such-queue-52536254');
    await expect(page.locator('#shelves .queue-family:visible')).toHaveCount(0);
    await page.locator('#qfilter').fill('');
    await expect(cards.first()).toBeVisible();

    // Move to the next card by X as well as Y: a vertical-only hit test cannot do this.
    const families = page.locator('#shelves .queue-family');
    const firstId = await families.nth(0).locator('.shelf').first().getAttribute('data-set');
    const secondId = await families.nth(1).locator('.shelf').first().getAttribute('data-set');
    const handle = families.nth(0).locator('.shelfdrag');
    await handle.scrollIntoViewIfNeeded();
    const from = await handle.boundingBox();
    await families.nth(1).scrollIntoViewIfNeeded();
    const to = await families.nth(1).boundingBox();
    if (!from || !to) throw new Error('missing queue drag geometry');
    // Re-read after scrolling the narrow viewport.
    await handle.scrollIntoViewIfNeeded();
    const start = await handle.boundingBox();
    const target = await families.nth(1).boundingBox();
    if (!start || !target) throw new Error('missing visible drag geometry');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/sets-order') && r.request().method() === 'PATCH');
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width * .8, target.y + target.height / 2, { steps: 8 });
    await page.mouse.up();
    const response = await saved;
    expect(response.ok()).toBe(true);
    const ids = response.request().postDataJSON().ids as string[];
    expect(ids.indexOf(secondId!)).toBeLessThan(ids.indexOf(firstId!));
    await page.reload();
    await expect(families.first().locator('.shelf').first()).toHaveAttribute('data-set', secondId!);
    const destination = await families.first().locator('a.open').first().getAttribute('href');
    await families.first().locator('a.open').first().click();
    await expect(page).toHaveURL(`${server.base}${destination}`);
    expect(errors).toEqual([]);
  } finally {
    killServer(server.child);
  }
});

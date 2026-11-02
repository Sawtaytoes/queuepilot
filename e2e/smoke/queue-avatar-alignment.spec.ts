import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServer } from '../fixture-server.js';
import { killServer, REPO_ROOT } from '../stubs/server-process.mjs';
import { SMOKE_BASE_PORT } from './ports.js';

test('required groups and optional photo avatars share a vertical center', async ({ page, request }, testInfo) => {
  const server = await startFixtureServer(SMOKE_BASE_PORT + 40 + testInfo.workerIndex, {
    groups: 'landing.groups.yaml', people: 'landing.people-mapping.yaml',
    queues: 'landing.queues.yaml', sets: 'landing.sets.yaml',
  });
  try {
    const uploaded = await request.put(`${server.base}/api/people/ada/photo`, {
      data: await readFile(path.join(REPO_ROOT, 'e2e/fixtures/photos/ada.jpg')),
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(uploaded.ok()).toBe(true);
    const saved = await request.put(`${server.base}/api/sets/younger/people`, {
      data: { members: [
        { kind: 'group', id: 'younger-kids', role: 'required' },
        { kind: 'person', id: 'ada', role: 'optional' },
      ] },
    });
    expect(saved.ok()).toBe(true);
    await page.goto(`${server.base}/queues`);
    const row = page.locator('.shelf[data-set="younger"] .qpeople');
    await row.scrollIntoViewIfNeeded();
    await expect(row.locator('.opt img')).toBeVisible();
    await expect.poll(() => row.locator('.opt img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.evaluate(() => document.fonts.ready);
    const required = await row.locator('.req [data-person-face]').boundingBox();
    const optional = await row.locator('.opt [data-person-face]').boundingBox();
    if (!required || !optional) throw new Error('Missing audience avatar geometry');
    await testInfo.attach('aligned audience', { body: await row.screenshot(), contentType: 'image/png' });
    expect(Math.abs(required.y + required.height / 2 - optional.y - optional.height / 2)).toBeLessThan(1);
  } finally {
    killServer(server.child);
  }
});

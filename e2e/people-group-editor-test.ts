// The people-group editor's create and rule writes, end to end.
//
// This covers the browser half that the route tests cannot see: New must reset the form,
// Create must add the group and select it, and the rule control must write a changed minimum.
// The fixture contains only invented people and groups because the repository is public.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import { chromium } from './playwright.js';
import { pickValue } from './pick.js';
import { killServer, spawnServer } from './stubs/server-process.mjs';

const PORT = 18802;
const env = {
  ...process.env,
  CACHE_PATH: '/tmp/cache-people-group-editor.sqlite',
  GROUPS_PATH: '/tmp/groups-people-group-editor.yaml',
  HISTORY_PATH: '/tmp/history-people-group-editor.json',
  MQTT_HOST: '',
  MQTT_PASS: '',
  MQTT_PORT: '',
  MQTT_USER: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PEOPLE_MAPPING_PATH: '/tmp/people-mapping-people-group-editor.yaml',
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
  PLEX_TOKEN: '',
  QUEUES_PATH: '/tmp/queues-people-group-editor.yaml',
  SETS_PATH: '/tmp/sets-people-group-editor.yaml',
  WEB_PORT: String(PORT),
};

for (const [src, dest] of [
  ['e2e/fixtures/landing.sets.yaml', env.SETS_PATH],
  ['e2e/fixtures/landing.queues.yaml', env.QUEUES_PATH],
  ['e2e/fixtures/landing.groups.yaml', env.GROUPS_PATH],
  ['e2e/fixtures/landing.people-mapping.yaml', env.PEOPLE_MAPPING_PATH],
] as const) {
  await fs.copyFile(src, dest);
  await fs.rm(`${dest}.lock`, { force: true, recursive: true });
}
for (const stale of [
  '/tmp/queues-people-group-editor.queuepilot.sqlite',
  '/tmp/cache-people-group-editor.sqlite',
]) {
  await fs.rm(stale, { force: true });
}

let server: ChildProcess | undefined;
const browser = await chromium.launch();

try {
  server = spawnServer({ env, stdio: 'ignore' });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${PORT}/api/people`);
      if (response.ok) break;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* light then */
    }
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#peoplechips', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.click('#peopleedit');
  await page.waitForSelector('#peoplemodal', { timeout: 15000 });
  await page.click('#groupsedit');
  await page.waitForSelector('#groupsmodal', { timeout: 15000 });
  await page.waitForTimeout(500);

  const before = await page.locator('#groupsmodal .grouppick').count();
  await page.click('#groupnew');
  assert.equal(await page.inputValue('#grouplabel'), '');
  const createBox = await page.locator('#groupsave').boundingBox();
  assert.ok(createBox && createBox.y < 1000, 'Create group is below the visible form');
  assert.equal(await page.locator('#groupsave').textContent(), 'Create group');
  await page.fill('#grouplabel', 'Weekend Crew');
  await page.click('#groupsave');
  await page.waitForTimeout(1200);

  const after = await page.locator('#groupsmodal .grouppick').count();
  assert.equal(after, before + 1, 'Create group did not add a saved group');
  assert.equal(
    await page.locator('#groupsmodal .grouppick', { hasText: 'Weekend Crew' }).count(),
    1,
    'Created group is not visible in the saved list',
  );
  assert.equal(
    await page.locator('#groupsmodal .grouppick[aria-current="true"]', { hasText: 'Weekend Crew' }).count(),
    1,
    'Created group is not selected after save',
  );
  console.log('PASS create group from New people group');

  const newGroupRows = page.locator('#groupsmodal .groupmemberchoices');
  await newGroupRows.nth(0).locator('[role="radio"]').nth(2).click();
  await newGroupRows.nth(1).locator('[role="radio"]').nth(2).click();
  assert.equal(await page.locator('#group-rule').getAttribute('disabled'), null);
  await pickValue(page, '#group-rule', '1');
  assert.match(await page.textContent('#group-rule') ?? '', /At least 1 person/);
  await page.click('#groupsave');
  await page.waitForTimeout(1000);

  const createdRule = await fetch(`http://localhost:${PORT}/api/people`).then(
    (response) => response.json() as Promise<{
      groups: { id: string; minPresent: number | null; roster: { role: string }[] }[]
    }>,
  );
  const weekend = createdRule.groups.find((group) => group.id === 'weekend-crew');
  assert.equal(weekend?.minPresent, 1);
  assert.deepEqual(weekend?.roster.map((member) => member.role), ['required', 'required']);
  console.log('PASS change an all-optional group to an at-least-one rule');

  const older = page.locator('#groupsmodal .grouppick', { hasText: 'Older Kids' });
  await older.click();
  await page.waitForTimeout(400);
  await pickValue(page, '#group-rule', 'all');
  assert.match(await page.textContent('#group-rule') ?? '', /All required people/);
  await page.click('#groupsave');
  await page.waitForTimeout(1000);

  const apiPeople = await fetch(`http://localhost:${PORT}/api/people`).then(
    (response) => response.json() as Promise<{ groups: { id: string; minPresent: number | null }[] }>,
  );
  assert.equal(apiPeople.groups.find((group) => group.id === 'older-kids')?.minPresent, null);
  console.log('PASS change group rule from the editor');

  await context.close();
} finally {
  await browser.close();
  killServer(server);
}

console.log('people-group editor checks passed');

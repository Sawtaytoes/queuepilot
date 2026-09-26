// Synthetic browser proof for the queue search before and after shared-server support.
// VISUAL_ROOT may point at the parent commit's separate worktree for the before image.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';

const thisRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = process.env.VISUAL_ROOT || thisRoot;
const mode = process.env.VISUAL_MODE === 'before' ? 'before' : 'after';
const port = mode === 'before' ? 18996 : 18997;
const base = `http://127.0.0.1:${port}`;
const scratch = await fs.mkdtemp('/tmp/queuepilot-shared-search-');
const screenshot = path.join(thisRoot, '__screenshots__', `shared-search-${mode}.png`);

await fs.mkdir(path.dirname(screenshot), { recursive: true });
await fs.copyFile(path.join(thisRoot, 'e2e/fixtures/queues.harness.yaml'), `${scratch}/queues.yaml`);
await fs.copyFile(path.join(thisRoot, 'e2e/fixtures/sets.fixture.yaml'), `${scratch}/sets.yaml`);

const server = spawn(path.join(appRoot, 'server/node_modules/.bin/tsx'),
  [path.join(appRoot, 'server/src/index.ts')], {
    cwd: appRoot,
    detached: true,
    env: {
      ...process.env,
      CACHE_PATH: `${scratch}/cache.sqlite`,
      HISTORY_PATH: `${scratch}/history.json`,
      MQTT_HOST: '',
      QUEUES_PATH: `${scratch}/queues.yaml`,
      SETS_PATH: `${scratch}/sets.yaml`,
      STORE_PATH: `${scratch}/queuepilot.sqlite`,
      WEB_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/shelves`)).ok) break;
    } catch { /* Server is still starting. */ }
    if (Date.now() > deadline) throw new Error('QueuePilot did not start');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      colorScheme: 'dark', viewport: { width: 1280, height: 900 },
    });
    page.on('pageerror', (error) => { throw error; });
    await page.route('**/api/plex-sources?*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sources: [
        { id: 'home', name: 'Home Server', local: true, available: true,
          owned: true, libraries: [] },
        { id: 'friend-server', name: 'Friend Server', local: false, available: true,
          owned: false, libraries: [
            { id: '2', title: 'Shared Movies', type: 'movie' },
            { id: '3', title: 'Shared Shows', type: 'show' },
          ] },
      ] }),
    }));
    const searchUrls: string[] = [];
    await page.route('**/api/search?*', (route) => {
      searchUrls.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [{
          ratingKey: '42', title: 'Example Film', year: 2024, type: 'movie',
          sectionId: 2, viewCount: 0, viewOffset: 0,
          ...(mode === 'after' ? { plexServer: 'friend-server' } : {}),
        }] }),
      });
    });
    await page.goto(`${base}/q/bob`, { waitUntil: 'domcontentloaded' });
    await page.locator('#search').fill('Example');
    await page.locator('#results', { hasText: 'Example Film' }).waitFor();
    await page.locator('[data-testid="searchtype"]').waitFor({ state: 'visible' });
    if (mode === 'after') {
      await page.locator('[data-testid="searchsource"]').click();
      await page.getByRole('option', { name: 'Friend Server' }).click();
    }
    if (mode === 'after') {
      const deadline = Date.now() + 5000;
      while (!searchUrls.some((url) => url.includes('plex_server=friend-server'))) {
        if (Date.now() > deadline) {
          throw new Error('The search did not include the selected shared server');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await page.locator('#queue .add').screenshot({ path: screenshot });
    if (mode === 'after') {
      await page.locator('#search').press('Escape');
      await page.locator('#qconfigure').click();
      await page.getByRole('button', { name: 'Friend Server — all libraries' }).click();
      await page.getByRole('checkbox', { name: 'Shared Movies' }).check();
      await page.locator('#setmodal').screenshot({
        path: path.join(thisRoot, '__screenshots__', 'shared-library-settings.png'),
      });
      await page.locator('#set-save').click();
      await page.locator('#setmodal').waitFor({ state: 'hidden' });

      const saved = await (await fetch(`${base}/api/sets`)).json() as {
        sets: { id: string; shared_libraries: Record<string, string[]> }[];
      };
      const scope = saved.sets.find((set) => set.id === 'bob')?.shared_libraries;
      if (JSON.stringify(scope) !== JSON.stringify({ 'friend-server': ['2'] })) {
        throw new Error(`Shared library choice did not persist: ${JSON.stringify(scope)}`);
      }

      await page.locator('#qconfigure').click();
      await page.getByRole('button', { name: 'Friend Server — 1 selected' }).click();
      if (!(await page.getByRole('checkbox', { name: 'Shared Movies' }).isChecked())) {
        throw new Error('Saved shared library was not checked on reopen');
      }
      if (await page.getByRole('checkbox', { name: 'Shared Shows' }).isChecked()) {
        throw new Error('Unselected shared library was checked on reopen');
      }
      await page.locator('#set-cancel').click();
      await page.locator('[data-testid="searchlib"]').click();
      if (await page.getByRole('option', { name: 'Shared Shows' }).count()) {
        throw new Error('Unselected shared library is still offered in queue search');
      }
    }
    console.log(`PASS ${mode} queue search screenshot: ${screenshot}`);
  } finally {
    await browser.close();
  }
} finally {
  if (server.pid != null) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
  }
  await fs.rm(scratch, { recursive: true, force: true });
}

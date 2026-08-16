// Before/after of the entry count picker: set default 2 used to show 1 with no
// hint; now the picker shows 2 and tags that option Default.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.js';

const PORT = process.env.COUNT_DEFAULT_PORT || 18772;
const HARNESS_URL = `http://localhost:${PORT}/e2e-harness/count-default.html`;
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const OUT = fileURLToPath(new URL('../docs/images/', import.meta.url));

mkdirSync(OUT, { recursive: true });

const vite = spawn(join(WEB_DIR, 'node_modules/.bin/vite'),
  ['--port', String(PORT), '--strictPort'], {
    cwd: WEB_DIR,
    detached: true,
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
vite.unref();

let isStopped = false;
const stopVite = () => {
  if (isStopped) return;
  isStopped = true;
  try {
    if (vite.pid !== undefined) process.kill(-vite.pid, 'SIGTERM');
  } catch { /* already gone */ }
};
process.on('exit', stopVite);

const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(HARNESS_URL)).ok) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite never served ${HARNESS_URL}`);
};

await waitForServer();

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({
  viewport: { width: 920, height: 520 },
  colorScheme: 'light',
});

try {
  await page.goto(HARNESS_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="after"] button');

  await page.screenshot({
    path: join(OUT, '2026-08-16-count-default-closed.png'),
  });

  await page.click('[data-testid="before"] button');
  await page.waitForSelector('[role="listbox"] [role="option"]');
  await page.screenshot({
    path: join(OUT, '2026-08-16-count-default-before.png'),
  });
  await page.click('[data-testid="before"] button');
  await page.waitForSelector('[role="listbox"]', { state: 'detached' }).catch(() => null);

  await page.click('[data-testid="after"] button');
  await page.waitForSelector('[role="listbox"] [role="option"]');
  await page.screenshot({
    path: join(OUT, '2026-08-16-count-default-after.png'),
  });
} finally {
  await browser.close();
  stopVite();
}

console.log('wrote docs/images/2026-08-16-count-default-{closed,before,after}.png');

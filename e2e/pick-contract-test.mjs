// The `pick.mjs` <-> `SelectListbox` contract. Browser, but NO Plex.
//
// Every picker in this app is a Charcuterie `Listbox` behind a button trigger
// (2026-08-07-plex-channels-pickers-are-listbox-not-native-select), and since
// 2026-08-13 that trigger comes from `@charcuterie/ui`'s shared `Picker`
// (2026-08-13-selectlistbox-adopts-the-shared-charcuterie-picker). There is no
// native <select> left, so `e2e/pick.mjs` replaced `selectOption(sel, value)`
// with "click the trigger open, click the option carrying `[data-value]`".
//
// That contract had NO coverage on a pull request. The seventeen suites that
// use `pick.mjs` all live in the `PLEX_TOKEN`-gated step, and ci.yml's own
// comment says the secret is unset "so that step is skipped on every PR
// today" — so a green CI proved nothing about the pickers, and the Picker
// migration had to be verified by hand. This suite is that verification made
// permanent: it drives the REAL component with the REAL helpers, needs no
// Plex and no app server, and runs on every PR beside the narrow-view gate.
//
// What it holds, specifically:
//   - `id` reaches the DOM as `data-testid` (`useAnchoredOverlay` overwrites a
//     trigger's real `id`, so an `id` selector silently stops matching).
//   - Every option label carries `[data-value]` — what `pick.mjs` picks by.
//   - The trigger's accessible name is "<label>: <value>" and FOLLOWS the
//     value (WCAG 2.5.3; the pre-Picker trigger was named bare "Add to").
//   - Re-clicking an open trigger CLOSES it. `closeVia` depends on this, and
//     an outside-press dismiss that fires before the toggle would instead
//     close-then-reopen, hanging every suite that reads options and moves on.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from './playwright.mjs';
import {
  currentValue,
  pickIndex,
  pickValue,
  readOptionPairs,
  readOptions,
  readOptionValues,
} from './pick.mjs';

// Its own port, unrelated to WEB_PORT: this suite deliberately does not use
// the shared app server, so it cannot collide with one that is running.
const PORT = process.env.PICK_CONTRACT_PORT || 18771;
const HARNESS_URL = `http://localhost:${PORT}/e2e-harness/pick-contract.html`;
const TRIGGER = '[data-testid="addpos"]';
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

const ok = (name, isPass, detail = '') => {
  console.log(`${isPass ? 'PASS' : 'FAIL'} ${name}${detail && !isPass ? ` — ${detail}` : ''}`);
  if (!isPass) process.exitCode = 1;
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

// `vite` (not `vite build` + preview): the harness page is dev-only, and the
// production build has a single entry that does not include it.
//
// The local bin rather than `npx`: npx is a process in front of vite, and a
// SIGTERM to it does not necessarily reach the node it spawned — the first cut
// left an orphaned dev server holding the port, so the NEXT run's --strictPort
// died while `waitForServer` still saw a 200 from the corpse and sailed on.
// `detached` puts vite in its own process group so the whole group can be
// signalled; `unref` keeps a still-running server from holding this process
// open after the assertions are done.
const vite = spawn(join(WEB_DIR, 'node_modules/.bin/vite'),
  ['--port', String(PORT), '--strictPort'], {
    cwd: WEB_DIR,
    detached: true,
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const viteLog = [];
vite.stdout.on('data', (chunk) => viteLog.push(String(chunk)));
vite.stderr.on('data', (chunk) => viteLog.push(String(chunk)));
vite.unref();

let isStopped = false;
const stopVite = () => {
  if (isStopped) return;
  isStopped = true;
  try {
    // Negative pid = the whole group, so vite's own children go too.
    process.kill(-vite.pid, 'SIGTERM');
  } catch {
    // already gone
  }
};
process.on('exit', stopVite);
process.on('SIGINT', () => { stopVite(); process.exit(130); });

// If vite dies (most often --strictPort losing to a leftover server), say so
// instead of polling for 30s and then blaming the page.
let viteExit = null;
vite.on('exit', (code) => { viteExit = code ?? 'signal'; });

/** Poll rather than parse vite's banner — the banner has moved between majors. */
const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (viteExit !== null) {
      throw new Error(`vite exited (${viteExit}) before serving\n${viteLog.join('')}`);
    }
    try {
      const response = await fetch(HARNESS_URL);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`vite never served ${HARNESS_URL}\n${viteLog.join('')}`);
};

await waitForServer();

const browser = await chromium.launch();
const page = await browser.newPage();

// A harness that throws is a broken gate, not a passing one.
page.on('pageerror', (error) => ok(`no page error (${error.message})`, false));

try {
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TRIGGER, { timeout: 30000 });

  eq('trigger carries `id` as data-testid', await page.getAttribute(TRIGGER, 'data-testid'), 'addpos');
  eq('accessible name is "<label>: <value>"', await page.getAttribute(TRIGGER, 'aria-label'), 'Add to: Bottom');

  // The readers, which every suite uses to assert what a picker offers.
  eq('readOptionValues', await readOptionValues(page, TRIGGER), ['top', 'bottom', 'none']);
  eq('readOptions', await readOptions(page, TRIGGER), ['Top (plays next)', 'Bottom', 'Nowhere']);
  eq('readOptionPairs', await readOptionPairs(page, TRIGGER),
    [['Top (plays next)', 'top'], ['Bottom', 'bottom'], ['Nowhere', 'none']]);
  eq('currentValue reads aria-selected', await currentValue(page, TRIGGER), 'bottom');

  // The writers.
  await pickValue(page, TRIGGER, 'top');
  eq('pickValue reached onChange', await page.textContent('[data-testid="chosen"]'), 'top');
  eq('accessible name followed the value', await page.getAttribute(TRIGGER, 'aria-label'), 'Add to: Top (plays next)');
  eq('listbox closed after a pick', await page.locator('[role="listbox"]').count(), 0);

  await pickIndex(page, TRIGGER, 1);
  eq('pickIndex counts every option, disabled included',
    await page.textContent('[data-testid="chosen"]'), 'bottom');

  // `closeVia`: re-click closes. Must not close-then-reopen.
  await page.click(TRIGGER);
  await page.waitForSelector('[role="listbox"] [role="option"]');
  await page.click(TRIGGER);
  await page.waitForTimeout(300);
  eq('re-clicking the trigger closes it (closeVia)', await page.locator('[role="listbox"]').count(), 0);
} finally {
  await browser.close();
  stopVite();
}

console.log(process.exitCode ? '\npick.mjs contract BROKEN' : '\npick.mjs contract holds');

// Explicit: the dev server is detached and unref'd, but a lingering handle
// should never turn a finished suite into a hung CI job.
process.exit(process.exitCode ?? 0);

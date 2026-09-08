// Visual capture of the completion control in the Set editor. Not a gate — it exists so the
// change can be LOOKED at, and so the PR's before/after are reproducible rather than posed.
//
// BEFORE (`SHOT_TAG=before`, run against `main`): two checkboxes, `Playlist mode` and
// `Demo reel`, where checking the second forced the first on and disabled it.
// AFTER: one four-value Picker
// (decision `2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes`).
//
// Degraded no-Plex path, so no token is needed, and it runs against `e2e/fixtures/` synthetic
// data — never the household app. Start the server first with `SETS_PATH` / `QUEUES_PATH`
// pointed at copies of `e2e/fixtures/{sets,queues}.fixture.yaml`.
import { chromium } from './playwright.js';

const BASE = `http://localhost:${process.env.WEB_PORT || 18775}`;
const TAG = process.env.SHOT_TAG || 'after';
const OUT = process.env.SHOT_DIR || '__screenshots__';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1150, height: 1400 } });

// A curated Picks queue — the only shape that carries these knobs. Rotation pools have no
// consumption model and their editor (`DynModal`) never had the controls.
await page.goto(`${BASE}/q/bob`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
const configure = await page.$('#qconfigure');
if (!configure) throw new Error('no #qconfigure on /q/bob — is the fixture server up?');
await configure.click();
await page.waitForSelector('#setmodal[data-open]', { timeout: 15000 });
await page.waitForTimeout(900);

// 1. The whole "Playback & completion" fieldset, which is where the two checkboxes were.
const flags = await page.$('#set-flags');
if (!flags) throw new Error('no #set-flags — the fieldset moved');
await flags.screenshot({ path: `${OUT}/completion-flags-${TAG}.png` });
console.log(`wrote ${OUT}/completion-flags-${TAG}.png`);

// 2. The four rows, open. Nothing to capture on `main` — there is no panel there — so this
//    one is the AFTER alone, and the checkbox pair above is what it replaced.
const trigger = await page.$('[data-testid="set-completion-mode"]');
if (trigger) {
  await trigger.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/completion-options-${TAG}.png` });
  console.log(`wrote ${OUT}/completion-options-${TAG}.png`);

  // 3. DRIVEN TO THE STATE THAT CHANGED. A still of the closed control proves the picker is
  //    there; it does not prove the NEW mode reads correctly, and the hint under it is the
  //    only place the editor says what "start over" means. `e2e/pick.ts` picks by VALUE
  //    through the `data-value` inside every option label, which is why that attribute is
  //    this app's and has to survive any `SelectListbox` refactor.
  const restart = await page.$('[role="option"] [data-value="restart"]');
  if (restart) {
    await restart.click();
    await page.waitForTimeout(500);
    const chosen = await page.$('#set-flags');
    if (chosen) {
      await chosen.screenshot({ path: `${OUT}/completion-restart-${TAG}.png` });
      console.log(`wrote ${OUT}/completion-restart-${TAG}.png`);
    }
  }
  await page.keyboard.press('Escape');
}

await browser.close();

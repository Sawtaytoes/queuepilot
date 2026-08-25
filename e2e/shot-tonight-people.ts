// The people filter's before/after shots, driven to the states that actually changed.
//
// BEFORE and AFTER are the SAME script over the same fixture — `--tag=` names the output —
// because the difference is not a new control. It is the same list answering a different
// question: on `main` every frame below shows every queue for the activity no matter who is
// ticked, and the people badges are not drawn at all.
//
// **Fixture data, never live.** This screen renders people and queue labels, and both of
// those are the household. The cast here is the repo's own — Ada, Grace and Linus
// (decision `2026-08-19-pr-screenshots-are-fixture-data-never-live`).
//
//   PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
//     server/node_modules/.bin/tsx e2e/shot-tonight-people.ts --tag=after
import { chromium } from './playwright.js';
import { startTonightServer, stopTonightServer } from './tonight-harness.js';

const PORT = 18849;
const tagArg = process.argv.find((a) => a.startsWith('--tag='));
const TAG = tagArg ? tagArg.slice('--tag='.length) : 'after';

const server = await startTonightServer(PORT);
const browser = await chromium.launch();

try {
  // The owner's UI is dark, and the scheme persists to localStorage — so it is set before
  // the first paint rather than by clicking the toggle after it.
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 1100 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('charcuterie-scheme', 'dark');
    } catch {
      /* private mode — the shot is light then, and says so */
    }
  });

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

  const shot = async (name: string) => {
    await page.waitForTimeout(500);
    const path = `__screenshots__/tonight-people-${TAG}-${name}.png`;
    await page.screenshot({ fullPage: true, path });
    console.log('wrote', path);
  };

  const open = async () => {
    await page.goto(`${server.base}/tonight`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tonight:not([hidden])', { timeout: 30000 });
    // The queues come from `/api/sets` and their people from `/api/queue-people`, both of
    // which the landing loads on boot.
    await page.waitForTimeout(1400);
  };

  const tile = (label: string) => `#tonight-activity [role="radio"]:has-text("${label}")`;
  const mode = (label: string) => `#tonight-mode [role="radio"]:has-text("${label}")`;

  const tick = async (id: string) => {
    await page.click(`input[value="${id}"]`);
    await page.waitForTimeout(300);
  };

  const queues = async (label: string) => {
    await page.click(tile(label));
    await page.click(mode('Queues'));
    await page.waitForTimeout(600);
  };

  // ── 1. NOBODY TICKED — every queue is offered ───────────────────────────────────── //
  // A filter with nothing in it matches everything. Both reading queues are on screen.
  await open();
  await queues('Reading');
  await shot('1-nobody-ticked');

  // ── 2. ONE PERSON — the list narrows, and the step is not asked ─────────────────── //
  // Ada is on one of the two, so the question has one answer and a question with one
  // answer is not a question: it is SHOWN instead.
  await tick('ada');
  await queues('Reading');
  await shot('2-one-person-implied');

  // ── 3. TWO PEOPLE — the list narrows to nothing, and says so usefully ───────────── //
  // The decision's own worked example: "Ada — Manga" goes because Grace is not on it, and
  // "Grace — Comics" goes because Ada is not on it.
  await tick('grace');
  await queues('Reading');
  await shot('3-two-people-empty');

  // ── 4. A QUEUE NOBODY IS FILED ON IS STILL OFFERED ──────────────────────────────── //
  // `after_dinner` has no people. A queue no group claimed comes up empty by design, and
  // hiding it would make it unreachable — so it survives both ticks.
  await queues('Shows');
  await shot('4-peopleless-survives');

  // ── 5. TWO PEOPLE, and the list genuinely narrows rather than emptying ──────────── //
  // Video Games has a Steam queue and a MiSTer queue. Ada and Linus are both on the
  // arcade one; only Linus is on the other, so ticking Ada removes it.
  await open();
  await tick('ada');
  await tick('linus');
  await queues('Video Games');
  await shot('5-two-people-narrows');

  // ── 6. A GROUP COUNTS BY ITS OWN NUMBER ─────────────────────────────────────────── //
  // `game_night` is "at least one of Ada and Grace, and Linus may join". Ada alone brings
  // it up; a copy that flattened the group into its people would need both.
  await open();
  await tick('ada');
  await queues('Board Games');
  await shot('6-group-at-least-one');

  // ── 7. The Narrow View ──────────────────────────────────────────────────────────── //
  // Not "mobile": the trigger is the WIDTH. The queue cards take their columns from their
  // CONTAINER, so this is the same markup at one column rather than a second layout.
  await page.setViewportSize({ width: 390, height: 1400 });
  await open();
  await queues('Video Games');
  await shot('7-narrow-nobody-ticked');
  await tick('linus');
  await queues('Video Games');
  await shot('8-narrow-one-person');
} finally {
  await browser.close();
  stopTonightServer(server);
}

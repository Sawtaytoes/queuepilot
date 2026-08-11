// resume.js policy: which queued episodes get seeked to their own marker after the player
// advances, and exactly once each.
//
// The bug this closes (2026-08-11): a Plex playQueue has no per-item resume field and
// playMedia's `offset` applies only to the item it starts on, so episodes 2..N restart at
// 0:00. Confirmed live on the Shield with a kids' rotation — Mister Rogers had a 3m09s marker
// and began at 0:09. The owner's report was "sometimes at the beginning, sometimes after the
// intro. Feels totally random": the head resumes, everything after it does not.
import assert from 'node:assert/strict';

process.env.RESUME_MIN_MS = '30000';
process.env.RESUME_MAX_FRACTION = '0.95';
process.env.RESUME_START_WINDOW_MS = '120000';
const resume = await import('../server/src/resume.js');

let failed = 0;
const check = (label, actual, expected) => {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${label}`);
  } catch {
    console.log(`FAIL ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    failed++;
  }
};

// The real lineup from the live test, plus the shapes the policy has to reject.
const items = [
  { ratingKey: '184880', viewOffset: 775_000, viewCount: 0, duration: 775_000 },  // head, AND at 100%
  { ratingKey: '359877', viewOffset: 0, viewCount: 0, duration: 1_389_000 },      // never started
  { ratingKey: '106617', viewOffset: 189_000, viewCount: 0, duration: 346_000 },  // 3m09s — THE case
  { ratingKey: '269103', viewOffset: 876_000, viewCount: 0, duration: 1_370_000 }, // 14m36s
  { ratingKey: '999001', viewOffset: 9_000, viewCount: 0, duration: 1_400_000 },  // trivial 9s
  { ratingKey: '999002', viewOffset: 600_000, viewCount: 1, duration: 1_400_000 }, // already watched
  { ratingKey: '999003', viewOffset: 1_380_000, viewCount: 0, duration: 1_400_000 }, // 98.5% — over
];

const plan = resume.resumePlan(items, { headRatingKey: '184880' });

check('plans exactly the two genuine mid-episode markers',
  [...plan.entries()].sort(), [['106617', 189_000], ['269103', 876_000]]);
check('the head is excluded (playMedia already resumed it)', plan.has('184880'), false);
check('a zero marker is not planned', plan.has('359877'), false);
check('a trivial 9s marker is not planned', plan.has('999001'), false);
check('an already-watched marker is not planned', plan.has('999002'), false);
check('a marker past 95% is not planned (it would end instantly)', plan.has('999003'), false);

// Head exclusion must be by identity, not position: if the head has no marker of its own, a
// LATER item that happens to share... (ratingKeys are unique, so simply prove a non-head
// 100%-marker item is dropped on its own merit, not because it was first).
const noHead = resume.resumePlan([items[0]], { headRatingKey: null });
check('a 100%-of-duration marker is dropped even when it is not the head', noHead.size, 0);

// --- arming + one-shot firing ------------------------------------------------- //
resume.arm({ plan, device: null, setName: 'shows' });
check('arm reports the planned count', resume.armedCount(), 2);

check('landing on the 3m09s episode near its start returns its marker',
  resume.considerSession({ ratingKey: '106617', viewOffset: 4_000 }), 189_000);
check('the SAME episode is never reconsidered (the poll repeats every few seconds)',
  resume.considerSession({ ratingKey: '106617', viewOffset: 4_000 }), null);
check('an unplanned episode returns nothing',
  resume.considerSession({ ratingKey: '359877', viewOffset: 2_000 }), null);
check('a null session is safe', resume.considerSession(null), null);

// The guard the now-playing topic could never have provided: don't yank a viewer backwards.
resume.arm({ plan, device: null, setName: 'shows' });
check('an episode already well past its start is left alone',
  resume.considerSession({ ratingKey: '106617', viewOffset: 600_000 }), null);
check('…and is not reconsidered afterwards either',
  resume.considerSession({ ratingKey: '106617', viewOffset: 1_000 }), null);

// --- the watch loop ----------------------------------------------------------- //
// Drives the real interval with injected Plex/player stand-ins, so the loop itself is covered.
resume.arm({ plan, device: null, setName: 'shows' });
const seeks = [];
let feed = { ratingKey: '106617', viewOffset: 3_000 };
resume.startWatch({
  fetchSession: async () => feed,
  seek: async (ms) => { seeks.push(ms); return { seeked: true }; },
  intervalMs: 10,
  log: () => {},
});
await new Promise((r) => setTimeout(r, 60));
check('the watcher seeks the planned episode it observes', seeks, [189_000]);

feed = { ratingKey: '269103', viewOffset: 1_000 };
await new Promise((r) => setTimeout(r, 60));
check('…and the next one as the player advances', seeks, [189_000, 876_000]);
check('the watcher stops once every planned episode is handled', resume.watching(), false);

// A throwing Plex call must not kill the watcher.
resume.arm({ plan, device: null, setName: 'shows' });
let calls = 0;
resume.startWatch({
  fetchSession: async () => { calls += 1; if (calls < 3) throw new Error('plex 503'); return { ratingKey: '106617', viewOffset: 1_000 }; },
  seek: async () => ({ seeked: true }),
  intervalMs: 10,
  log: () => {},
});
await new Promise((r) => setTimeout(r, 120));
check('a transient Plex failure does not kill the watcher', calls >= 3, true);
resume.disarm();
check('disarm empties the plan and stops watching',
  [resume.armedCount(), resume.watching()], [0, false]);

console.log(failed ? `resume-on-advance FAILED (${failed})` : 'resume-on-advance OK');
process.exit(failed ? 1 : 0);

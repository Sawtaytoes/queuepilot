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

check('advancing to the 3m09s episode returns its marker',
  resume.onNowPlaying({ ratingKey: '106617', state: 'playing' }), 189_000);
check('the SAME episode does not fire twice (pause/resume republishes)',
  resume.onNowPlaying({ ratingKey: '106617', state: 'playing' }), null);
check('an unplanned episode returns nothing',
  resume.onNowPlaying({ ratingKey: '359877', state: 'playing' }), null);
check('a non-playing payload is ignored',
  resume.onNowPlaying({ ratingKey: '269103', state: 'paused' }), null);
check('…and is still eligible once it actually plays',
  resume.onNowPlaying({ ratingKey: '269103', state: 'playing' }), 876_000);
check('an empty/idle payload is safe',
  resume.onNowPlaying({ state: 'idle', ratingKey: null }), null);

// A re-scan must not inherit the previous lineup's pending seeks.
resume.arm({ plan: new Map([['106617', 189_000]]), device: null, setName: 'shows' });
check('re-arming clears the fired set so the new lineup can seek again',
  resume.onNowPlaying({ ratingKey: '106617', state: 'playing' }), 189_000);
resume.disarm();
check('disarm empties the plan', resume.armedCount(), 0);

console.log(failed ? `resume-on-advance FAILED (${failed})` : 'resume-on-advance OK');
process.exit(failed ? 1 : 0);

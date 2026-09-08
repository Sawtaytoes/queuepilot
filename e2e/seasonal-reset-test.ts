// A queue clears its own watched state on a date each year — and it is EVALUATED ON A READ.
//
// decision 2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year
// decision 2026-09-08-the-reset-is-exposed-on-the-api-and-mqtt-without-a-home-assistant-automation
//
// Six things this gate exists to pin, and the middle two are the ones a re-implementation gets
// wrong:
//
//   1. THE THREE THINGS. A reset clears the `done` / `done_at` flags, every
//      `queue_entry_history` row for the set, and the `lead_cooldown` rows. Only the first is
//      obvious, and a version that clears one of the three passes a hand test.
//   2. IT FIRES ON A REAL PLAY, WITH NO TIMER. The reset happens inside the shipped
//      `session.startSession()` — the same read that already consumes `promote_window` — and
//      it happens BEFORE the lineup is built, so the queue plays its first entry again rather
//      than one scan later. Asserted by running the real session against the synthetic corpus.
//   3. IT FIRES ONCE. There is no timer holding "already done today"; the
//      `queue_watched_reset` row is it. A second play the same evening must clear nothing.
//   4. ADOPTION CLEARS NOTHING. Setting a date on a running queue must not throw the season
//      away on the next play, which is what the literal "the last occurrence is in the past"
//      reading does.
//   5. AN OFF QUEUE IS UNCHANGED. A queue with no date behaves exactly as it does today.
//   6. NOTHING REACHES A PROVIDER. No Plex write, in either direction — the household server
//      holds other people's watch state in the same profile.
//
// Offline: Plex is the synthetic replay corpus, there is no token and no network.
//
// Run:  server/node_modules/.bin/tsx e2e/seasonal-reset-test.ts   (repo root; non-zero on failure)
process.env.PLAYBACK_FSM = 'true';
process.env.RESUME_ON_ADVANCE = 'false'; // no seek-watcher timer in a unit test
process.env.ADB_ENABLED = 'false';

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetSession, SESSION_CTL, stubSessionDeps, useFixtures } from './stubs/session-harness.mjs';
import type { SessionResult } from '../server/src/session.js';

stubSessionDeps();

// The book of record must live in this run's own scratch directory: the default is a path
// derived from the config candidates and is SHARED between runs, so a stale row from an
// earlier run would decide half the assertions below.
const STORE_DIR = mkdtempSync(path.join(tmpdir(), 'seasonal-reset-'));
process.env.STORE_PATH = path.join(STORE_DIR, 'queuepilot.sqlite');

// ── The fixture ───────────────────────────────────────────────────────────────────────────
//
// The reset date is TODAY, computed from the real clock rather than frozen. `applySeasonalReset`
// reads `new Date()` on the play path — that is the whole point of the feature — so the only
// honest way to drive it through the shipped `session.startSession()` is to make today the day.
// The date arithmetic itself is pinned separately and exhaustively by
// `server/src/seasonalReset.test.ts`, which injects every `now` this cannot.
const today = new Date();
const TODAY = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

const SETS = `sets:
  - id: seasonal
    label: Seasonal Queue
    source: queue
    sections: [1, 5]
    reset_watched_on: "${TODAY}"
  - id: plain
    label: Ordinary Queue
    source: queue
    sections: [1, 5]
`;
// "Movie C (2003)" is finished for the corpus's admin account, so a scan marks it done;
// "Movie A (2001)" is unwatched and keeps the queue playable. Same pair `keep-completed-test`
// uses, for the same reason.
const ENTRIES = ['  - {title: "Movie A (2001)"}', '  - {title: "Movie C (2003)"}'].join('\n');
const QUEUES = ['seasonal:', ENTRIES, 'plain:', ENTRIES, ''].join('\n');
const FX = useFixtures({ sets: SETS, queues: QUEUES });

const session = await import('../server/src/session.js');
const queues = await import('../server/src/queues.js');
const promote = await import('../server/src/promote.js');
const watchedReset = await import('../server/src/watchedReset.js');
const queueEntryHistory = await import('../server/src/store/db/queueEntryHistory.js');
const queueWatchedReset = await import('../server/src/store/db/queueWatchedReset.js');

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const sessionOk = (res: SessionResult): boolean => (res as { ok?: unknown }).ok === true;

/** Everything the three clearers own for one set, read back off disk. */
async function stateOf(setId: string) {
  const rows = await queues.listSet(setId);
  return {
    done: rows.filter((row) => row.done).map((row) => row.key),
    history: queueEntryHistory.progressFor(setId, 'title:Movie C (2003)').size
      + queueEntryHistory.progressFor(setId, 'title:Movie A (2001)').size,
    lastLed: await promote.lastLedAt(setId, 'title:Movie A (2001)'),
    settlement: queueWatchedReset.settlementFor(setId),
  };
}

/** Put the queue back to a season's worth of watched state, in all three places. */
async function seedWatchedState(setId: string): Promise<void> {
  writeFileSync(FX.queuesPath, QUEUES);
  await queues.markDone(setId, ['title:Movie C (2003)'], Math.floor(Date.now() / 1000));
  queueEntryHistory.markCompleted(setId, 'title:Movie C (2003)', 'leaf-1');
  queueEntryHistory.savePosition(setId, 'title:Movie A (2001)', 'leaf-2', 900_000, 5_400_000);
  await promote.recordLead(setId, 'title:Movie A (2001)');
}

async function play(setName: string): Promise<SessionResult> {
  resetSession();
  return session.startSession({ set: setName, kind: 'movie' });
}

// ── 1. THE THREE THINGS ───────────────────────────────────────────────────────────────────
console.log('=== 1. a reset clears three things, and only the first is obvious ===');
await seedWatchedState('seasonal');
const before = await stateOf('seasonal');
ok('seeded: an entry is done', before.done.length === 1, JSON.stringify(before.done));
ok('seeded: the queue-owned ledger has rows', before.history === 2, String(before.history));
ok('seeded: an entry holds a lead cooldown', before.lastLed != null);

const counts = await watchedReset.resetQueueWatchedState('seasonal');
const after = await stateOf('seasonal');
ok('1a. the done flags are gone', after.done.length === 0, JSON.stringify(after.done));
ok('1b. every queue_entry_history row is gone', after.history === 0, String(after.history));
ok('1c. the lead cooldowns are gone', after.lastLed == null);
ok('the count names all three', counts.entries === 1 && counts.historyRows === 2
  && counts.leadCooldowns === 1 && counts.total === 4, JSON.stringify(counts));
ok('a manual reset says so', counts.reason === 'manual', String(counts.reason));
ok('the file still holds both entries', (await queues.listSet('seasonal')).length === 2);
ok('nothing was removed from the queue', readFileSync(FX.queuesPath, 'utf8').includes('Movie C (2003)'));

// ── 2. ADOPTION CLEARS NOTHING ────────────────────────────────────────────────────────────
//
// Order matters here: this runs on a queue with a date and NO settlement row, which is the
// state a queue is in the moment somebody sets one. The literal reading of "the last occurrence
// is in the past" fires immediately and throws away the season being watched right now.
console.log('=== 2. adopting a date clears nothing ===');
queueWatchedReset.clearSettlement('seasonal');
await seedWatchedState('seasonal');
const adopted = await watchedReset.applySeasonalReset('seasonal', { reset_watched_on: TODAY });
ok('2a. the first read does NOT reset', adopted === null, JSON.stringify(adopted));
const afterAdopt = await stateOf('seasonal');
ok('2b. the done flags survive adoption', afterAdopt.done.length === 1);
ok('2c. the ledger survives adoption', afterAdopt.history === 2);
ok('2d. adoption is recorded as such', afterAdopt.settlement?.reason === 'adopted',
  JSON.stringify(afterAdopt.settlement));

// ── 3. IT FIRES ON A REAL PLAY, BEFORE THE LINEUP ─────────────────────────────────────────
//
// The shipped `session.startSession()` runs. Nothing here calls the reset — the play does, on
// the same read that consumes `promote_window`, and there is no timer in the process.
console.log('=== 3. the read-time check fires inside a real play ===');
// Settle the queue through LAST year, so today's occurrence is genuinely owed. This is the
// state a seasonal queue is in on 1 November: adopted a year ago, reset a year ago.
const lastYear = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate(), 12);
queueWatchedReset.settle('seasonal', Math.floor(lastYear.getTime() / 1000), TODAY);
await seedWatchedState('seasonal');
// ALSO mark "Movie A (2001)" done. It is UNWATCHED in the corpus, so this flag is the only
// thing keeping it out of the lineup — and a movie is never revived by the stale-done rule.
// That makes the lineup itself the ORDERING evidence: the reset runs above the lineup build,
// so Movie A must come back and PLAY on this very scan. A reset placed below the build would
// clear the same three things and the queue would still play nothing tonight.
await queues.markDone('seasonal', ['title:Movie A (2001)'], Math.floor(Date.now() / 1000));
const played = await play('seasonal');
ok('the seasonal queue still plays', sessionOk(played), JSON.stringify(played));
const afterPlay = await stateOf('seasonal');
ok('3a. the play cleared the queue-owned ledger', afterPlay.history === 0, String(afterPlay.history));
ok('3b. the play cleared the lead cooldown', afterPlay.lastLed == null);
ok('3c. the settlement names the date that fired it', afterPlay.settlement?.reason === TODAY,
  JSON.stringify(afterPlay.settlement));
// THE ORDERING ASSERTION. The stubbed delivery layer records what it was handed, so this is
// the lineup the viewer would have got. Both arms are read because which one answers is an
// env choice (`PLAYBACK_FSM` routes through the driver), and the assertion is about the
// LINEUP, not about the transport. rk 2001 is "Movie A (2001)", which was `done` when this
// scan started.
// `SESSION_CTL` is a plain `.mjs` recorder, so its arrays are `never[]` to tsc. The shapes are
// the driver's and playback's own arguments, declared here rather than widened away.
type Delivery = { ratingKeys?: unknown[]; keys?: unknown[] };
const delivered: Delivery[] = [
  ...(SESSION_CTL.drives as Delivery[]),
  ...(SESSION_CTL.plays as Delivery[]),
];
const deliveredKeys = delivered.flatMap(
  (call) => [...(call.ratingKeys ?? []), ...(call.keys ?? [])].map(String),
);
ok('3d. the reset ran BEFORE the lineup — the cleared entry plays on this same scan',
  deliveredKeys.includes('2001'),
  JSON.stringify({ drives: SESSION_CTL.drives, plays: SESSION_CTL.plays }));
// The write side then re-marks "Movie C (2003)": the corpus's admin HAS finished it, which is
// the right answer for a provider-history queue and is not the flag the reset cleared.

// ── 4. IT FIRES ONCE ──────────────────────────────────────────────────────────────────────
console.log('=== 4. a second play the same evening resets nothing ===');
queueEntryHistory.markCompleted('seasonal', 'title:Movie A (2001)', 'leaf-3');
await promote.recordLead('seasonal', 'title:Movie A (2001)');
const settledBefore = queueWatchedReset.settlementFor('seasonal');
const again = await play('seasonal');
ok('the second play still plays', sessionOk(again), JSON.stringify(again));
const afterSecond = await stateOf('seasonal');
ok('4a. the second play did NOT clear the ledger again', afterSecond.history === 1,
  String(afterSecond.history));
ok('4b. the second play did NOT clear the lead cooldown again', afterSecond.lastLed != null);
ok('4c. the settlement did not move', afterSecond.settlement?.settledAt === settledBefore?.settledAt);

// ── 5. AN OFF QUEUE IS UNCHANGED ──────────────────────────────────────────────────────────
console.log('=== 5. a queue with no date behaves exactly as it does today ===');
await seedWatchedState('plain');
const plainBefore = await stateOf('plain');
const plainPlayed = await play('plain');
ok('the ordinary queue plays', sessionOk(plainPlayed), JSON.stringify(plainPlayed));
const plainAfter = await stateOf('plain');
ok('5a. its queue-owned ledger is untouched', plainAfter.history === plainBefore.history,
  `${plainBefore.history} -> ${plainAfter.history}`);
ok('5b. its lead cooldown is untouched', plainAfter.lastLed != null);
ok('5c. it never gains a settlement row', plainAfter.settlement === null,
  JSON.stringify(plainAfter.settlement));

// ── 6. NOTHING REACHES A PROVIDER ─────────────────────────────────────────────────────────
//
// The replay corpus is READ-ONLY by construction — `engine/plex-replay.ts` serves recorded GET
// responses and has no write path at all — so a reset that tried to move a Plex play count
// could not silently succeed. This asserts the other half: the reset module imports no
// provider, in either direction, which is what stops one being added later by accident.
console.log('=== 6. the reset never writes to a provider ===');
const resetSource = readFileSync(
  new URL('../server/src/watchedReset.ts', import.meta.url), 'utf8',
);
const providerImports = [...resetSource.matchAll(/^import[^\n]*from '([^']+)'/gm)]
  .map(([, spec]) => spec as string)
  .filter((spec) => /provider|plex|kavita|steam|mister/i.test(spec));
ok('6a. the reset imports no provider', providerImports.length === 0, providerImports.join(', '));
// And no timer, anywhere in the feature. This is the decision, not an omission: a setInterval
// that does not fire is invisible until somebody notices a repeat.
const timerSources = ['watchedReset.ts', 'seasonalReset.ts', 'store/db/queueWatchedReset.ts']
  .map((file) => readFileSync(new URL(`../server/src/${file}`, import.meta.url), 'utf8'));
ok('6b. no setInterval / setTimeout anywhere in the feature',
  !timerSources.some((text) => /\bset(Interval|Timeout)\s*\(/.test(text)));

console.log(FAILS.length ? `FAILURES: ${FAILS.length}` : 'seasonal reset OK');
process.exit(FAILS.length ? 1 : 0);

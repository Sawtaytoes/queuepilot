// The two LANES inside a Picks queue: a Priority queue that leads, and a Random pool that
// fills the rest (decision 2026-08-23-kind-is-picks-or-rules §2/§4, implemented 2026-08-26).
//
// The first two cases are the ones that matter most, and neither is about the new feature:
// they pin that a queue where NOBODY has promoted anything comes out of `nextQueue` in exactly
// the order it came out before the lanes existed. An ordered queue is `add_as: priority`, so
// every one of its entries is in the Priority lane by inheritance — if the lane split changed
// what that means, every Ordered Queue in the house would have changed behaviour silently.
//
// Hermetic: `container` is the whole client surface a movie entry touches.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EntryDescriptor, LeadGate } from '../server/src/engine/resolve.js';
import type { PlexClient } from '../server/src/types.js';

process.env.SETS_PATH = '/nonexistent-so-loadSets-is-never-consulted.yaml';
// `nextQueue` reaches no store — the lead gate is injected — but `leadWindow.ts` is imported
// through `resolve.ts`, and `promote.ts` (used by the last case) opens the book of record.
process.env.STORE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'qp-lane-')), 'queuepilot.sqlite');

const { describe: describeEntry, nextQueue } = await import('../server/src/engine/resolve.js');

// Four films, each its own entry. A movie is the simplest member there is: one item, no batch,
// no episode walk — so the ORDER under test is the lane logic and nothing else.
const FILMS = [
  { ratingKey: '1', title: 'Alpha' },
  { ratingKey: '2', title: 'Bravo' },
  { ratingKey: '3', title: 'Charlie' },
  { ratingKey: '4', title: 'Delta' },
];

// THREE SHOWS. `Echo` is the in-progress episode case it has always been; `Foxtrot` and
// `Golf` exist because every case about the lead WINDOW has to be written on a show now.
//
// A window is spent when an entry has DELIVERED what it owes, and only a show or a collection
// can deliver an episode count and still owe more. A movie owes exactly one thing — itself —
// so it never asks the gate at all, and the film cases below pin that
// (decision `2026-09-23-a-ranked-movie-leads-until-it-is-watched`). Before that rule the whole
// of this suite promoted FILMS, which is why so many assertions moved in one commit.
const SHOW = { ratingKey: '5', title: 'Echo' };
const SHOWS = [SHOW, { ratingKey: '6', title: 'Foxtrot' }, { ratingKey: '7', title: 'Golf' }];
/** viewOffset (ms) for `showResumeKey`'s first episode; 0 = not started. */
let showResumeMs = 0;
/** WHICH show `showResumeMs` belongs to. `Echo` unless a case says otherwise. */
let showResumeKey: string = SHOW.ratingKey;
/** The movie progress that Plex returns with its metadata. */
let movieResumeKey: string | null = null;

const clientWith = (): PlexClient => ({
  async container(p: string) {
    const m = /^\/library\/metadata\/(\d+)$/.exec(p);
    if (m) {
      const show = SHOWS.find((s) => s.ratingKey === m[1]);
      if (show) return { Metadata: [{ ...show, type: 'show' }] };
      const film = FILMS.find((f) => f.ratingKey === m[1]);
      if (!film) return { Metadata: [] };
      return {
        Metadata: [{
          ...film,
          type: 'movie',
          viewOffset: movieResumeKey === film.ratingKey ? 45_000 : 0,
          viewCount: 0,
        }],
      };
    }
    const leaves = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(p);
    const show = leaves ? SHOWS.find((s) => s.ratingKey === leaves[1]) : null;
    if (show) {
      return {
        Metadata: [
          {
            ratingKey: `${show.ratingKey}1`,
            title: `${show.title} E1`,
            grandparentTitle: show.title,
            parentIndex: 1,
            index: 1,
            type: 'episode',
            duration: 1_400_000,
            viewOffset: show.ratingKey === showResumeKey ? showResumeMs : 0,
            viewCount: 0,
          },
        ],
      };
    }
    throw new Error(`unexpected path ${p}`);
  },
} as unknown as PlexClient);

/** `describe()` on a raw entry mapping, which is the only shape queues.yaml holds. */
const entry = (rk: string, extras: Record<string, unknown> = {}): EntryDescriptor => {
  const title = (SHOWS.find((s) => s.ratingKey === rk)
    ?? FILMS.find((f) => f.ratingKey === rk))!.title;
  return describeEntry({ ratingKey: rk, title, ...extras });
};

// A seeded shuffle that REVERSES, so "shuffled" is visible and repeatable in an assertion.
const reversingRng = { shuffle: (a: unknown[]) => { a.reverse(); } };

let failed = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  try {
    assert.deepEqual(actual, expected);
    console.log(`PASS ${label} — ${JSON.stringify(actual)}`);
  } catch {
    console.log(`FAIL ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    failed += 1;
  }
};

const titles = (r: { play: { title?: string }[] }) => r.play.map((i) => i.title);

const ORDERED = { source: 'queue', kind: 'picks', add_as: 'priority', length: 12 };
const POOL = { source: 'queue', kind: 'picks', add_as: 'random', length: 12 };
const run = (
  cfg: Record<string, unknown>,
  entries: EntryDescriptor[],
  gate: LeadGate | null = null,
) => nextQueue(clientWith(), 'set1', cfg, entries, new Set(), null, reversingRng, gate);

// ── 1. An ORDERED queue is untouched ──────────────────────────────────────────────────────
// Every entry inherits `priority`, nothing is promoted, so file order IS the play order — and
// the rng must never reach it. This is the regression guard for `kevin_kids` and its siblings.
const all = [entry('1'), entry('2'), entry('3'), entry('4')];
check('ordered queue plays file order', titles(await run(ORDERED, all)), ['Alpha', 'Bravo', 'Charlie', 'Delta']);

// ── 2. A RANDOM pool is untouched ─────────────────────────────────────────────────────────
// Every entry inherits `random`, so all four go through the shuffle — here, the reverse.
check('random pool still shuffles', titles(await run(POOL, all)), ['Delta', 'Charlie', 'Bravo', 'Alpha']);

// A partly watched movie is the next sitting's head, even when the pool shuffle would put it
// last. This is the NFC rescan case: the card starts the same queue again after dinner.
movieResumeKey = '1';
const resumedMovie = await run(POOL, all);
check('an in-progress movie leads the random pool', titles(resumedMovie),
  ['Alpha', 'Delta', 'Charlie', 'Bravo']);
check('the in-progress movie keeps its Plex resume position', resumedMovie.offset, 45_000);
movieResumeKey = null;

// ── 3. A PROMOTE leads a random pool ──────────────────────────────────────────────────────
// Charlie names its own lane; the other three shuffle behind it.
const promoted = [entry('1'), entry('2'), entry('3', { placement: 'priority' }), entry('4')];
check('a promoted entry leads the pool', titles(await run(POOL, promoted)), ['Charlie', 'Delta', 'Bravo', 'Alpha']);

// ── 4. The lead WINDOW holds it back on the second sitting ────────────────────────────────
// A promoted SHOW defaults to `lead: once`. With the gate saying "already led", Foxtrot stops
// leading and falls back into the pool — it does not vanish from the queue.
//
// The entry here is a show, not a film. A promoted film is `lead: always` and never reaches
// the gate, so writing this case on one would assert nothing at all.
const spent: LeadGate = async () => false;
const promotedShow = [entry('1'), entry('2'), entry('6', { placement: 'priority' }), entry('4')];
check(
  'a spent lead window demotes it to the pool for this sitting',
  titles(await run(POOL, promotedShow, spent)),
  ['Delta', 'Foxtrot E1', 'Bravo', 'Alpha'],
);
const fresh = await run(POOL, promotedShow, async () => true);
check('a fresh window reports the entry that led', fresh.led, ['rk:6']);
check(
  'a spent window reports it as suppressed',
  (await run(POOL, promotedShow, spent)).suppressed,
  ['rk:6'],
);

// ── 4b. A RANKED MOVIE NEVER ASKS THE GATE ────────────────────────────────────────────────
// The bug of 2026-09-23. Rank 1 was dispatched, the Plex client stopped working before Plex
// wrote any `viewOffset`, and the rescan seven minutes later found a spent window and no
// progress — so it demoted the film to the pool and played a half-watched pool title instead.
// The film sat at Rank 1 on screen the whole time.
//
// A film cannot deliver half of itself and still owe the rest: it leaves the lane by being
// WATCHED, which is case 7's empty resolution, not by a clock. So the gate can only ever take
// a rank away from a film nobody watched
// (decision `2026-09-23-a-ranked-movie-leads-until-it-is-watched`).
check(
  'a spent window does NOT demote a ranked movie',
  titles(await run(POOL, promoted, spent)),
  ['Charlie', 'Delta', 'Bravo', 'Alpha'],
);
check('a ranked movie is never reported as suppressed', (await run(POOL, promoted, spent)).suppressed, []);
check('and it spends nothing, so there is no window to restart', (await run(POOL, promoted, async () => true)).led, []);
// The gate is not merely IGNORED for a film — it is never asked, so no window is computed for
// one. Case 9 pins the same `asked` ledger from the other side, on a show.
const filmGateCalls: string[] = [];
await run(POOL, promoted, async (key) => { filmGateCalls.push(key); return true; });
check('the lead gate is not consulted for a ranked movie at all', filmGateCalls, []);

// An explicit `lead: once` on the entry still outranks the default, for a film as for anything
// else. The movie rule changes what a SPARSE `lead:` means, and nothing else — the panel's
// control stays a real instruction.
const filmToldOnce = [entry('1'), entry('2'), entry('3', { placement: 'priority', lead: 'once' }), entry('4')];
check(
  'an explicit lead:once on a film is still honoured',
  titles(await run(POOL, filmToldOnce, spent)),
  ['Delta', 'Charlie', 'Bravo', 'Alpha'],
);
check(
  'and that film reports as suppressed like any other spent entry',
  (await run(POOL, filmToldOnce, spent)).suppressed,
  ['rk:3'],
);

// ── 5. An ORDERED queue's head is NEVER suppressed ────────────────────────────────────────
// Its entries are priority by INHERITANCE, so they default to `lead: always` and never ask the
// gate. Read the ADR's table literally (sparse -> `once`) and this case reverses the queue's
// first two entries every night, which is the bug this default exists to avoid.
check(
  'an ordered queue ignores the lead window entirely',
  titles(await run(ORDERED, all, spent)),
  ['Alpha', 'Bravo', 'Charlie', 'Delta'],
);
check('and nothing in it is reported as suppressed', (await run(ORDERED, all, spent)).suppressed, []);

// ── 6. A promote outranks an in-progress resume ───────────────────────────────
// Reversed on 2026-09-11 (decision
// `2026-09-11-priority-leads-a-sitting-ahead-of-an-in-progress-resume`). ADR §4.4 used to put
// the half-watched show first; the owner's rule is that Priority means first in line. Echo E1
// is 20 minutes in and still yields to promoted Charlie — and it keeps its place AHEAD of the
// shuffled rest, which is the half of the old rule that survives.
const withShow = [entry('1'), entry('3', { placement: 'priority' }), entry('5')];
showResumeMs = 0;
check(
  'with nothing half-watched, the promote leads',
  titles(await run(POOL, withShow)),
  ['Charlie', 'Echo E1', 'Alpha'],
);
showResumeMs = 1_200_000;
const promoteAheadOfResume = await run(POOL, withShow);
check(
  'a promote leads a half-watched pool member',
  titles(promoteAheadOfResume),
  ['Charlie', 'Echo E1', 'Alpha'],
);
check(
  'a ranked FILM taking the head spends nothing',
  promoteAheadOfResume.led,
  [],
);
// The same sitting with a ranked SHOW at the head: that one does spend, because a show can
// deliver its episode count tonight and still owe the next one tomorrow.
const showAheadOfResume = await run(POOL, [entry('1'), entry('6', { placement: 'priority' }), entry('5')]);
check(
  'a ranked SHOW taking the head spends its lead window',
  showAheadOfResume.led,
  ['rk:6'],
);
// The hoist still works inside the pool: with nothing promoted, the half-watched show leads
// the shuffle instead of landing where the rng put it.
check(
  'with no promote, the half-watched member still leads the pool',
  titles(await run(POOL, [entry('1'), entry('3'), entry('5')])),
  ['Echo E1', 'Charlie', 'Alpha'],
);
showResumeMs = 0;

// ── 6b. A half-watched Priority entry keeps its RANK ──────────────────────────────────────
// THE DINNER CASE. Rank 1 leads at 18:00 and spends its 16h window. The owner stops part way
// through, eats, and scans the card again at 20:00. The window must not demote him to Rank 2:
// an entry somebody is in the middle of has not had its turn yet
// (decision `2026-09-11-a-half-watched-priority-entry-keeps-its-rank`).
//
// This bites hardest on a `length: 1` movie queue — the household shape. Only the head ever
// contributes, so Rank 2's window is always fresh, and before the fix Rank 2 led every rescan.
// Written on SHOWS since 2026-09-23: two ranked films would both be `lead: always` and would
// never reach the gate this case exists to test.
const twoPromotes = [
  entry('6', { placement: 'priority' }),
  entry('7', { placement: 'priority' }),
  entry('3'),
];
showResumeKey = '6';
showResumeMs = 1_200_000;
const rank1Spent: LeadGate = async (key) => key !== 'rk:6';
const afterDinner = await run(POOL, twoPromotes, rank1Spent);
check(
  'a half-watched promote keeps the head when its OWN window is spent',
  titles(afterDinner),
  ['Foxtrot E1', 'Golf E1', 'Charlie'],
);
check('an unfulfilled promise is not reported as suppressed', afterDinner.suppressed, []);
check('and it is not re-charged — only the fresh promote behind it is', afterDinner.led, ['rk:7']);
// Both windows spent: Rank 1 still leads on its resume, and Rank 2 falls to the pool as before.
const bothSpent = await run(POOL, twoPromotes, async () => false);
check(
  'with every window spent, the half-watched promote still leads',
  titles(bothSpent),
  ['Foxtrot E1', 'Charlie', 'Golf E1'],
);
check('the promote nobody started is still suppressed', bothSpent.suppressed, ['rk:7']);
showResumeMs = 0;
showResumeKey = SHOW.ratingKey;

// ── 6c. THE SAME DINNER CASE ON FILMS, which is now the stronger rule ─────────────────────
// Rank 1 and Rank 2 are both films. Neither asks the gate, so Rank 1 holds the head whether
// Plex has recorded a resume position for it or not — and the "or not" is the whole of the
// 2026-09-23 fix, because on the night that prompted it Plex had recorded nothing.
const twoFilms = [
  entry('1', { placement: 'priority' }),
  entry('2', { placement: 'priority' }),
  entry('3'),
];
movieResumeKey = '1';
check(
  'a half-watched ranked film keeps the head with every window spent',
  titles(await run(POOL, twoFilms, async () => false)),
  ['Alpha', 'Bravo', 'Charlie'],
);
movieResumeKey = null;
const filmsNoProgress = await run(POOL, twoFilms, async () => false);
check(
  'a ranked film with NO progress at all still keeps the head',
  titles(filmsNoProgress),
  ['Alpha', 'Bravo', 'Charlie'],
);
check('and neither ranked film is suppressed', filmsNoProgress.suppressed, []);

// Passing the gate is not itself a contribution. A short sitting can fill before a later
// Priority entry reaches the handed-off lineup, and that unplayed entry keeps its promise.
const cappedPromotes = await run(
  { ...POOL, length: 1 },
  [entry('6', { placement: 'priority' }), entry('7', { placement: 'priority' }), entry('4')],
  async () => true,
);
check('the playback cap keeps only the first promoted contribution', titles(cappedPromotes), ['Foxtrot E1']);
check('an eligible promote beyond the playback cap keeps its window', cappedPromotes.led, ['rk:6']);

// ── 7. A lineup that plays nothing spends no window ───────────────────────────────────────
const watchedAll = await nextQueue(
  clientWith(), 'set1', POOL, promoted, new Set(['1', '2', '3', '4']), null, reversingRng, null,
);
check('nothing playable means nothing led', watchedAll.led, []);

// ── 8. The window is stamped by the CALLER, not by the resolve ────────────────────────────
// `nextQueue` reporting `led` must not itself write to the ledger — session.ts stamps it after
// the handoff, so a sitting that never plays keeps its promise
// (decision 2026-08-26-the-lead-window-is-stamped-when-playback-starts).
const promote = await import('../server/src/promote.js');
check('resolving a lineup does not consume the window', await promote.canLeadOnce('set1', 'rk:6'), true);

// ── 9. The QUEUE names the window, and the ENTRY outranks it ──────────────────────────────
// `leadWindowMs` is entry > set > 16h product default. The set level is the one that had no
// UI and no test: the window is a rolling timer, so a queue watched past midnight stamps
// its lead AFTER midnight and blocks the following night's scan — which is what happened on
// 2026-08-26 (decision 2026-08-26-the-promote-window-is-a-queue-setting), and is why the
// product default is 16h and not a flat day. The assertion is on the milliseconds handed to
// the gate, because that is the only place the precedence is observable from outside.
//
// ⚠️ This whole block hands `run()` a cfg DIRECTLY. That is what let the loader drop the
// set's `promote_window` for two weeks with every assertion here still green — the gate that
// pins the loader half is `e2e/set-passthrough-parity.ts`.
const asked: number[] = [];
const recordingGate: LeadGate = async (_k, ms) => { asked.push(ms); return true; };

asked.length = 0;
await run(POOL, promotedShow, recordingGate);
check('with no window anywhere, the gate is asked for the 16h default', asked, [57_600_000]);

asked.length = 0;
await run({ ...POOL, promote_window: '20h' }, promotedShow, recordingGate);
check('the QUEUE window reaches the gate', asked, [72_000_000]);

asked.length = 0;
await run(
  { ...POOL, promote_window: '20h' },
  [entry('1'), entry('2'), entry('6', { placement: 'priority', promote_window: '7d' }), entry('4')],
  recordingGate,
);
check('an ENTRY window outranks the queue', asked, [604_800_000]);

// `never`/`0` is how a queue says "no cooldown". `parsePromoteWindow` returns null for it,
// which falls through to the default rather than meaning zero — so the OFF spelling has to be
// cleared at write time (sets.ts drops the key), and this pins that reading it back is the
// default and not an accidental 0ms free pass.
asked.length = 0;
await run({ ...POOL, promote_window: 'never' }, promotedShow, recordingGate);
check('an unparseable queue window falls back to the default', asked, [57_600_000]);

console.log(failed ? `\n${failed} FAILURE(S)` : '\nALL PASS');
process.exit(failed ? 1 : 0);

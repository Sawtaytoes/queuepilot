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

// One SHOW, for the in-progress case. It has to be a show and not a fifth film: a movie's
// resolved item carries no `viewOffset` (the movie branch of `resolveMember` builds the item by
// hand from title + ratingKey), so `leadsInProgress` has only ever been able to see an EPISODE.
// That is pre-existing, and out of scope here — the point of this case is that the hoist still
// outranks the Priority lane, not to widen what the hoist can see.
const SHOW = { ratingKey: '5', title: 'Echo' };
/** viewOffset (ms) for `SHOW`'s first episode; 0 = not started. */
let showResumeMs = 0;

const clientWith = (): PlexClient => ({
  async container(p: string) {
    const m = /^\/library\/metadata\/(\d+)$/.exec(p);
    if (m) {
      if (m[1] === SHOW.ratingKey) return { Metadata: [{ ...SHOW, type: 'show' }] };
      const film = FILMS.find((f) => f.ratingKey === m[1]);
      if (!film) return { Metadata: [] };
      return { Metadata: [{ ...film, type: 'movie' }] };
    }
    if (p === `/library/metadata/${SHOW.ratingKey}/allLeaves`) {
      return {
        Metadata: [
          {
            ratingKey: '51',
            title: 'Echo E1',
            grandparentTitle: SHOW.title,
            parentIndex: 1,
            index: 1,
            type: 'episode',
            duration: 1_400_000,
            viewOffset: showResumeMs,
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
  const title = rk === SHOW.ratingKey ? SHOW.title : FILMS.find((f) => f.ratingKey === rk)!.title;
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

// ── 3. A PROMOTE leads a random pool ──────────────────────────────────────────────────────
// Charlie names its own lane; the other three shuffle behind it.
const promoted = [entry('1'), entry('2'), entry('3', { placement: 'priority' }), entry('4')];
check('a promoted entry leads the pool', titles(await run(POOL, promoted)), ['Charlie', 'Delta', 'Bravo', 'Alpha']);

// ── 4. The lead WINDOW holds it back on the second sitting ────────────────────────────────
// A promoted entry defaults to `lead: once`. With the gate saying "already led", Charlie stops
// leading and falls back into the pool — it does not vanish from the queue.
const spent: LeadGate = async () => false;
check(
  'a spent lead window demotes it to the pool for this sitting',
  titles(await run(POOL, promoted, spent)),
  ['Delta', 'Charlie', 'Bravo', 'Alpha'],
);
const fresh = await run(POOL, promoted, async () => true);
check('a fresh window reports the entry that led', fresh.led, ['rk:3']);
check('a spent window reports it as suppressed', (await run(POOL, promoted, spent)).suppressed, ['rk:3']);

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

// ── 6. In-progress outranks a promote ─────────────────────────────────────────────────────
// ADR §4.4: a promote must not steal the screen from something half-watched. Echo E1 is 20
// minutes in, so it resumes ahead of promoted Charlie.
const withShow = [entry('1'), entry('3', { placement: 'priority' }), entry('5')];
showResumeMs = 0;
check(
  'with nothing half-watched, the promote leads',
  titles(await run(POOL, withShow)),
  ['Charlie', 'Echo E1', 'Alpha'],
);
showResumeMs = 1_200_000;
check(
  'a half-watched pool member still leads a promote',
  titles(await run(POOL, withShow)),
  ['Echo E1', 'Charlie', 'Alpha'],
);
showResumeMs = 0;

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
check('resolving a lineup does not consume the window', await promote.canLeadOnce('set1', 'rk:3'), true);

// ── 9. The QUEUE names the window, and the ENTRY outranks it ──────────────────────────────
// `leadWindowMs` is entry > set > 24h product default. The set level is the one that had no
// UI and no test: a 24h window is a rolling timer, so a queue watched past midnight stamps
// its lead AFTER midnight and blocks the following night's scan — which is what happened on
// 2026-08-26 (decision 2026-08-26-the-promote-window-is-a-queue-setting). The assertion is on
// the milliseconds handed to the gate, because that is the only place the precedence is
// observable from outside.
const asked: number[] = [];
const recordingGate: LeadGate = async (_k, ms) => { asked.push(ms); return true; };

asked.length = 0;
await run(POOL, promoted, recordingGate);
check('with no window anywhere, the gate is asked for the 24h default', asked, [86_400_000]);

asked.length = 0;
await run({ ...POOL, promote_window: '20h' }, promoted, recordingGate);
check('the QUEUE window reaches the gate', asked, [72_000_000]);

asked.length = 0;
await run(
  { ...POOL, promote_window: '20h' },
  [entry('1'), entry('2'), entry('3', { placement: 'priority', promote_window: '7d' }), entry('4')],
  recordingGate,
);
check('an ENTRY window outranks the queue', asked, [604_800_000]);

// `never`/`0` is how a queue says "no cooldown". `parsePromoteWindow` returns null for it,
// which falls through to the default rather than meaning zero — so the OFF spelling has to be
// cleared at write time (sets.ts drops the key), and this pins that reading it back is the
// default and not an accidental 0ms free pass.
asked.length = 0;
await run({ ...POOL, promote_window: 'never' }, promoted, recordingGate);
check('an unparseable queue window falls back to the default', asked, [86_400_000]);

console.log(failed ? `\n${failed} FAILURE(S)` : '\nALL PASS');
process.exit(failed ? 1 : 0);

// THE SEASON WINDOW, at all six places that gate on `enabled`.
//
// The decision record's whole shape is "reuse the six call sites rather than adding a parallel
// notion of hidden" (`2026-09-08-a-season-window-gates-the-existing-enabled-flag`), so a gate
// that proved the window at ONE of them would be proving the least interesting half. The six,
// each driven through its real entry point:
//
//   1. `tonight/pick.ts   candidatesFor`   — What to Watch/Play
//   2. `session.ts        startSession`    — a card tap / the Go button
//   3. `providers/launcher.ts launchDescriptor` — `/go/<id>`
//   4. `topup.ts          topupPullLists`  — the reading-list sweep
//   5. `pending.ts        pendingItems`    — is this arrival already covered
//   6. `finished.ts       reconcileQueue`  — the post-playback write side
//
// ⚠️ **THE FIXTURE'S DATES ARE COMPUTED FROM TODAY, and that is deliberate.** The six call
// sites read the clock through `season.isSetAvailable(cfg)` with no injected `now`, because
// the decision says availability is computed ON THE READ and adding a `now` parameter to six
// production signatures to satisfy a test would be the test designing the code. So the fixture
// moves instead: one window that contains today, one that does not, and one set with no window
// at all. The arithmetic is checked below, including the case where a window crosses the new
// year.
//
// Run:  server/node_modules/.bin/tsx e2e/season-window-test.ts   (repo root; non-zero on failure)
process.env.PLAYBACK_FSM = 'false';
process.env.RESUME_ON_ADVANCE = 'false';
process.env.ADB_ENABLED = 'false';
// ⚠️ BLANKED, not merely unset. `session.js` and `finished.js` both import `mqttc`, which
// connects on import when `MQTT_HOST` is set — and a workspace shell that has sourced the
// household `.env` has it set, so this gate connected to the LIVE broker and then hung forever
// on an open socket. Same class of environment leak as `PLEX_TOKEN=` in `lane-drag-test.ts`.
process.env.MQTT_HOST = '';

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';

import { stubSessionDeps, useFixtures } from './stubs/session-harness.mjs';
import { errMessage } from '../server/src/errors.js';
import type { PlexClient, PlexMetadata } from '../server/src/types.js';

const FAILS: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}  -- ${errMessage(e)}`);
    FAILS.push(name);
  }
}

// ── The fixture's calendar ────────────────────────────────────────────────────────────────
//
// `MM-DD` for a day `days` away from today, in the SERVER's local time — which is what
// `season.ts` reads, because a season is a household calendar fact rather than a UTC one.
function dayFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);

  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A window that CONTAINS today, whichever day of the year this runs on. */
const OPEN = { end: dayFromToday(20), start: dayFromToday(-20) };
/**
 * A window that does NOT contain today.
 *
 * Forty to eighty days out. It is out of season on every day of the year, INCLUDING the days
 * when the span crosses 31 December and the pair reads as a wrapping window: run it on 5
 * November and the window is `12-15` → `01-24`, which covers mid-December to late January and
 * still does not cover today. Checked below rather than argued.
 */
const CLOSED = { end: dayFromToday(80), start: dayFromToday(40) };

const { dir } = useFixtures({
  queues: [
    'season_open:',
    '- {ratingKey: "2001", title: In Season}',
    'season_closed:',
    '- {ratingKey: "2001", title: Out Of Season}',
    'season_none:',
    '- {ratingKey: "2001", title: All Year}',
    'season_disabled:',
    '- {ratingKey: "2001", title: Switched Off}',
    '',
  ].join('\n'),
  sets: `sets:
# IN season. Every assertion below has one of these as its positive control, because "the
# window hid it" and "the code path was broken anyway" look identical from a single negative.
- id: season_open
  label: In Season
  kind: picks
  source: queue
  sections: [1]
  season_start: "${OPEN.start}"
  season_end: "${OPEN.end}"
# OUT of season, and otherwise byte-for-byte the same queue.
- id: season_closed
  label: Out Of Season
  kind: picks
  source: queue
  sections: [1]
  season_start: "${CLOSED.start}"
  season_end: "${CLOSED.end}"
# No window at all — the reading every existing set has, and the one that must not change.
- id: season_none
  label: All Year
  kind: picks
  source: queue
  sections: [1]
# The OTHER gate, on its own: switched off by hand while IN season. It proves the two gates
# stay independent, and that the window never learned to write the flag.
- id: season_disabled
  label: Switched Off
  kind: picks
  source: queue
  sections: [1]
  enabled: false
  season_start: "${OPEN.start}"
  season_end: "${OPEN.end}"
# Three rule pools over three different libraries, so Pending can ask about one arrival per
# season state without the pools covering each other's items.
- id: pool_open
  label: In Season Pool
  kind: cartoons
  source: rotation
  behavior: progress
  sections: [5]
  season_start: "${OPEN.start}"
  season_end: "${OPEN.end}"
  profiles:
  - plex_user: Ada
    account_id: 11111111
- id: pool_closed
  label: Out Of Season Pool
  kind: cartoons
  source: rotation
  behavior: progress
  sections: [6]
  season_start: "${CLOSED.start}"
  season_end: "${CLOSED.end}"
  profiles:
  - plex_user: Ada
    account_id: 11111111
- id: pool_none
  label: All Year Pool
  kind: cartoons
  source: rotation
  behavior: progress
  sections: [7]
  profiles:
  - plex_user: Ada
    account_id: 11111111
`,
});

process.env.PENDING_PATH = path.join(dir, 'pending.yaml');
writeFileSync(process.env.PENDING_PATH, 'seen_through: 0\ndismissed: []\n');

// ── The `finished.ts` provider stub ───────────────────────────────────────────────────────
//
// `reconcileQueue` answers `{reconciled: false}` both when the gate stops it and when the
// provider work below fails, so the RETURN VALUE cannot tell the two apart. What can is
// whether it reached `providerFor` at all, so that one import is stubbed and records its
// calls. Registered before `finished.js` is imported, the way `stubSessionDeps` is.
const providerCalls: string[] = [];
const FINISHED_PROVIDER_STUB = `data:text/javascript,${encodeURIComponent(`
  import { RECONCILE_CTL } from '${new URL('./season-window-ctl.mjs', import.meta.url).href}';
  export function providerFor(id) {
    RECONCILE_CTL.providerCalls.push(String(id));
    // Throwing is the point: the gate is what this asserts, and everything past it is
    // somebody else's test. The throw lands in reconcileQueue's own catch.
    throw new Error('stubbed provider — the gate let this through');
  }
`)}`;
registerHooks({
  resolve(spec, ctx, next) {
    if (
      spec === './providers/index.js'
      && String(ctx?.parentURL ?? '').includes('/server/src/finished')
    ) {
      return { shortCircuit: true, url: FINISHED_PROVIDER_STUB };
    }

    return next(spec, ctx);
  },
});
/**
 * The shared control surface, typed.
 *
 * `season-window-ctl.mjs` stays hand-written JavaScript for the reason
 * `stubs/session-harness.mjs` does — it has to be a real file the data-URL stub can import by
 * URL — so under `checkJs: false` its `providerCalls` is INFERRED as `never[]` from an empty
 * array literal. This declares the shape it carries at runtime; it is a view of the same
 * object, not a copy.
 */
const { RECONCILE_CTL } = await import('./season-window-ctl.mjs') as unknown as {
  RECONCILE_CTL: { providerCalls: string[] };
};
RECONCILE_CTL.providerCalls = providerCalls;

stubSessionDeps();

const season = await import('../server/src/season.js');
const sets = await import('../server/src/sets.js');
const routing = await import('../server/src/engine/routing.js');
const launcher = await import('../server/src/providers/launcher.js');
const topup = await import('../server/src/topup.js');
const pending = await import('../server/src/pending.js');
const finished = await import('../server/src/finished.js');
const session = await import('../server/src/session.js');
const { candidatesFor } = await import('../server/src/tonight/pick.js');
import type { CandidateSet } from '../server/src/tonight/pick.js';
import type { SessionStateExtra } from '../server/src/session.js';
import type { TopupDeps } from '../server/src/topup.js';

// ── 0. The fixture is the fixture it claims to be ────────────────────────────────────────
await check('the fixture window that should be open IS open, today', () => {
  assert.equal(season.isInSeason({ season_end: OPEN.end, season_start: OPEN.start }), true);
});
await check('the fixture window that should be closed IS closed, today', () => {
  // Including on the ~40 days of the year when this pair crosses 31 December and reads as a
  // WRAPPING window. If this ever fails, the arithmetic above is wrong and every negative
  // below is passing for the wrong reason.
  assert.equal(season.isInSeason({ season_end: CLOSED.end, season_start: CLOSED.start }), false);
});
await check('the loader carries the pair onto the engine cfg', () => {
  const reg = routing.loadSets();
  assert.equal(reg?.sets.season_open?.season_start, OPEN.start);
  assert.equal(reg?.sets.season_open?.season_end, OPEN.end);
  // The passthrough failure this class of bug always takes: absent reads as `undefined`, and
  // `undefined` means "no window", so a dropped field offers every seasonal queue all year.
  assert.equal(reg?.sets.season_closed?.season_start, CLOSED.start);
});

// ── 1. tonight/pick.ts — What to Watch/Play ──────────────────────────────────────────────
await check('1. Tonight offers the in-season queue and not the out-of-season one', async () => {
  const registry = await sets.getRegistry();
  const offered = candidatesFor({
    membershipFor: () => null,
    membersByQueue: new Map(),
    personIds: [],
    providerIdFor: () => 'plex',
    sets: registry.sets as unknown as CandidateSet[],
    tile: 'shows',
  }).map((one) => one.setId);

  assert.ok(offered.includes('season_open'), `open queue missing: ${offered.join(', ')}`);
  assert.ok(offered.includes('season_none'), `all-year queue missing: ${offered.join(', ')}`);
  assert.ok(!offered.includes('season_closed'), 'an out-of-season queue was offered');
  assert.ok(!offered.includes('season_disabled'), 'a disabled queue was offered');
});

await check('1b. the registry reports the window and the answer, computed on the read', async () => {
  const registry = await sets.getRegistry();
  const open = registry.sets.find((s) => s.id === 'season_open');
  const closed = registry.sets.find((s) => s.id === 'season_closed');
  const none = registry.sets.find((s) => s.id === 'season_none');
  const off = registry.sets.find((s) => s.id === 'season_disabled');

  assert.equal(open?.season_start, OPEN.start);
  assert.equal(open?.is_in_season, true);
  assert.equal(closed?.is_in_season, false);
  assert.equal(none?.season_start, null);
  assert.equal(none?.is_in_season, true);
  // ⭐ THE RULE THE WHOLE RECORD IS ABOUT. The closed queue is still `enabled: true` on disk
  // and reports so; the window did not write the flag, and a later read cannot tell the
  // difference between "out of season" and "switched off" unless both are reported.
  assert.equal(closed?.enabled, true, 'the season window WROTE the enabled flag');
  assert.equal(off?.enabled, false);
  assert.equal(off?.is_in_season, true, 'a disabled queue is not thereby out of season');
});

// ── 2. session.ts — a card tap ───────────────────────────────────────────────────────────
const STATES: SessionStateExtra[] = [];
session.setPublishers({ lastPlayed: () => {}, state: (p) => STATES.push(p || {}) });
const lastError = (): string => String([...STATES].reverse().find((s) => s.error)?.error ?? '');
/** `SessionResult` is a union and its `{cancelled: true}` arm carries no `error`. Nothing here
 *  cancels, so this reads the field without claiming the arm. */
const errorOf = (res: unknown): string => String((res as { error?: unknown }).error ?? '');

await check('2. session start refuses an out-of-season queue, and says when it returns', async () => {
  STATES.length = 0;
  const res = await session.startSession({ set: 'season_closed' });
  assert.equal(errorOf(res), 'out of season');
  assert.match(lastError(), /out of season/);
  // The date, in words. This message is the ONLY evidence a card that stopped working leaves.
  assert.match(lastError(), /returns \d{1,2} [A-Z][a-z]{2}/);
});

await check('2b. session start still says "not enabled" for the manual switch', async () => {
  STATES.length = 0;
  const res = await session.startSession({ set: 'season_disabled' });
  assert.equal(errorOf(res), 'disabled');
  assert.match(lastError(), /not enabled/);
  assert.doesNotMatch(lastError(), /out of season/);
});

await check('2c. session start lets an in-season queue through the gate', async () => {
  STATES.length = 0;
  const res = await session.startSession({ set: 'season_open' });
  assert.notEqual(errorOf(res), 'out of season');
  assert.notEqual(errorOf(res), 'disabled');
});

// ── 3. providers/launcher.ts — /go/<id> ──────────────────────────────────────────────────
await check('3. the launcher answers 409 for an out-of-season queue', async () => {
  const res = await launcher.launchDescriptor('season_closed');
  assert.equal(res.status, 409);
  assert.match(String(res.error), /out of season/);
  assert.match(String(res.error), /returns \d{1,2} [A-Z][a-z]{2}/);
});

await check('3b. the launcher still says "not enabled" for the manual switch', async () => {
  const res = await launcher.launchDescriptor('season_disabled');
  assert.equal(res.status, 409);
  assert.match(String(res.error), /is not enabled/);
});

await check('3c. the launcher lets an in-season queue past the gate', async () => {
  const res = await launcher.launchDescriptor('season_open');
  assert.doesNotMatch(String(res.error ?? ''), /out of season|not enabled/);
});

// ── 4. topup.ts — the pull-list sweep ────────────────────────────────────────────────────
await check('4. the sweep skips an out-of-season queue and keeps the rest', async () => {
  const deps = {
    extendPlayQueue: async () => ({ ok: true }),
    providerFor: () => ({
      topupList: async () => ({ added: 0, ok: true, reason: 'stub' }),
    }),
    readPlayQueue: async () => null,
  } as unknown as TopupDeps;
  const swept = (await topup.topupPullLists({ deps })).map((r) => r.set);

  assert.ok(swept.includes('season_open'), `open queue not swept: ${swept.join(', ')}`);
  assert.ok(swept.includes('season_none'), `all-year queue not swept: ${swept.join(', ')}`);
  assert.ok(!swept.includes('season_closed'), 'an out-of-season list was topped up');
  assert.ok(!swept.includes('season_disabled'), 'a disabled list was topped up');
  // ⚠️ Skipping the top-up is ALL that happens. A season boundary clears nothing and removes
  // nothing — the reading list is simply left where it is until the season opens again.
  assert.ok(!swept.includes('pool_closed'), 'an out-of-season pool was topped up');
});

// ── 5. pending.ts — is this arrival already covered ──────────────────────────────────────
const NOW_S = Math.floor(Date.now() / 1000);
const ARRIVALS: Record<number, PlexMetadata[]> = {
  5: [{ addedAt: NOW_S, contentRating: 'TV-Y', ratingKey: '5001', title: 'Covered In Season', type: 'show' }],
  6: [{ addedAt: NOW_S, contentRating: 'TV-Y', ratingKey: '6001', title: 'Pool Is Shut', type: 'show' }],
  7: [{ addedAt: NOW_S, contentRating: 'TV-Y', ratingKey: '7001', title: 'Covered All Year', type: 'show' }],
};
const fakePlex = {
  async accountToken() { return null; },
  async container() { return { Metadata: [] }; },
} as unknown as PlexClient;

await check('5. Pending counts an in-season pool as cover and an out-of-season one as none', async () => {
  const { items } = await pending.pendingItems(
    fakePlex,
    [
      { id: 5, title: 'In Season Lib', type: 'show', video: true },
      { id: 6, title: 'Out Of Season Lib', type: 'show', video: true },
      { id: 7, title: 'All Year Lib', type: 'show', video: true },
    ],
    async (sectionId, type) => (type === 2 ? (ARRIVALS[sectionId] ?? []) : []),
  );
  const keys = items.map((i) => i.ratingKey);

  assert.ok(!keys.includes('5001'), 'an in-season pool stopped covering its own arrival');
  assert.ok(!keys.includes('7001'), 'an all-year pool stopped covering its own arrival');
  // The point: an out-of-season pool is not going to play this, so it is NEWS. Counting it as
  // cover would hide the arrival behind a queue nobody can reach until the season opens.
  assert.ok(keys.includes('6001'), `an out-of-season pool was counted as cover: ${keys.join(', ')}`);
});

// ── 6. finished.ts — the post-playback write side ────────────────────────────────────────
await check('6. reconcile stops at the gate for an out-of-season queue', async () => {
  providerCalls.length = 0;
  const res = await finished.reconcileQueue('season_closed');

  assert.equal(res.reconciled, false);
  // The discriminator: it never reached the provider. ⚠️ Reaching it is what would MARK
  // entries done, and a season boundary marks nothing.
  assert.equal(providerCalls.length, 0, `reconcile ran anyway: ${providerCalls.join(', ')}`);
});

await check('6b. reconcile still runs for an in-season queue', async () => {
  providerCalls.length = 0;
  await finished.reconcileQueue('season_open');

  assert.equal(providerCalls.length, 1, 'the gate blocked an IN-season queue');
});

await check('6c. reconcile stops at the gate for a queue switched off by hand', async () => {
  providerCalls.length = 0;
  const res = await finished.reconcileQueue('season_disabled');

  assert.equal(res.reconciled, false);
  assert.equal(providerCalls.length, 0);
});

// ── 7. Nothing was written ───────────────────────────────────────────────────────────────
await check('7. a season boundary wrote NOTHING back to the registry', async () => {
  // The last line of the record, and the cheapest thing to get wrong: the window is display
  // and availability only. Six reads have now happened over a closed season, and the set on
  // disk must be exactly what the fixture wrote.
  const registry = await sets.getRegistry();
  const closed = registry.sets.find((s) => s.id === 'season_closed');

  assert.equal(closed?.enabled, true);
  assert.equal(closed?.season_start, CLOSED.start);
  assert.equal(closed?.season_end, CLOSED.end);
});

console.log();
if (FAILS.length) {
  console.log(`${FAILS.length} FAILED: ${FAILS.join(', ')}`);
  process.exit(1);
}
console.log('all season-window checks passed');
// EXPLICIT, unlike most gates here: six production modules were imported and between them they
// hold an MQTT client and an open SQLite handle, so the event loop does not drain on its own.
// A gate that passes and then hangs reads as a broken gate in CI.
process.exit(0);

// Top-up: keeping a `refill: true` lineup filled instead of letting it end.
//
// Two halves, both browserless and hermetic (a fake provider + a fake playback module — no
// Plex, no broker):
//
//   1. WHEN a tick tops up. Every guard is a no-op-with-a-reason, and each one is a way this
//      feature can misbehave in someone's living room: topping up a channel that was supposed
//      to end, topping up on every tick until the queue is enormous, or re-adding a short the
//      kids watched ten minutes ago.
//   2. WHAT it appends. The lineup builder answers "what should this channel play", NOT "what
//      is queued" — so the de-dupe against the live queue is topup.ts's job, and if it stops
//      working the symptom is repeats rather than an error.
//
// The de-dupe case is the one worth spelling out: the fake provider always returns the SAME
// five items (a real rotation shuffles, but a shuffle would make this test flaky for no gain),
// so a topup that failed to subtract the live queue would append duplicates of what is already
// playing. That is exactly the living-room symptom, and it is silent.
//
// Run: server/node_modules/.bin/tsx e2e/topup-test.ts
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SETS_PATH = path.join(REPO, 'e2e', 'fixtures', 'topup.sets.yaml');
process.env.QUEUES_PATH = '/nonexistent-so-loadEntries-is-never-consulted.yaml';
process.env.TOPUP_AT = '3';
process.env.TOPUP_COOLDOWN_SECONDS = '60';
// Hermetic: importing session.js pulls in the MQTT client, which otherwise sits retrying a
// real broker and keeps the process alive forever (the suite prints nothing and looks hung,
// because the output is only flushed on exit). run.sh unsets these for the same reason.
delete process.env.MQTT_HOST;
delete process.env.MQTT_PORT;
delete process.env.MQTT_USER;
delete process.env.MQTT_PASS;

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ok   ${name}`);
  } catch {
    console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed += 1;
  }
};

// --- fakes ------------------------------------------------------------------
// The live playQueue, and what was appended to it. `remaining` is measured from the SELECTED
// item, which is the whole point of reading the live queue rather than trusting the session.
const live = { ratingKeys: ['1', '2', '3', '4', '5', '6'], selectedOffset: 0 };
let appended: string[] = [];

const playbackStub = {
  readPlayQueue: async () => ({
    ratingKeys: live.ratingKeys.slice(),
    selectedOffset: live.selectedOffset,
    remaining: Math.max(0, live.ratingKeys.length - live.selectedOffset - 1),
  }),
  extendPlayQueue: async (_id: unknown, keys: string[]) => {
    appended = keys.map(String);
    live.ratingKeys = live.ratingKeys.concat(appended);
    return live.ratingKeys.length;
  },
};

// The lineup builder's answer is deliberately CONSTANT and overlaps the live queue: items
// 4,5,6 are already queued, 7,8,9 are new. A working topup appends only the latter.
const providerStub = {
  label: 'FakePlex',
  profileToken: async () => 'tok',
  profileBinding: async (b: unknown) => b,
  buckets: async () => ({ play: ['4', '5', '6', '7', '8', '9'].map((rk) => ({ ratingKey: rk, title: `item ${rk}` })) }),
};

// The PULL provider — a reading list, not a playQueue. It owns its own append + trim, so all
// topup.ts hands it is the window, the top-up threshold and a builder; what comes back is
// what the tick reports. Every call is recorded, because the interesting assertions here are
// about WHETHER it was called at all and WITH WHAT — this provider was unreachable before
// 2026-08-17.
const listCalls: { window: number; at: number; built: unknown[] }[] = [];
// A HOLDER rather than a bare `let`: TypeScript's control-flow analysis does not know the
// stub below ever runs, so a `let … = null` stays narrowed to `null` at every read site and
// `ctx?.entries` types as `never`. Property narrowing is invalidated by the intervening
// `await topup(…)`, which is exactly the honest answer here.
const seen: { ctx: Record<string, unknown> | null } = { ctx: null };
const readingStub = {
  label: 'FakeKavita',
  delivery: 'pull',
  // The shared builder calls this; recording the context is how the test proves the top-up
  // uses it rather than the old Plex-shaped `buckets({ setName, cfg, binding, token })` call,
  // which omitted `entries` and served the library shelf instead of the owner's own series.
  buckets: async (ctx: Record<string, unknown>) => {
    seen.ctx = ctx;
    return { play: [{ chapterId: 7, seriesId: 1, title: 'ch 7' }] };
  },
  topupList: async ({ window, at, build }: {
    window: number; at: number; build: () => Promise<unknown[]>;
  }) => {
    const built = await build();
    listCalls.push({ window, at, built });
    return { ok: true, added: built.length, trimmed: 2, unread: 1 };
  },
};

// ESM namespace objects are FROZEN, so the collaborators are injected rather than stubbed by
// assignment — `topup()` takes them as `deps`, defaulted to the real modules in production.
const { SESSION } = await import('../server/src/session.js');
const { topup: topupReal, topupPullLists: sweepReal, _resetCooldown } = await import('../server/src/topup.js');
type Deps = Parameters<typeof topupReal>[0];
const DEPS = {
  ...playbackStub,
  providerFor: (id: string) => (id === 'kavita' ? readingStub : providerStub),
} as unknown as NonNullable<Deps>['deps'];
const topup = (opts: { now?: number; set?: string | null } = {}) => topupReal({ ...opts, deps: DEPS });
const sweep = (opts: { now?: number } = {}) => sweepReal({ ...opts, deps: DEPS });

const resetSession = (set: string | null) => {
  SESSION.set = set;
  SESSION.profile = null;
  SESSION.userUuid = null;
  SESSION.lastMovieRk = null;
  SESSION.playQueueID = 999;
  live.ratingKeys = ['1', '2', '3', '4', '5', '6'];
  live.selectedOffset = 0;
  appended = [];
  _resetCooldown();
};

// --- 1. when a tick does nothing --------------------------------------------
console.log('=== a tick is a WAKE-UP, not an instruction ===');

resetSession(null);
check('no session => no-op', (await topup()).reason, 'no active session');

resetSession('fixed');
live.selectedOffset = 5; // 0 left — as empty as it gets
// The most important no-op in the file: a channel with a fixed `length:` has CHOSEN to end.
// Topping it up anyway would silently delete that choice, and the owner would have no way to
// express "play exactly this much" any more.
// The REASON changed with playback length (top-up is derived from it, not from a `refill`
// flag), but the behaviour under test did not: a channel that plays a fixed number is
// still allowed to end, and a tick against it is still a no-op.
check('a non-refilling channel is allowed to END', (await topup()).reason, 'plays 6 — nothing to top up');

resetSession('curated');
check('a curated queue is not a channel', (await topup()).reason, 'not a rotation channel');

resetSession('refilling');
live.selectedOffset = 0; // 5 remaining, above TOPUP_AT=3
check('plenty left => no-op', (await topup()).reason, '5 left, tops up at 3');
check('  and nothing was appended', appended, []);

// --- 2. when it does top up --------------------------------------------------
console.log('=== topping up ===');

resetSession('refilling');
live.selectedOffset = 3; // 2 remaining, at or below TOPUP_AT
const res = await topup();
check('added something', (res.added ?? 0) > 0, true);
// The de-dupe. 4,5,6 are already in the live queue; only 7,8,9 are genuinely new.
check('appended ONLY items not already queued', appended, ['7', '8', '9']);
check('  no duplicate reached the queue', new Set(live.ratingKeys).size, live.ratingKeys.length);
// Refill back to the WINDOW (6), not a whole fresh window on top of what is left.
check('  filled to the window, not beyond', live.ratingKeys.length - live.selectedOffset - 1, 5);

// --- 3. the cooldown ---------------------------------------------------------
console.log('=== the cooldown stops a stuck automation walking the queue up ===');
// Same tick again, immediately. Without this guard a duplicated (or hung-and-retrying) HA
// automation grows the lineup one window per tick until it hits ROTATION_LENGTH_MAX.
live.selectedOffset = live.ratingKeys.length - 1; // pretend it drained again
appended = [];
const second = await topup();
check('a second tick inside the cooldown is refused', String(second.reason).startsWith('cooling down'), true);
check('  and appended nothing', appended, []);
// …and is allowed again once the cooldown has passed.
appended = [];
const later = await topup({ now: Date.now() + 61_000 });
check('a tick after the cooldown works again', (later.added ?? 0) >= 0 && !String(later.reason || '').startsWith('cooling down'), true);

// --- 4. the reading list, which has no session at all -------------------------
console.log('=== a reading list is topped up without a session ===');

// EVERY guard on the push path would have refused this set, and all three were wrong about
// it: it is `source: queue`, it states no `length:` (so its target is the 12-item window and
// `needsTopup(12)` is false), and nothing is playing. The result was a list that was seeded
// once at launch and then only shrank as chapters were read.
resetSession(null);
listCalls.length = 0;
const reading = await topup({ set: 'reading' });
check('a named reading set tops up with no session', (reading.added ?? 0) > 0, true);
check('  it refilled to the WINDOW the launch seeded (12)', listCalls[0]?.window, 12);
check('  and asked at the same threshold as a playQueue', listCalls[0]?.at, 3);
check('  the provider both added and trimmed', [reading.added, reading.remaining], [1, 1]);
// The lineup came from the SHARED builder: `entries` is the key the old call omitted, and
// `batch` carries the set's own `episodes: 2`.
check('  the lineup was built entries-first, not shelf-first', Array.isArray(seen.ctx?.entries), true);
check('  with the set\'s own per-series batch', seen.ctx?.batch, 2);

// The sweep is what the MQTT tick actually calls: no set name, no session, find them.
resetSession(null);
listCalls.length = 0;
_resetCooldown();
const swept = await sweep();
check('the sweep finds the reading set on its own', swept.map((r) => r.set), ['reading']);
check('  and tops it up', (swept[0]?.added ?? 0) > 0, true);

// A push set is NOT swept — it has a session, and a lineup nobody is watching must not be
// extended behind the viewer's back.
check('  push channels are left to the session tick', listCalls.length, 1);

if (failed) {
  console.error(`\ntopup-test: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\ntopup-test: all checks passed');
// EXPLICIT: session.js's transitive imports hold open handles (the MQTT client, undici's
// agent). Without this the suite passes and then hangs, which in run.sh is indistinguishable
// from a suite that deadlocked.
process.exit(0);

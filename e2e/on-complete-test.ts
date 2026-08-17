// `on_complete:` — what a FINISHED series does on a channel.
//
// The owner, 2026-08-17, on what infinite should mean:
//
//   "Wrap into rewatch, but for shows, leave an option to start at ep1 when complete or stop
//    that show. If you finish all shows, the queue is truly done at that point."
//
// So there are exactly two answers, and the DEFAULT must stay `drop` — that is what every
// channel has silently done since the beginning (a show with nothing unwatched contributes no
// bucket), and flipping it would make every existing channel start replaying old episodes.
//
// ⚠️ The subtle half, and the one most likely to be broken by a later edit: `restart` fires
// only when a show is GENUINELY finished — no unwatched episodes at all — never when the
// current window merely stopped drawing from it. `weightedInterleave` has its own "every
// bucket exhausted" condition and it means something different. Conflating them would restart
// every show on every top-up and starve the rotation down to one series.
//
// Hermetic: a fake PlexClient, no network.
//
// Run: server/node_modules/.bin/tsx e2e/on-complete-test.ts
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlexClient } from '../server/src/types.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.SETS_PATH = path.join(REPO, 'e2e', 'fixtures', 'topup.sets.yaml');
process.env.QUEUES_PATH = '/nonexistent.yaml';

const { unwatchedBuckets } = await import('../server/src/engine/select.js');

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

// Two shows in section 5: "Done" (both episodes watched) and "Fresh" (one left).
const EPISODES: Record<string, { ratingKey: string; title: string; parentIndex: number; index: number }[]> = {
  show_done: [
    { ratingKey: 'd1', title: 'Done S1E1', parentIndex: 1, index: 1 },
    { ratingKey: 'd2', title: 'Done S1E2', parentIndex: 1, index: 2 },
  ],
  show_fresh: [
    { ratingKey: 'f1', title: 'Fresh S1E1', parentIndex: 1, index: 1 },
    { ratingKey: 'f2', title: 'Fresh S1E2', parentIndex: 1, index: 2 },
  ],
};
const WATCHED = new Set(['d1', 'd2', 'f1']);

// Only the surface `unwatchedBuckets` actually touches. A narrow fake is the point: it makes
// the watched-state the ONE variable, so a change in what counts as "finished" shows up here.
// `client.container()` returns the MediaContainer ITSELF, not a `{MediaContainer: …}` wrapper
// — the shape select.ts reads as `mc.Metadata`.
let historyServed = false;
const client = {
  container: async (pathname: string) => {
    if (pathname.includes('/library/sections/5/all')) {
      return {
        Metadata: [
          { ratingKey: 'show_done', title: 'Done', type: 'show' },
          { ratingKey: 'show_fresh', title: 'Fresh', type: 'show' },
        ],
      };
    }
    const m = /metadata\/(\w+)\/allLeaves/.exec(pathname);
    if (m) {
      return { Metadata: (EPISODES[m[1]!] || []).map((e) => ({ ...e, type: 'episode', grandparentTitle: m[1] === 'show_done' ? 'Done' : 'Fresh' })) };
    }
    if (pathname.startsWith('/status/sessions/history/all')) {
      // `iterHistory` pages until a short page comes back, so the second call must be empty
      // or this loops forever.
      if (historyServed) return { Metadata: [] };
      historyServed = true;
      return { Metadata: [...WATCHED].map((rk) => ({ ratingKey: rk })) };
    }
    return { Metadata: [] };
  },
  accountToken: async () => 'tok',
} as unknown as PlexClient;

const binding = {
  plex_user: 'Kid', account_id: 1, user_uuid: null,
  allowed_ratings: null, movie_ratings: null, watch_count_accounts: [1],
};

const resetHistory = () => { historyServed = false; };
const base = { episodic_sections: [5], item_sections: [], blocklist: [], starts: {}, weights: {} };
const names = (bs: { show: string }[]) => bs.map((b) => b.show).sort();

console.log('=== the default is DROP (unchanged behaviour) ===');
resetHistory();
const dropped = await unwatchedBuckets(client, { ...base }, binding as never);
// "Done" is finished, so it is simply absent. This is what every channel has always done, and
// it is why a rotation withers as the kids finish shows — the thing `restart` exists to fix.
check('a finished show is absent', names(dropped), ['Fresh']);
check('  and the unfinished one keeps only its unwatched episode',
  dropped.find((b) => b.show === 'Fresh')?.episodes.map((e) => e.ratingKey), ['f2']);

console.log('=== on_complete: restart brings a finished show back at ep1 ===');
resetHistory();
const restarted = await unwatchedBuckets(client, { ...base, on_complete: 'restart' }, binding as never);
check('the finished show is back', names(restarted), ['Done', 'Fresh']);
check('  and it restarts at episode 1, whole show',
  restarted.find((b) => b.show === 'Done')?.episodes.map((e) => e.ratingKey), ['d1', 'd2']);
// The subtle half: a show that still has unwatched episodes is NOT restarted just because the
// channel refills. Restart is about being finished, not about the channel's appetite.
check('  an UNFINISHED show is untouched by restart',
  restarted.find((b) => b.show === 'Fresh')?.episodes.map((e) => e.ratingKey), ['f2']);

console.log('=== anything that is not "restart" means drop ===');
for (const value of ['drop', '', 'RESTART_LATER', 'true']) {
  resetHistory();
  const bs = await unwatchedBuckets(client, { ...base, on_complete: value }, binding as never);
  check(`on_complete: ${JSON.stringify(value)} => drop`, names(bs), ['Fresh']);
}
// …but the spelling IS case-insensitive, since the routing loader lowercases it.
resetHistory();
const upper = await unwatchedBuckets(client, { ...base, on_complete: 'Restart' }, binding as never);
check('on_complete: "Restart" (case) => restart', names(upper), ['Done', 'Fresh']);

console.log('=== a SINGLE SHOW can override its pool, in both directions ===');
// The case the owner described: "it would be good for each show to override this set-level
// config" - a pool that restarts everything, except the one the kids are done with.
resetHistory();
const exceptOne = await unwatchedBuckets(
  client,
  { ...base, on_complete: 'restart', on_complete_by_show: { show_done: 'drop' } },
  binding as never,
);
check('pool restarts, this show is told to finish => absent', names(exceptOne), ['Fresh']);

// …and the other way round, which is the direction a boolean could not have expressed.
resetHistory();
const reviveOne = await unwatchedBuckets(
  client,
  { ...base, on_complete_by_show: { show_done: 'restart' } },
  binding as never,
);
check('pool drops, this show is told to restart => back', names(reviveOne), ['Done', 'Fresh']);
check('  and it restarts at episode 1, whole show',
  reviveOne.find((b) => b.show === 'Done')?.episodes.map((e) => e.ratingKey), ['d1', 'd2']);

// An override names ONE show. Its neighbour is unaffected either way, or this is just a
// second way of spelling the pool-level setting.
resetHistory();
const onlyNamed = await unwatchedBuckets(
  client,
  { ...base, on_complete_by_show: { show_fresh: 'restart' } },
  binding as never,
);
check('an override for a DIFFERENT show leaves this one dropped', names(onlyNamed), ['Fresh']);

console.log('=== an unrecognised override follows the pool, rather than inverting it ===');
// sets.yaml is hand-edited over SMB. A typo must not silently flip a show to the opposite of
// what its pool says - that is the failure mode that looks exactly like the feature working.
for (const junk of ['', 'restart-at-1', 'true', 'DROPPED']) {
  resetHistory();
  const followsRestart = await unwatchedBuckets(
    client,
    { ...base, on_complete: 'restart', on_complete_by_show: { show_done: junk } },
    binding as never,
  );
  check(`${JSON.stringify(junk)} on a restarting pool => still restarts`, names(followsRestart), ['Done', 'Fresh']);

  resetHistory();
  const followsDrop = await unwatchedBuckets(
    client,
    { ...base, on_complete_by_show: { show_done: junk } },
    binding as never,
  );
  check(`${JSON.stringify(junk)} on a dropping pool => still drops`, names(followsDrop), ['Fresh']);
}

// Case-insensitive, like the pool-level spelling.
resetHistory();
const cased = await unwatchedBuckets(
  client,
  { ...base, on_complete_by_show: { show_done: 'ReStart' } },
  binding as never,
);
check('an override is case-insensitive too', names(cased), ['Done', 'Fresh']);

if (failed) {
  console.error(`\non-complete-test: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('\non-complete-test: all checks passed');
process.exit(0);

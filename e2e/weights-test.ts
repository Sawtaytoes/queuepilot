// WEIGHTS — "show up more often when the queue is randomized" (engine/weight.js + the two
// randomized paths that consume it: rotation.buildRotation and resolve.nextQueue's channel
// branch). No Plex, no network: the interleave is pure, and the channel branch runs against a
// stub client the way resume-in-queue-test.ts does.
//
// The load-bearing assertion is the LAST one: with no weights anywhere, the weighted interleave
// must return exactly what the plain round-robin it replaced returned. That is the compatibility
// promise for every channel Bob has not weighted — which is all of them today.
import assert from 'node:assert/strict';
import {
  MAX_WEIGHT, isUnweighted, toWeight, weightedInterleave, weightedShuffle,
} from '../server/src/engine/weight.js';
import type { Rng } from '../server/src/engine/weight.js';

/** A pool bucket as this harness builds them — `weight` optional, so the "weight absent
 * entirely" compatibility case is the same type as a weighted one. */
interface TestBucket {
  name: string;
  weight?: number;
  episodes: string[];
}

/** A curated MEMBER for the weightedShuffle half: an identity plus an optional weight. */
interface TestMember {
  n: string;
  weight?: number;
}

let failures = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// --- toWeight: everything unusable reads as 1, never as 0 (a 0 would silently mute an entry) --
ok('toWeight: absent → 1', toWeight(undefined) === 1 && toWeight(null) === 1);
ok('toWeight: junk → 1', toWeight('') === 1 && toWeight('lots') === 1 && toWeight({}) === 1);
ok('toWeight: 0 and negatives → 1', toWeight(0) === 1 && toWeight(-3) === 1);
ok('toWeight: numeric strings count', toWeight('3') === 3);
ok('toWeight: capped at MAX_WEIGHT', toWeight(9999) === MAX_WEIGHT);

// --- the interleave -------------------------------------------------------------------------
const bucket = (name: string, n: number, weight?: number): TestBucket => ({
  name,
  weight,
  episodes: Array.from({ length: n }, (_, i) => `${name}${i + 1}`),
});
const run = (buckets: readonly TestBucket[], length: number): string[] =>
  weightedInterleave(buckets, (b) => b.episodes, length);
const shows = (out: readonly string[]): string => out.map((x) => x[0]).join('');

// 3/1/1 deals three A's in five slots and never two A's in a row — the whole reason this is a
// scheduler and not a biased random pick.
const a3 = run([bucket('A', 9, 3), bucket('B', 9, 1), bucket('C', 9, 1)], 10);
ok('weight 3 takes ~3 slots in 5', shows(a3) === 'ABACAABACA', shows(a3));
ok('no two A in a row in the first round', !shows(a3).slice(0, 5).includes('AA'), shows(a3));

// The count is proportional, not merely "earlier": over 15 slots, 3/1/1 is 9/3/3.
const counted = run([bucket('A', 99, 3), bucket('B', 99, 1), bucket('C', 99, 1)], 15);
const tally = (out: readonly string[], ch: string): number => out.filter((x) => x[0] === ch).length;
ok('15 slots split 9/3/3', tally(counted, 'A') === 9 && tally(counted, 'B') === 3 && tally(counted, 'C') === 3,
  `${tally(counted, 'A')}/${tally(counted, 'B')}/${tally(counted, 'C')}`);

// A weighted bucket that RUNS OUT stops taking slots; the rest carry on rather than the queue
// ending short (the "Frieren finished mid-round" case).
// (3-vs-1 with only two buckets deals A A B A — three of every four slots MUST be A, so the
// adjacency the three-bucket case avoids is arithmetic here, not a scheduling bug. A is spent
// after two, and B takes the rest.)
const spent = run([bucket('A', 2, 3), bucket('B', 9, 1)], 8);
ok('an exhausted bucket drops out', shows(spent) === 'AABBBBBB', shows(spent));
ok('a short pool still fills the length', spent.length === 8, String(spent.length));

// Everything exhausted = stop, not an infinite loop.
const short = run([bucket('A', 1, 5), bucket('B', 1, 5)], 20);
ok('exhausted pool ends the queue', short.length === 2, String(short.length));

// Order within a bucket is never disturbed — episode order is the show's, weights only decide
// WHEN its turn comes.
ok('episode order preserved', counted.filter((x) => x[0] === 'A').join(',') === 'A1,A2,A3,A4,A5,A6,A7,A8,A9');

// --- the compatibility promise ---------------------------------------------------------------
// The exact round-robin buildRotation ran before weights existed, kept here as the oracle.
function legacyRoundRobin(order: readonly TestBucket[], length: number): string[] {
  const cursors = new Map<string, number>(order.map((s) => [s.name, 0]));
  const queue: string[] = [];
  while (queue.length < length) {
    let progressed = false;
    for (const s of order) {
      // Both `!`s assert what the loop already guarantees — every bucket got a cursor above,
      // and the read is guarded by the bounds check — so the emitted JS is byte-identical.
      const i = cursors.get(s.name)!;
      if (i < s.episodes.length) {
        queue.push(s.episodes[i]!);
        cursors.set(s.name, i + 1);
        progressed = true;
        if (queue.length >= length) break;
      }
    }
    if (!progressed) break;
  }
  return queue;
}
const POOLS: [string, TestBucket[]][] = [
  ['even pool', [bucket('A', 6, 1), bucket('B', 6, 1), bucket('C', 6, 1)]],
  ['ragged pool', [bucket('A', 2, 1), bucket('B', 5, 1), bucket('C', 1, 1)]],
  ['single bucket', [bucket('A', 4, 1)]],
  ['weight absent entirely', [{ name: 'A', episodes: ['A1', 'A2'] }, { name: 'B', episodes: ['B1', 'B2'] }]],
];
for (const [label, pool] of POOLS) {
  const legacy = legacyRoundRobin(pool, 12);
  const now = run(pool.map((b) => ({ ...b })), 12);
  ok(`unweighted ≡ old round-robin (${label})`, legacy.join(',') === now.join(','),
    `${legacy.join(',')} vs ${now.join(',')}`);
}
ok('isUnweighted spots a weighted pool', isUnweighted([{ weight: 1 }, {}]) && !isUnweighted([{ weight: 2 }, {}]));

// --- the weighted member shuffle (curated channels) -------------------------------------------
// Deterministic rng: a fixed cycle, so the assertion is about the WEIGHTING, not luck.
const seq = [0.9, 0.5, 0.1, 0.7, 0.3, 0.2, 0.8, 0.4, 0.6, 0.05];
let cursor = 0;
// `seq[...]` is a modulo read over a non-empty literal, so the `!` is an assertion, not a change.
const seeded: Rng = { random: () => seq[cursor++ % seq.length]!, shuffle: () => {} };
let heavyFirst = 0;
const TRIALS = 200;
for (let t = 0; t < TRIALS; t += 1) {
  const members: TestMember[] = [
    { n: 'light', weight: 1 }, { n: 'heavy', weight: 5 }, { n: 'light2', weight: 1 },
  ];
  weightedShuffle(members, seeded);
  if (members[0]!.n === 'heavy') heavyFirst += 1;
}
ok('a 5x member leads far more often than 1/3 of the time', heavyFirst > TRIALS * 0.5,
  `${heavyFirst}/${TRIALS}`);

// It is a SHUFFLE, not a sort: the heavy member does not always lead.
ok('weighting is not a hard sort', heavyFirst < TRIALS, `${heavyFirst}/${TRIALS}`);

// Every member survives the shuffle (no drops, no duplicates).
const roster: TestMember[] = [
  { n: 'a', weight: 1 }, { n: 'b', weight: 4 }, { n: 'c', weight: 2 }, { n: 'd' },
];
weightedShuffle(roster, seeded);
ok('shuffle keeps every member exactly once',
  roster.length === 4 && new Set(roster.map((m) => m.n)).size === 4);

assert.equal(failures, 0, `${failures} weight assertion(s) failed`);
console.log('\nweights: all assertions passed');

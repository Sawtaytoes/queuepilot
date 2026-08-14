// WEIGHTS — how often one entry comes up when a set is randomized.
//
// A weight is **slots per round**, not a probability: weight 3 takes about three of the queue's
// slots for every one a weight-1 entry takes, spread through the night rather than three in a
// row. That is the whole reason this is a scheduler and not `Math.random()` with a bias — the
// point of the rotation is that consecutive items are different shows, and a probabilistic pick
// would happily deal the same show three times running.
//
// Everything here is pure and rng-free except weightedShuffle, so the interleave is testable
// without stubbing randomness.

// The hard ceiling. A weight is slots per round, so an absurd value starves every other bucket
// for a whole session; 20 is far past any real use and keeps a fat-fingered hand-edit (or a bad
// PATCH body) from turning a channel into one show.
export const MAX_WEIGHT = 20;

// Normalize a weight off the wire or the YAML to an integer in [1, MAX_WEIGHT]. Absent, blank,
// non-numeric or < 1 all read as 1 — the plain unweighted bucket — so a queue that has never
// heard of weights behaves exactly as it did before this existed.
export function toWeight(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_WEIGHT);
}

export const weightOf = (bucket) => toWeight(bucket && bucket.weight);

// True when nothing in `buckets` is weighted, i.e. the weighted paths below must reduce to the
// unweighted ones. Every caller branches on this rather than trusting the maths, because
// "a channel with no weights plays exactly as it did yesterday" is the compatibility promise,
// and a seeded test proves it by comparing against the old code path directly.
export const isUnweighted = (buckets) => buckets.every((b) => weightOf(b) === 1);

/**
 * SMOOTH weighted round-robin (the nginx algorithm): pick the bucket with the highest running
 * credit, then charge it the total weight. Weights 3/1/1 deal A B A C A — three A's in five
 * slots, none of them adjacent — where "take 3 from A, then 1 from B" would deal A A A B C and
 * lose the point of a rotation.
 *
 * With every weight 1 this is EXACTLY the plain round-robin it replaces: each pass credits every
 * bucket once, the first bucket wins the tie, and the order walks the list. That equivalence is
 * what lets this ship without changing a single unweighted channel.
 *
 * `itemsOf(bucket)` returns that bucket's ordered play items; the cursor is kept HERE, so the
 * caller never has to (and a bucket that runs dry simply stops being eligible).
 */
export function weightedInterleave(buckets, itemsOf, length) {
  const state = buckets.map((bucket) => ({
    items: itemsOf(bucket) || [],
    weight: weightOf(bucket),
    current: 0,
    cursor: 0,
  }));
  const out = [];
  while (out.length < length) {
    // Liveness is re-read every slot: a bucket empties mid-session (a show runs out of unwatched
    // episodes) and must stop taking slots without disturbing the others' credits.
    const live = state.filter((e) => e.cursor < e.items.length);
    if (!live.length) break; // every bucket exhausted
    let total = 0;
    for (const e of live) total += e.weight;
    let best = null;
    for (const e of live) {
      e.current += e.weight;
      if (best === null || e.current > best.current) best = e; // ties keep the earlier bucket
    }
    best.current -= total;
    out.push(best.items[best.cursor]);
    best.cursor += 1;
  }
  return out;
}

/**
 * A weighted random ORDER for things that are each played once (a curated channel's members):
 * Efraimidis–Spirakis, key = random^(1/weight), highest key first. A 3x member is likelier to
 * land near the front — which, for a lineup that gets cut at ROTATION_LENGTH, is the same thing
 * as "comes up more often".
 *
 * `rng.random()` is used when present so a seeded test is deterministic; otherwise Math.random.
 * Callers must skip this entirely when nothing is weighted (see isUnweighted) so an unweighted
 * shuffle stays byte-for-byte the Fisher–Yates one the caller already had.
 */
export function weightedShuffle(arr, rng = null) {
  const random = rng && typeof rng.random === 'function' ? () => rng.random() : Math.random;
  const keyed = arr.map((item, i) => {
    const u = random();
    // u === 0 would make every key 0 and collapse the sort to input order; nudge it off zero.
    const r = u > 0 ? u : Number.MIN_VALUE;
    return { item, i, key: Math.pow(r, 1 / weightOf(item)) };
  });
  keyed.sort((a, b) => (b.key - a.key) || (a.i - b.i));
  arr.length = 0;
  for (const k of keyed) arr.push(k.item);
  return arr;
}

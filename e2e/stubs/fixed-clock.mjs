// A server-side clock and random source for VRT: `e2e/vrt-capture.ts` loads this into every
// server it starts with `NODE_OPTIONS=--import <this file>`.
//
// Why a preload and not a flag in server/src: the server reads `new Date()` on purpose — the
// season window, the seasonal reset and "is it finished" are all evaluated on a READ — so a
// screenshot of any of them depends on the day it was taken. A baseline shot in June must
// still match in December, and nothing the app ships should grow a test-only clock to make
// that true.
//
// The clock STARTS at `VRT_FIXED_NOW` and then advances in real time, rather than freezing.
// A frozen `Date.now()` would hang every `while (Date.now() < deadline)` loop and every TTL
// the server measures in elapsed time. A capture takes well under a minute, so nothing that
// renders at day or minute resolution moves.
//
// `Math.random` is a seeded PRNG for the same reason: the only thing a screenshot may vary
// with is the code.
const fixedStart = Date.parse(process.env.VRT_FIXED_NOW || '2026-06-15T18:00:00.000Z');
const realStart = performance.now();
const now = () => Math.floor(fixedStart + (performance.now() - realStart));

const RealDate = Date;

globalThis.Date = new Proxy(RealDate, {
  // `Date()` called as a function returns a string, never a Date.
  apply() {
    return new RealDate(now()).toString();
  },
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget);
  },
  get(target, property, receiver) {
    if (property === 'now') return now;
    return Reflect.get(target, property, receiver);
  },
});

// mulberry32 — small, fast, and deterministic from one 32-bit seed.
let seed = Number(process.env.VRT_RANDOM_SEED || 20260615) >>> 0;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

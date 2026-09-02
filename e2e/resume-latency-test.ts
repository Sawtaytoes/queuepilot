// How long it takes from "the player advanced" to "the seek request goes out".
//
// The owner's report was that seeking to the right spot in queued content takes four to five
// seconds. This harness is the number behind that sentence, before and after, so the claim
// "faster" is not the deliverable — the table is.
//
// WHAT IS REAL HERE AND WHAT IS MODELLED. The scheduling under test is the real
// `resume.startWatch()`: the real interval, the real one-shot `seen` bookkeeping, the real
// retry decision, the real push wake-up. What is modelled is the world around it — a virtual
// clock instead of wall time, and a fixed cost per network call instead of a network. So this
// measures the DECISION latency exactly and the transport latency by assumption, which is the
// right split: the transport was never the slow part.
//
// The four modelled numbers, and where each comes from:
//
//   SESSIONS_COST_MS   a /status/sessions GET against the LAN Plex server.
//   TARGET_COST_MS     a plex.tv `/api/v2/devices` round trip over the WAN. Paid on EVERY
//                      call that needs a Companion target when the target is neither cached
//                      nor handed in — which was every poll and every seek.
//   STALE_WINDOW_MS    how long /status/sessions keeps reporting the PREVIOUS item's position
//                      against the NEW ratingKey after an advance. Recorded live in
//                      resume.ts: one episode's first sighting carried the previous one's
//                      895 s. That reading is declined with `retry: true`.
//   PUSH_DELAY_MS      PMS websocket -> Home Assistant -> MQTT publish -> this process.
//
// Every one is printed with the results, and the whole table is re-run with TARGET_COST_MS
// at zero as well, so no conclusion rests on that one guess.
import assert from 'node:assert/strict';

process.env.RESUME_MIN_MS = '30000';
process.env.RESUME_MAX_FRACTION = '0.95';
process.env.RESUME_START_WINDOW_MS = '120000';
const resume = await import('../server/src/resume.js');

// --- the modelled world ------------------------------------------------------- //

const SESSIONS_COST_MS = 25;
const TARGET_COST_MS = 250;
const STALE_WINDOW_MS = 1_000;
const PUSH_DELAY_MS = 300;

/** The planned episode's own resume marker — the ms the seek is going to ask for. */
const MARKER_MS = 189_000;
/** The stale reading, well past RESUME_START_WINDOW_MS, so it is declined and retried. */
const STALE_POSITION_MS = 895_000;
/** The settled reading, comfortably inside the start window. */
const SETTLED_POSITION_MS = 3_000;

const RK_PREVIOUS = '359877';
const RK_PLANNED = '106617';

// --- a virtual clock ---------------------------------------------------------- //
//
// `startWatch` schedules with the global `setTimeout`, so the global is what gets replaced.
// `consume()` is how an awaited call spends time: a fetch that costs 25 ms moves the clock
// 25 ms before it resolves, which is what puts the network cost inside the measurement
// rather than beside it.

interface ClockTask { at: number; fn: () => void }

class VirtualClock {
  private t = 0;

  private seq = 0;

  private readonly tasks = new Map<number, ClockTask>();

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms?: number): number => {
    this.seq += 1;
    this.tasks.set(this.seq, { at: this.t + Math.max(0, Number(ms) || 0), fn });
    return this.seq;
  };

  clearTimeout = (id?: unknown): void => {
    if (typeof id === 'number') this.tasks.delete(id);
  };

  /** Time spent inside an awaited call. Tasks are not run; the next `runTo` picks them up. */
  consume(ms: number): void {
    this.t += ms;
  }

  /** Run every task due on or before `limit`, in time order, settling async work between. */
  async runTo(limit: number): Promise<void> {
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.tasks) {
        if (task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId == null || nextAt > limit) break;
      const task = this.tasks.get(nextId)!;
      this.tasks.delete(nextId);
      this.t = Math.max(this.t, task.at);
      task.fn();
      await settle();
    }
    this.t = Math.max(this.t, limit);
  }

  reset(): void {
    this.t = 0;
    this.seq = 0;
    this.tasks.clear();
  }
}

/** Let an async chain that only awaits resolved promises run to completion. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((r) => { setImmediate(r); });
  }
};

const clock = new VirtualClock();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const globals = globalThis as unknown as { setTimeout: unknown; clearTimeout: unknown };
globals.setTimeout = clock.setTimeout;
globals.clearTimeout = clock.clearTimeout;

// --- one run ------------------------------------------------------------------ //

interface Config {
  label: string;
  /** The fallback cadence. */
  intervalMs: number;
  /** Equal to `intervalMs` means "no fast retry" — a declined read waits a whole interval. */
  retryMs: number;
  /** Is the now-playing wake-up wired in? */
  isPushOn: boolean;
  /**
   * The per-call Companion-target cost. Non-zero models the state before this change: the
   * target was re-resolved on every poll and every seek, and a MISS was never cached, so a
   * player advertising no connection paid a plex.tv round trip every single time.
   */
  targetCostMs: number;
}

/**
 * Measure one advance. Returns the ms from the advance to the seek going out, or null when
 * no seek went out inside the run window.
 */
async function measureOnce(
  config: Config,
  advanceAtMs: number,
  { targetCostMs, staleWindowMs }: { targetCostMs: number; staleWindowMs: number },
): Promise<number | null> {
  clock.reset();
  resume.arm({ plan: new Map([[RK_PLANNED, MARKER_MS]]), device: null, setName: 'shows' });

  let seekAtMs: number | null = null;
  let pushEmit: ((ratingKey: string | null) => void) | null = null;

  const fetchSession = async (): Promise<{ ratingKey: string; viewOffset: number }> => {
    // A poll pays for its own Companion-target resolution before it can tell whose session
    // this is, then for the /status/sessions GET itself.
    clock.consume(targetCostMs + SESSIONS_COST_MS);
    const t = clock.now();
    if (t < advanceAtMs) return { ratingKey: RK_PREVIOUS, viewOffset: STALE_POSITION_MS };
    if (t < advanceAtMs + staleWindowMs) {
      // The recorded artifact: the NEW ratingKey carrying the PREVIOUS item's position.
      return { ratingKey: RK_PLANNED, viewOffset: STALE_POSITION_MS };
    }
    return { ratingKey: RK_PLANNED, viewOffset: SETTLED_POSITION_MS };
  };

  const seek = async (): Promise<{ seeked: true }> => {
    // The seek resolves its target too, and the byte leaves once that is done.
    clock.consume(targetCostMs);
    if (seekAtMs == null) seekAtMs = clock.now();
    return { seeked: true };
  };

  resume.startWatch({
    fetchSession,
    seek,
    intervalMs: config.intervalMs,
    retryMs: config.retryMs,
    now: clock.now,
    log: () => {},
    subscribePush: config.isPushOn
      ? (onEvent) => {
        pushEmit = onEvent;
        return () => { pushEmit = null; };
      }
      : null,
  });

  // The now-playing topic publishes the new ratingKey shortly after the advance.
  if (config.isPushOn) {
    clock.setTimeout(() => { pushEmit?.(RK_PLANNED); }, advanceAtMs + PUSH_DELAY_MS);
  }

  await clock.runTo(advanceAtMs + 30_000);
  resume.disarm();
  return seekAtMs == null ? null : seekAtMs - advanceAtMs;
}

interface Measurement { meanMs: number; worstMs: number; samples: number }

/**
 * Sweep the advance across one full poll interval, so the phase between the advance and the
 * cadence is sampled uniformly — which is exactly the thing that makes today's answer range
 * from "almost instant" to "five seconds" for the same code.
 */
async function measure(
  config: Config,
  { targetCostMs, staleWindowMs = STALE_WINDOW_MS }: { targetCostMs: number; staleWindowMs?: number },
): Promise<Measurement> {
  const stepMs = 10;
  const results: number[] = [];
  for (let advance = 1; advance <= config.intervalMs; advance += stepMs) {
    const latency = await measureOnce(config, advance, { targetCostMs, staleWindowMs });
    assert.notEqual(latency, null, `${config.label}: no seek went out for an advance at ${advance}ms`);
    results.push(latency!);
  }
  const total = results.reduce((a, b) => a + b, 0);
  return {
    meanMs: Math.round(total / results.length),
    worstMs: Math.max(...results),
    samples: results.length,
  };
}

// The five rows. Each adds one fix to the row above it, in the order they pay off.
const CONFIGS: Config[] = [
  { label: 'today (5 000 ms poll, no fast retry, target re-resolved per call)', intervalMs: 5_000, retryMs: 5_000, isPushOn: false, targetCostMs: TARGET_COST_MS },
  { label: '+ target cached at arm time, and a MISS negative-cached', intervalMs: 5_000, retryMs: 5_000, isPushOn: false, targetCostMs: 0 },
  { label: '+ poll cut to 1 500 ms', intervalMs: 1_500, retryMs: 1_500, isPushOn: false, targetCostMs: 0 },
  { label: '+ a declined read re-reads after 400 ms', intervalMs: 1_500, retryMs: 400, isPushOn: false, targetCostMs: 0 },
  { label: '+ the now-playing push wake-up (all of them)', intervalMs: 1_500, retryMs: 400, isPushOn: true, targetCostMs: 0 },
];

let failed = 0;
const check = (label: string, isOk: boolean, detail = ''): void => {
  if (isOk) console.log(`PASS ${label}`);
  else {
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
};

console.log('resume seek latency: player advances -> the seek request goes out\n');
console.log(`modelled: /status/sessions ${SESSIONS_COST_MS}ms, plex.tv target ${TARGET_COST_MS}ms, `
  + `stale-position window ${STALE_WINDOW_MS}ms, push delay ${PUSH_DELAY_MS}ms`);

const rows: {
  label: string;
  withTarget: Measurement;
  withoutTarget: Measurement;
  detectionOnly: Measurement;
}[] = [];
for (const config of CONFIGS) {
  const withTarget = await measure(config, { targetCostMs: config.targetCostMs });
  // The same row with the plex.tv cost forced to zero, so the table does not rest on that
  // one modelled number. Row 1 is the only one where the two differ.
  const withoutTarget = await measure(config, { targetCostMs: 0 });
  // And again with the stale-position artifact removed, which isolates DETECTION — the part
  // this change actually controls — from waiting for Plex to stop reporting the old number.
  const detectionOnly = await measure(config, { targetCostMs: config.targetCostMs, staleWindowMs: 0 });
  rows.push({ label: config.label, withTarget, withoutTarget, detectionOnly });
}

console.log('\n| Applied | Mean | Worst case | Mean, plex.tv cost excluded | Detection only, mean / worst |');
console.log('| --- | --- | --- | --- | --- |');
for (const row of rows) {
  console.log(`| ${row.label} | ${row.withTarget.meanMs} ms | ${row.withTarget.worstMs} ms `
    + `| ${row.withoutTarget.meanMs} ms | ${row.detectionOnly.meanMs} / ${row.detectionOnly.worstMs} ms |`);
}
console.log('');

const before = rows[0]!.withTarget;
const after = rows[rows.length - 1]!.withTarget;

check('today reproduces the report: the mean is seconds, not milliseconds',
  before.meanMs >= 2_000, `mean ${before.meanMs}ms`);
check('today can reach the full ten seconds the two waits allow',
  before.worstMs >= 5_000, `worst ${before.worstMs}ms`);
// The floor left is not the schedule any more, it is the modelled 1 000 ms during which
// /status/sessions still reports the previous item's position. Detection itself — the part
// this change owns — is a few hundred milliseconds, and the last row pins that separately.
check('all of them together bring the mean under a second and a half',
  after.meanMs < 1_500, `mean ${after.meanMs}ms`);
check('all of them together bring the WORST case under a second and a half',
  after.worstMs < 1_500, `worst ${after.worstMs}ms`);
check('DETECTION alone — with the stale-position artifact removed — is under 400 ms, worst case',
  rows[rows.length - 1]!.detectionOnly.worstMs < 400,
  `worst ${rows[rows.length - 1]!.detectionOnly.worstMs}ms`);
check('…where it used to be over five seconds',
  rows[0]!.detectionOnly.worstMs > 5_000, `worst ${rows[0]!.detectionOnly.worstMs}ms`);
check('every step is an improvement on the one before it',
  rows.every((row, i) => i === 0 || row.withTarget.meanMs <= rows[i - 1]!.withTarget.meanMs),
  rows.map((r) => `${r.withTarget.meanMs}`).join(' -> '));

// --- the push path's own behaviour -------------------------------------------- //
//
// The risk this whole design carries: the now-playing topic was rejected for this job once
// before, because it reported a playing state it could not name. So the null case is pinned
// as hard as the happy case.

const runPush = async (
  events: (string | null)[],
  { isSettled = true }: { isSettled?: boolean } = {},
): Promise<{ lines: string[]; seeks: number[]; reads: number; pending: number }> => {
  clock.reset();
  resume.arm({ plan: new Map([[RK_PLANNED, MARKER_MS]]), device: null, setName: 'shows' });
  const lines: string[] = [];
  const seeks: number[] = [];
  let reads = 0;
  // Held on an object rather than in a `let`: TypeScript narrows a local to its initializer
  // when the only assignment is inside a callback it cannot prove ran.
  const push: { emit: ((ratingKey: string | null) => void) | null } = { emit: null };
  resume.startWatch({
    fetchSession: async () => {
      reads += 1;
      clock.consume(SESSIONS_COST_MS);
      return {
        ratingKey: RK_PLANNED,
        viewOffset: isSettled ? SETTLED_POSITION_MS : STALE_POSITION_MS,
      };
    },
    seek: async (ms: number) => { seeks.push(ms); return { seeked: true }; },
    intervalMs: 100_000, // far away, so anything that happens is the push's doing
    retryMs: 100_000,
    now: clock.now,
    log: (line) => lines.push(line),
    subscribePush: (onEvent) => { push.emit = onEvent; return () => { push.emit = null; }; },
  });
  for (const event of events) push.emit?.(event);
  await settle();
  await clock.runTo(clock.now() + 50);
  const pending = resume.pendingCount();
  resume.disarm();
  return { lines, seeks, reads, pending };
};

const nullOnly = await runPush([null, null, null]);
check('a now-playing event with no ratingKey seeks nothing',
  nullOnly.seeks.length === 0, JSON.stringify(nullOnly.seeks));
check('…and reads nothing — it does not even wake the poll',
  nullOnly.reads === 0, `${nullOnly.reads} read(s)`);
check('…and says so once, so a silent do-nothing has a reason in the log',
  nullOnly.lines.filter((l) => l.includes('carried no ratingKey')).length === 1,
  JSON.stringify(nullOnly.lines));

const named = await runPush([RK_PLANNED]);
check('a now-playing event that NAMES the item seeks it',
  named.seeks.length === 1 && named.seeks[0] === MARKER_MS, JSON.stringify(named.seeks));
check('the log says which path fired',
  named.lines.some((l) => l.includes('via push')), JSON.stringify(named.lines));

const repeated = await runPush([RK_PLANNED, RK_PLANNED, RK_PLANNED, RK_PLANNED]);
check('the topic republishing the SAME ratingKey does not re-read Plex four times',
  repeated.reads === 1, `${repeated.reads} read(s)`);

const mixed = await runPush([null, RK_PLANNED, null]);
check('an unusable event between usable ones does not block the usable one',
  mixed.seeks.length === 1, JSON.stringify(mixed.seeks));

// A push whose /status/sessions reading is the stale one must NOT consume the episode: the
// item stays eligible, which is what the fast retry then settles.
const stale = await runPush([RK_PLANNED], { isSettled: false });
check('a push that lands on a stale position seeks nothing and keeps the item eligible',
  stale.seeks.length === 0 && stale.pending === 1,
  `seeks ${JSON.stringify(stale.seeks)}, pending ${stale.pending}`);

globals.setTimeout = realSetTimeout;
globals.clearTimeout = realClearTimeout;

console.log(failed ? `\nresume-latency FAILED (${failed})` : '\nresume-latency OK');
process.exit(failed ? 1 : 0);

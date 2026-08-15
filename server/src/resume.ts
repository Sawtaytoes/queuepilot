// Resume-on-advance: make EVERY queued episode start at its own resume point, not just the
// first one.
//
// The constraint this works around: a Plex playQueue has no per-item resume field
// (`createPlayQueue` posts a bare ratingKey list), and Companion `playMedia` takes a single
// `offset` that applies only to the item it starts on. So episodes 2..N restart at 0:00 no
// matter how far in they were. Verified live on the Shield 2026-08-11 with a kids' rotation:
//
//   #1 Daniel Tiger S2E4      marker 12m55s (= full duration)  started 0:08
//   #2 Pokémon S1E3           marker  0m00s                    started 0:09   (correct)
//   #3 Mister Rogers' S0E0    marker  3m09s                    started 0:09   (ignored)
//
// So after the player advances, we seek it to the marker ourselves.
//
// The advance is detected by polling the SERVER's own `/status/sessions`, not the retained
// `plex-channels/now-playing` topic. That topic looked like the obvious source — it is already
// published and carries a ratingKey — but it is fed from an HA Plex media_player that goes
// half-blind on this setup: measured mid-playback it reported `{"state":"playing",
// "ratingKey":null, "title":null, ...}`, every field but the state empty. A trigger that can't
// name the episode can't seek it. `/status/sessions` reported the same moment correctly
// ("Dr. Seuss | Horton Hatches the Egg | pos=90s | playing"), and it carries the POSITION too,
// which buys a much safer guard than "first sighting": only seek an episode still near its
// start.
import { RESUME_MIN_MS, RESUME_MAX_FRACTION, RESUME_START_WINDOW_MS, RESUME_POLL_MS } from './env.js';
import type { Device } from './types.js';
import { errMessage } from './errors.js';

/**
 * What `resumePlan()` reads off one lineup item.
 *
 * Not `PlayItem`/`PoolItem` from types.ts: the lineup that reaches here is Plex-shaped but
 * carries `viewCount`, which `PlexPlayItem` does not declare, and the open index signature
 * is what lets a caller pass either producer's item without a cast.
 */
export interface ResumeCandidate {
  ratingKey?: string | number | null;
  viewOffset?: number | null;
  viewCount?: number | null;
  duration?: number | null;
  [field: string]: unknown;
}

/** One observed `/status/sessions` reading — `playback.currentSession()`'s shape. */
export interface ObservedSession {
  ratingKey?: string | number | null;
  viewOffset?: number | null;
}

/** What `considerSession()` decided, and why. The `reason` strings are logged verbatim. */
export interface ResumeDecision {
  /** ms to seek to, or null for "do nothing". */
  ms: number | null;
  reason: string;
  rk?: string;
  /** Set when the decline is provisional and the next poll should reconsider this ratingKey. */
  retry?: boolean;
  position?: number;
}

/**
 * Which queued items should be seeked after the player advances to them, and to where.
 *
 * Pure and total so the policy is testable without a player: returns Map<ratingKey, ms>.
 *
 * Excluded, each for its own reason:
 *  - the HEAD, because playMedia's `offset` already resumed it — seeking again would fight it;
 *  - anything already watched (viewCount >= 1) — that marker is stale, not a resume point;
 *  - markers below `minMs`, which are "never really started" rather than a place to return to.
 *    This is what stops a 9-second marker yanking the viewer past the opening seconds;
 *  - markers past `maxFraction` of the runtime — resuming there would end the episode almost
 *    immediately. The live data had a marker sitting at EXACTLY the full duration (Daniel
 *    Tiger, 12m55s of 12m55s), left by the queue auto-advancing unattended; restarting that
 *    one is right.
 */
export function resumePlan(items: readonly ResumeCandidate[] | null | undefined, {
  headRatingKey = null,
  minMs = RESUME_MIN_MS,
  maxFraction = RESUME_MAX_FRACTION,
}: {
  headRatingKey?: string | number | null;
  minMs?: number;
  maxFraction?: number;
} = {}): Map<string, number> {
  const plan = new Map<string, number>();
  for (const it of items || []) {
    if (!it || it.ratingKey == null) continue;
    const rk = String(it.ratingKey);
    if (headRatingKey != null && rk === String(headRatingKey)) continue;
    const offset = Number(it.viewOffset || 0);
    const viewCount = Number(it.viewCount || 0);
    if (!Number.isFinite(offset) || offset < minMs) continue;
    if (viewCount >= 1) continue;
    const duration = Number(it.duration || 0);
    if (duration > 0 && offset > duration * maxFraction) continue;
    plan.set(rk, Math.round(offset));
  }
  return plan;
}

// The armed plan for the CURRENT session. A session is a fresh scan, so arming replaces it
// wholesale — a re-scan must never inherit the previous lineup's pending seeks.
const ARMED: {
  plan: Map<string, number>;
  seen: Set<string>;
  device: Device | null;
  setName: string | null;
} = {
  plan: new Map(), seen: new Set(), device: null, setName: null,
};

export function arm({ plan, device = null, setName = null }: {
  plan?: Map<string, number> | null;
  device?: Device | null;
  setName?: string | null;
} = {}): number {
  ARMED.plan = plan instanceof Map ? plan : new Map();
  ARMED.seen = new Set();
  ARMED.device = device;
  ARMED.setName = setName;
  return ARMED.plan.size;
}

export function disarm(): void {
  ARMED.plan = new Map();
  ARMED.seen = new Set();
  stopWatch();
}

export const armedCount = (): number => ARMED.plan.size;
export const pendingCount = (): number => [...ARMED.plan.keys()].filter((k) => !ARMED.seen.has(k)).length;
export const target = (): { device: Device | null; setName: string | null } => (
  { device: ARMED.device, setName: ARMED.setName }
);

/**
 * Decide what to do about one observed session. Returns the ms to seek to, or null.
 *
 * Every ratingKey is considered at most ONCE — planned or not — so a poll every few seconds
 * can't re-seek an episode the viewer has since scrubbed, and pausing/resuming can't drag them
 * back to the marker.
 *
 * `startWindowMs` is the safety rail the now-playing topic could never have given us: if the
 * episode is already well past its start, we missed the transition (or the viewer moved on
 * deliberately), and yanking them backwards would be worse than doing nothing.
 */
export function considerSession(
  session: ObservedSession | null | undefined,
  { startWindowMs = RESUME_START_WINDOW_MS }: { startWindowMs?: number } = {},
): ResumeDecision {
  if (!session || session.ratingKey == null) return { ms: null, reason: 'nothing playing' };
  const rk = String(session.ratingKey);
  if (ARMED.seen.has(rk)) return { ms: null, reason: 'already considered', rk };
  const ms = ARMED.plan.get(rk);
  if (ms == null) {
    ARMED.seen.add(rk); // settled: no marker, nothing to reconsider
    return { ms: null, reason: 'not in the plan (no usable marker at scan time)', rk };
  }
  const position = Number(session.viewOffset || 0);
  if (position > startWindowMs) {
    // Do NOT mark it handled. At the moment the player advances, /status/sessions can still
    // report the PREVIOUS episode's position against the new ratingKey — observed live, where
    // Alvin Show's first sighting carried DuckTales' 895s. Consuming the episode on that
    // reading would decline a resume that was actually due. Retry on the next poll: a stale
    // position settles within a poll or two, while a viewer who genuinely scrubbed forward
    // keeps reporting a high position and keeps (correctly) being declined.
    return {
      ms: null, rk, retry: true,
      reason: `${Math.round(position / 1000)}s in, past the ${Math.round(startWindowMs / 1000)}s window`,
    };
  }
  ARMED.seen.add(rk);
  return { ms, reason: 'resume', rk, position };
}

// --- the watcher ------------------------------------------------------------- //
// Polling (rather than a push feed) is deliberate: see the module header. It runs only while a
// plan has unfired entries, so a finished lineup costs nothing.

let TIMER: NodeJS.Timeout | null = null;
const LOGGED = new Set<string>(); // ratingKeys whose retryable decline has been logged once

export function stopWatch(): void {
  if (TIMER) {
    clearInterval(TIMER);
    TIMER = null;
  }
}

export const watching = (): boolean => TIMER != null;

/**
 * Poll `fetchSession()` and seek when the player lands on a planned episode near its start.
 *
 * `fetchSession` → {ratingKey, viewOffset} | null, `seek(ms)` → any. Both injected so the loop
 * is testable without Plex or a player. Stops itself once every planned episode has been
 * considered, or after `maxMs` — a lineup nobody is watching must not poll the server forever.
 */
export function startWatch({
  fetchSession,
  seek,
  intervalMs = RESUME_POLL_MS,
  maxMs = 8 * 60 * 60 * 1000,
  now = () => Date.now(),
  log = console.log,
}: {
  fetchSession: () => ObservedSession | null | Promise<ObservedSession | null>;
  seek: (ms: number) => { seeked?: boolean; error?: string } | Promise<{ seeked?: boolean; error?: string }>;
  intervalMs?: number;
  maxMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}): boolean {
  stopWatch();
  LOGGED.clear();
  if (!ARMED.plan.size) return false;
  const startedAt = now();
  TIMER = setInterval(async () => {
    if (now() - startedAt > maxMs || pendingCount() === 0) {
      stopWatch();
      return;
    }
    let session: ObservedSession | null = null;
    try {
      session = await fetchSession();
    } catch {
      return; // a transient Plex hiccup must never kill the watcher
    }
    let decision: ResumeDecision;
    try {
      decision = considerSession(session);
    } catch {
      return;
    }
    // Log EVERY decision, not just the seeks: when this silently does nothing, the reason it
    // declined is the only thing worth having. One line per episode, not per poll — `seen`
    // guarantees a given ratingKey is considered once.
    const quiet = decision.reason === 'already considered' || decision.reason === 'nothing playing';
    if (!quiet && !(decision.retry && LOGGED.has(decision.rk ?? ''))) {
      if (decision.retry) LOGGED.add(decision.rk ?? '');
      // `session!`: every non-quiet reason is produced from a non-null session (a null one
      // yields 'nothing playing', which IS quiet), so this is the original's exact reach —
      // including its throw, if that invariant ever breaks.
      log(`[resume] rk=${decision.rk} at ${Math.round(Number(session!.viewOffset || 0) / 1000)}s -> ${decision.reason}`);
    }
    const ms = decision.ms;
    if (ms == null) return;
    try {
      const r = await seek(ms);
      log(r && r.seeked === false
        ? `[resume] seek to ${Math.round(ms / 1000)}s failed: ${r.error}`
        : `[resume] resumed rk=${decision.rk} at ${Math.round(ms / 1000)}s (it restarts at 0 otherwise)`);
    } catch (e) {
      log(`[resume] seek threw: ${errMessage(e)}`);
    }
  }, intervalMs);
  // Kept as a runtime probe, not narrowed away: `unref` exists on Node's Timeout but the
  // test harness's fake timer is a plain object without it.
  if (typeof TIMER.unref === 'function') TIMER.unref();
  return true;
}

export const _internals = { ARMED };

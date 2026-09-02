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
// WHAT is playing is read from the SERVER's own `/status/sessions`, never from the retained
// now-playing topic. That topic looked like the obvious source — it is already published and
// carries a ratingKey — but it is fed from an HA Plex media_player that goes half-blind on
// this setup: measured mid-playback it reported `{"state":"playing", "ratingKey":null,
// "title":null, ...}`, every field but the state empty. A trigger that can't name the episode
// can't seek it. `/status/sessions` reported the same moment correctly ("Dr. Seuss | Horton
// Hatches the Egg | pos=90s | playing"), and it carries the POSITION too, which buys a much
// safer guard than "first sighting": only seek an episode still near its start.
//
// WHEN to read it is a separate question, and the answer changed on 2026-09-01. It used to be
// "every RESUME_POLL_MS", which was 5 000 ms — and that one number was the owner's complaint
// that seeking to the right spot takes four to five seconds. The seek is one LAN round trip;
// finding out that it was due is what was slow. So the same now-playing topic is now a
// WAKE-UP: a published ratingKey change means the player advanced, and the watcher reads
// /status/sessions immediately instead of waiting for its next tick.
//
// Note what that does and does not trust. It uses the topic's TIMING and its "the name
// changed" edge. It reads no position from it and seeks nothing on its say-so. An event that
// carries no ratingKey — the exact failure recorded above — wakes nothing, and the poll
// covers that item as it always did. RESUME_PUSH_TRIGGER=0 removes the wake-up entirely.
// (decision 2026-09-01-a-section-boundary-is-detected-from-the-push-feed-not-a-five-second-poll)
//
// SINCE 2026-09-02 THIS LOOP DRIVES TWO PLANS. `section.ts` holds the authored windows —
// start here, stop there, advance — and the watcher below consults it BEFORE its own resume
// plan. One watcher rather than two, because both plans are answers to the same event ("the
// player is at position P on item R"): a second timer would double the reads of one endpoint
// and let two decisions race over one item. The precedence is one line, and it is the rule
// the whole feature turns on — an AUTHORED section outranks an INFERRED resume marker.
import {
  RESUME_MIN_MS,
  RESUME_MAX_FRACTION,
  RESUME_START_WINDOW_MS,
  RESUME_POLL_MS,
  RESUME_RETRY_MS,
} from './env.js';
import type { Device } from './types.js';
import type { ClientTarget } from './playback.js';
import * as section from './section.js';
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
  client: ClientTarget | null;
} = {
  plan: new Map(), seen: new Set(), device: null, setName: null, client: null,
};

export function arm({ plan, device = null, setName = null, client = null }: {
  plan?: Map<string, number> | null;
  device?: Device | null;
  setName?: string | null;
  /**
   * The Companion target, resolved ONCE for this session. `findClient()` used to run again
   * on every poll and again on every seek; on a player advertising no connection each of
   * those was a plex.tv WAN round trip. Null keeps the old per-call resolution.
   */
  client?: ClientTarget | null;
} = {}): number {
  ARMED.plan = plan instanceof Map ? plan : new Map();
  ARMED.seen = new Set();
  ARMED.device = device;
  ARMED.setName = setName;
  ARMED.client = client;
  return ARMED.plan.size;
}

export function disarm(): void {
  ARMED.plan = new Map();
  ARMED.seen = new Set();
  stopWatch();
}

export const armedCount = (): number => ARMED.plan.size;
export const pendingCount = (): number => [...ARMED.plan.keys()].filter((k) => !ARMED.seen.has(k)).length;
export const target = (): {
  device: Device | null;
  setName: string | null;
  client: ClientTarget | null;
} => (
  { device: ARMED.device, setName: ARMED.setName, client: ARMED.client }
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
// It runs only while a plan has unfired entries, so a finished lineup costs nothing. Three
// things can make it read /status/sessions, and they are logged apart because when this
// silently does the wrong thing, which one fired is the first question:
//
//   push   — the now-playing topic published a DIFFERENT ratingKey. The advance itself.
//   retry  — the last read was declined provisionally (a stale position at the transition).
//   poll   — nothing pushed; the fallback cadence came round.
//   mark   — a section's end mark is due about now, so the read was SCHEDULED to land on it.
//
// `mark` is what makes the stop-at cheap. The last read said "the end is 87 s away at this
// position", so the next one is booked for then instead of grinding through fifty-eight polls
// that all say "not yet". A pause simply makes the booked read early, and it re-books.

let TIMER: NodeJS.Timeout | null = null;
let UNSUBSCRIBE: (() => void) | null = null;
const LOGGED = new Set<string>(); // ratingKeys whose retryable decline has been logged once

/** Which of the three reasons above caused a read. Logged verbatim. */
export type WatchTrigger = 'push' | 'retry' | 'poll' | 'mark';

/** How `startWatch` is told about a now-playing event. Returns its own unsubscribe. */
export type PushSubscriber = (
  onEvent: (ratingKey: string | null) => void,
) => () => void;

export function stopWatch(): void {
  if (TIMER) {
    clearTimeout(TIMER);
    TIMER = null;
  }
  if (UNSUBSCRIBE) {
    // A listener that outlives its watcher would hold the previous lineup's closure and wake
    // a plan that has already been replaced.
    try { UNSUBSCRIBE(); } catch { /* a broker that already went away is not an error here */ }
    UNSUBSCRIBE = null;
  }
}

export const watching = (): boolean => TIMER != null;

/**
 * Read `fetchSession()` and seek when the player lands on a planned episode near its start.
 *
 * `fetchSession` → {ratingKey, viewOffset} | null, `seek(ms)` → any. Both injected so the loop
 * is testable without Plex or a player, which is also how `e2e/resume-latency-test.ts`
 * measures it. Stops itself once every planned episode has been considered, or after `maxMs`
 * — a lineup nobody is watching must not read the server forever.
 *
 * `subscribePush` is the now-playing wake-up (see the module header). Omit it, or pass null,
 * and this is the pure poll loop it has always been.
 */
export function startWatch({
  fetchSession,
  seek,
  fetchPlace = null,
  advance = null,
  subscribePush = null,
  intervalMs = RESUME_POLL_MS,
  retryMs = RESUME_RETRY_MS,
  maxMs = 8 * 60 * 60 * 1000,
  now = () => Date.now(),
  log = console.log,
}: {
  fetchSession: () => ObservedSession | null | Promise<ObservedSession | null>;
  seek: (ms: number) => { seeked?: boolean; error?: string } | Promise<{ seeked?: boolean; error?: string }>;
  /**
   * Where the player is in the LIVE playQueue — `playback.readPlayQueue()`.
   *
   * Read ONLY when the section plan holds two pending windows for the observed file, which is
   * the only case an index can settle and a ratingKey cannot. Omit it and a repeated file's
   * windows decline rather than guess; every other case is unaffected.
   */
  fetchPlace?: (() => section.PlayQueuePlace | null | Promise<section.PlayQueuePlace | null>) | null;
  /**
   * Stop the current item and move to the next — Companion `skipNext`, through
   * `playback.transport('next')`.
   *
   * NOT `session.advanceSession()`, which rebuilds the whole playQueue and restarts playback.
   * `topup.ts` names that as the thing to avoid, and it would be a hiccup on screen where a
   * section wants a cut.
   */
  advance?: (() => { ok?: boolean; error?: string } | Promise<{ ok?: boolean; error?: string }>) | null;
  subscribePush?: PushSubscriber | null;
  intervalMs?: number;
  retryMs?: number;
  maxMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}): boolean {
  stopWatch();
  LOGGED.clear();
  if (!ARMED.plan.size && !section.armedCount()) return false;
  const startedAt = now();
  let isStopped = false;
  let isReading = false;
  // A provisional decline re-reads fast rather than waiting a whole interval — that second
  // wait was the other half of the owner's "4-5 seconds". The burst is bounded to roughly one
  // interval's worth of extra reads, so a viewer who genuinely scrubbed forward (and is
  // correctly declined every time) settles back to the normal cadence instead of being
  // re-read several times a second for the rest of the lineup.
  const retryDelayMs = Math.max(1, Math.min(retryMs, intervalMs));
  const retryBurst = Math.max(1, Math.ceil(intervalMs / retryDelayMs));
  let retriesLeft = retryBurst;

  const finish = (): void => {
    isStopped = true;
    stopWatch();
  };

  const schedule = (delayMs: number, via: WatchTrigger = 'poll'): void => {
    if (isStopped) return;
    if (TIMER) clearTimeout(TIMER);
    TIMER = setTimeout(() => { void read(via); }, delayMs);
    // Kept as a runtime probe, not narrowed away: `unref` exists on Node's Timeout but a test
    // harness's fake timer is a plain object without it.
    if (typeof TIMER.unref === 'function') TIMER.unref();
  };

  const totalPending = (): number => pendingCount() + section.pendingCount();

  const read = async (via: WatchTrigger): Promise<void> => {
    if (isStopped) return;
    if (now() - startedAt > maxMs || totalPending() === 0) {
      finish();
      return;
    }
    // A push landing while a read is in flight must not double the request: the read already
    // under way will report whatever the push was about.
    if (isReading) return;
    isReading = true;
    let nextDelayMs = intervalMs;
    let nextVia: WatchTrigger = 'poll';
    try {
      let session: ObservedSession | null = null;
      try {
        session = await fetchSession();
      } catch {
        return; // a transient Plex hiccup must never kill the watcher
      }

      // ── THE SECTION PLAN FIRST ──────────────────────────────────────────────────────
      // An AUTHORED window outranks an INFERRED resume marker, so a section is consulted
      // before the resume plan and, when it names this item, the resume plan is not consulted
      // for it at all. That is not an optimisation: an entry whose window says "stop at
      // 1:06:00" and nothing else means "from the beginning of the unit", and letting a
      // resume marker start it half an hour in would honour neither key.
      if (section.armedCount()) {
        let place: section.PlayQueuePlace | null = null;
        if (fetchPlace && session?.ratingKey != null
          && section.isAmbiguous(String(session.ratingKey))) {
          // Two windows on one file: only the live playQueue can say which occurrence this is.
          try { place = await fetchPlace(); } catch { place = null; }
        }
        let sec: section.SectionDecision;
        try {
          sec = section.consider(session, place);
        } catch {
          return;
        }
        // The section OWNS this reading when it named a row for the item on screen, or when
        // it refused to name one because two windows are in play. In the second case the
        // resume plan must not act either — an item this file cannot identify is not an item
        // the other plan should be seeking.
        const isOwned = sec.index != null || sec.retry === true;
        if (isOwned) {
          if (sec.action !== 'wait') {
            log(`[section] via ${via}: rk=${sec.rk} at `
              + `${Math.round(Number(session?.viewOffset || 0) / 1000)}s -> ${sec.reason}`);
          }
          if (sec.action === 'seek' && sec.ms != null) {
            try {
              const r = await seek(sec.ms);
              log(r && r.seeked === false
                ? `[section] the start seek to ${Math.round(sec.ms / 1000)}s failed: ${r.error}`
                : `[section] rk=${sec.rk} starts at ${Math.round(sec.ms / 1000)}s`);
            } catch (e) {
              log(`[section] the start seek threw: ${errMessage(e)}`);
            }
          } else if (sec.action === 'next') {
            if (!advance) {
              log('[section] the end mark is due but no advance was wired — the item plays on');
            } else {
              try {
                const r = await advance();
                log(r && r.ok === false
                  ? `[section] skipNext failed at the end mark: ${r.error}`
                  : `[section] rk=${sec.rk} stopped at its end mark; the lineup advances`);
              } catch (e) {
                log(`[section] skipNext threw: ${errMessage(e)}`);
              }
            }
          }
          if (sec.retry && retriesLeft > 0) {
            retriesLeft -= 1;
            nextDelayMs = retryDelayMs;
          } else if (!sec.retry) {
            retriesLeft = retryBurst;
            if (sec.action === 'wait' && sec.dueInMs != null) {
              // Book the next read FOR the end mark rather than polling up to it. Clamped to
              // the ordinary cadence at the top, so a long section still gets its regular
              // sanity reads and a viewer who paused is noticed; clamped to `retryDelayMs` at
              // the bottom, so a mark already upon us cannot spin the loop.
              nextDelayMs = Math.max(retryDelayMs, Math.min(intervalMs, sec.dueInMs));
              if (sec.dueInMs <= intervalMs) nextVia = 'mark';
            }
          }
          return;
        }
      }

      let decision: ResumeDecision;
      try {
        decision = considerSession(session);
      } catch {
        return;
      }
      if (decision.retry && retriesLeft > 0) {
        retriesLeft -= 1;
        nextDelayMs = retryDelayMs;
      } else if (!decision.retry) {
        retriesLeft = retryBurst; // a settled read re-arms the burst for the NEXT transition
      }
      // Log EVERY decision, not just the seeks: when this silently does nothing, the reason it
      // declined is the only thing worth having. One line per episode, not per read — `seen`
      // guarantees a given ratingKey is considered once.
      const quiet = decision.reason === 'already considered' || decision.reason === 'nothing playing';
      if (!quiet && !(decision.retry && LOGGED.has(decision.rk ?? ''))) {
        if (decision.retry) LOGGED.add(decision.rk ?? '');
        // `session!`: every non-quiet reason is produced from a non-null session (a null one
        // yields 'nothing playing', which IS quiet), so this is the original's exact reach —
        // including its throw, if that invariant ever breaks.
        log(`[resume] via ${via}: rk=${decision.rk} at ${Math.round(Number(session!.viewOffset || 0) / 1000)}s -> ${decision.reason}`);
      }
      const ms = decision.ms;
      if (ms == null) return;
      try {
        const r = await seek(ms);
        log(r && r.seeked === false
          ? `[resume] seek to ${Math.round(ms / 1000)}s failed: ${r.error}`
          : `[resume] resumed rk=${decision.rk} at ${Math.round(ms / 1000)}s via ${via} (it restarts at 0 otherwise)`);
      } catch (e) {
        log(`[resume] seek threw: ${errMessage(e)}`);
      }
    } finally {
      isReading = false;
      if (totalPending() === 0) finish();
      else schedule(nextDelayMs, nextVia);
    }
  };

  if (subscribePush) {
    // The topic republishes on EVERY attribute change — volume, a pause, a position update —
    // so only a change of ratingKey is an advance. That test also collapses the burst Plex
    // emits while it navigates between items.
    let lastPushedRk: string | null = null;
    let isNullLogged = false;
    try {
      UNSUBSCRIBE = subscribePush((ratingKey) => {
        if (isStopped) return;
        if (!ratingKey) {
          // The recorded failure mode: a playing state the feed cannot name. Unusable as a
          // trigger, and NOT guessed at — the poll below still covers this item.
          if (!isNullLogged) {
            isNullLogged = true;
            log('[resume] a now-playing event carried no ratingKey — the poll stays the trigger for it');
          }
          return;
        }
        if (ratingKey === lastPushedRk) return;
        lastPushedRk = ratingKey;
        void read('push');
      });
    } catch (e) {
      // No broker, no push. The poll is the whole trigger, exactly as before.
      UNSUBSCRIBE = null;
      log(`[resume] the now-playing wake-up is unavailable (${errMessage(e)}) — polling only`);
    }
  }
  log(`[resume] watching: ${ARMED.plan.size} resume marker(s) + ${section.armedCount()} `
    + `section window(s), poll every ${intervalMs}ms, retry after ${retryDelayMs}ms, `
    + `push wake-up ${UNSUBSCRIBE ? 'on' : 'off'}`);
  schedule(intervalMs);
  return true;
}

export const _internals = { ARMED };

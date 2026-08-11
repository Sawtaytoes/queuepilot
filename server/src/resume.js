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
export function resumePlan(items, {
  headRatingKey = null,
  minMs = RESUME_MIN_MS,
  maxFraction = RESUME_MAX_FRACTION,
} = {}) {
  const plan = new Map();
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
const ARMED = { plan: new Map(), seen: new Set(), device: null, setName: null };

export function arm({ plan, device = null, setName = null } = {}) {
  ARMED.plan = plan instanceof Map ? plan : new Map();
  ARMED.seen = new Set();
  ARMED.device = device;
  ARMED.setName = setName;
  return ARMED.plan.size;
}

export function disarm() {
  ARMED.plan = new Map();
  ARMED.seen = new Set();
  stopWatch();
}

export const armedCount = () => ARMED.plan.size;
export const pendingCount = () => [...ARMED.plan.keys()].filter((k) => !ARMED.seen.has(k)).length;
export const target = () => ({ device: ARMED.device, setName: ARMED.setName });

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
export function considerSession(session, { startWindowMs = RESUME_START_WINDOW_MS } = {}) {
  if (!session || session.ratingKey == null) return null;
  const rk = String(session.ratingKey);
  if (ARMED.seen.has(rk)) return null;
  ARMED.seen.add(rk);
  const ms = ARMED.plan.get(rk);
  if (ms == null) return null;
  const position = Number(session.viewOffset || 0);
  if (position > startWindowMs) return null;
  return ms;
}

// --- the watcher ------------------------------------------------------------- //
// Polling (rather than a push feed) is deliberate: see the module header. It runs only while a
// plan has unfired entries, so a finished lineup costs nothing.

let TIMER = null;

export function stopWatch() {
  if (TIMER) {
    clearInterval(TIMER);
    TIMER = null;
  }
}

export const watching = () => TIMER != null;

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
} = {}) {
  stopWatch();
  if (!ARMED.plan.size) return false;
  const startedAt = now();
  TIMER = setInterval(async () => {
    if (now() - startedAt > maxMs || pendingCount() === 0) {
      stopWatch();
      return;
    }
    let session = null;
    try {
      session = await fetchSession();
    } catch {
      return; // a transient Plex hiccup must never kill the watcher
    }
    let ms = null;
    try {
      ms = considerSession(session);
    } catch {
      return;
    }
    if (ms == null) return;
    try {
      const r = await seek(ms);
      log(r && r.seeked === false
        ? `[resume] seek to ${Math.round(ms / 1000)}s failed: ${r.error}`
        : `[resume] resumed at ${Math.round(ms / 1000)}s (it restarts at 0 otherwise)`);
    } catch (e) {
      log(`[resume] seek threw: ${e && e.message ? e.message : e}`);
    }
  }, intervalMs);
  if (typeof TIMER.unref === 'function') TIMER.unref();
  return true;
}

export const _internals = { ARMED };

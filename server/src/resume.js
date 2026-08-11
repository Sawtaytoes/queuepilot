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
// So after the player advances, we seek it to the marker ourselves. The advance is detected
// from the retained `plex-channels/now-playing` topic that HA already publishes (it carries a
// ratingKey but NO position, which is why the trigger is "first sighting of this ratingKey in
// this session" rather than "position is near zero").
import { RESUME_MIN_MS, RESUME_MAX_FRACTION } from './env.js';

/**
 * Which queued items should be seeked after the player advances to them, and to where.
 *
 * Pure and total so the policy is testable without a player: returns Map<ratingKey, ms>.
 *
 * Excluded, each for its own reason:
 *  - the HEAD, because playMedia's `offset` already resumed it — seeking again would fight it;
 *  - anything already watched (viewCount >= 1) — that marker is stale, not a resume point;
 *  - markers below `minMs`, which are "never really started" rather than a place to return to.
 *    This is what stops a 9-second marker yanking the viewer past the opening seconds, and it
 *    is why the owner's "starts just after the intro" cases don't come back as tiny seeks;
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
}

export const armedCount = () => ARMED.plan.size;

// Where to send the seek — the device/set the current plan was armed for.
export const target = () => ({ device: ARMED.device, setName: ARMED.setName });

/**
 * Handle one now-playing payload. Returns the ms to seek to, or null for "do nothing".
 *
 * Fires at most ONCE per ratingKey per session: HA republishes now-playing on every state
 * change (pause, resume, buffering), and re-seeking on each would drag the viewer back to the
 * marker every time they paused. First sighting is also the only moment the seek is
 * unambiguous — later ones may be legitimate manual scrubbing.
 */
export function onNowPlaying(payload) {
  if (!payload || payload.ratingKey == null) return null;
  if (payload.state && payload.state !== 'playing') return null;
  const rk = String(payload.ratingKey);
  if (ARMED.seen.has(rk)) return null;
  ARMED.seen.add(rk); // mark regardless, so a non-planned item is not reconsidered later
  const ms = ARMED.plan.get(rk);
  return ms != null && ms > 0 ? ms : null;
}

export const _internals = { ARMED };

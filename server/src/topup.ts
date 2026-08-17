// Top-up: keep a `refill: true` lineup filled instead of letting it end.
//
// The owner's ask (2026-08-17), after the kids' Shorts card ran dry mid-evening:
//
//   "I thought we programmed it to keep going forever. So it'd load up X number in the queue,
//    and then add more as you started getting close to the end of the queue."
//
// WHO DECIDES WHAT. An HA automation publishes `queuepilot/cmd/topup` on a dumb interval
// while something is playing — that keeps the schedule HA's, per the workspace rule, and
// means no cron and no in-app poll loop. The tick is a WAKE-UP, not an instruction: every
// judgement about whether the lineup is actually low, and by how much, is made here.
//
// WHAT IT MEASURES. The LIVE playQueue, never `SESSION.queue`. The session remembers what it
// SENT; the viewer has been skipping around in it since, and a top-up that trusts the sent
// lineup tops up a queue that is nowhere near empty (or misses one that is).
//
// WHY IT DOES NOT REBUILD. `extendPlayQueue` appends to the live queue and keeps its id, so
// playback is untouched. Rebuilding would restart the Shield mid-episode, which is the whole
// thing this exists to avoid. See the spike note on `extendPlayQueue` for the one wart: Plex
// inserts after the CURRENT item, not at the tail, which is why TOPUP_AT is small.
import * as playback from './playback.js';
import { SESSION } from './session.js';
import { providerFor } from './providers/index.js';
import { providerIdForSet } from './providers/blocks.js';
import * as routing from './engine/routing.js';
import { isTargetMet, needsTopup, playbackLength } from './engine/playbackLength.js';
import { ROTATION_LENGTH, TOPUP_AT, TOPUP_COOLDOWN_SECONDS } from './env.js';
import { errMessage } from './errors.js';
import type { BlockSourceCfg } from './providers/blocks.js';
import type { PlexPlayItem } from './types.js';

/** What a tick did, for the `resp/topup` reply and the log. `added: 0` is a normal answer. */
export interface TopupResult {
  ok: boolean;
  /** Why nothing happened, when nothing happened. Absent on a real top-up. */
  reason?: string;
  set?: string | null;
  /** Items actually appended (Plex's own count of what it accepted, not what we asked for). */
  added?: number;
  /** What was left ahead of the viewer when we looked. */
  remaining?: number;
  error?: string;
}

// Last successful top-up, so a stuck (or duplicated) HA automation cannot walk the lineup up
// one tick at a time. Module state and not SESSION state: it is about THIS process's recent
// behaviour, not about what is playing, and a new scan should not license an instant top-up.
let lastTopupMs = 0;

/** Test seam — reset the cooldown between cases. Not called in production. */
export function _resetCooldown(): void { lastTopupMs = 0; }

/**
 * The two collaborators a test replaces. Injected rather than imported-and-stubbed because
 * ESM namespace objects are frozen — `Object.assign(mod, fake)` throws — and because this is
 * already the house pattern (`resume.startWatch` takes its `fetchSession`/`seek` the same
 * way). Defaulted to the real modules, so production call sites pass nothing.
 */
export interface TopupDeps {
  readPlayQueue: typeof playback.readPlayQueue;
  extendPlayQueue: typeof playback.extendPlayQueue;
  providerFor: typeof providerFor;
}

const REAL_DEPS: TopupDeps = {
  readPlayQueue: (...args) => playback.readPlayQueue(...args),
  extendPlayQueue: (...args) => playback.extendPlayQueue(...args),
  providerFor: (...args) => providerFor(...args),
};

/**
 * Run one top-up tick.
 *
 * Every early return is a NO-OP with a reason, never a throw: this runs on a background tick
 * nobody is watching, and a tick that throws would surface as an MQTT timeout in HA rather
 * than as anything actionable.
 */
export async function topup(
  { now = Date.now(), deps = REAL_DEPS }: { now?: number; deps?: TopupDeps } = {},
): Promise<TopupResult> {
  const setName = SESSION.set;
  if (!setName) return { ok: true, reason: 'no active session' };

  // Cooldown BEFORE any network read: the cheapest guard, and the one that still holds when
  // Plex is slow or the playQueue read is flaky.
  const sinceMs = now - lastTopupMs;
  if (lastTopupMs && sinceMs < TOPUP_COOLDOWN_SECONDS * 1000) {
    return { ok: true, set: setName, reason: `cooling down (${Math.round(sinceMs / 1000)}s of ${TOPUP_COOLDOWN_SECONDS}s)` };
  }

  const cfg = routing.loadSets()?.sets?.[setName];
  if (!cfg) return { ok: true, set: setName, reason: 'set not in registry' };
  if (cfg.source !== 'rotation') return { ok: true, set: setName, reason: 'not a rotation channel' };
  // The opt-in. A channel that has not asked to refill is ALLOWED to end — that is what a
  // fixed `length:` means, and topping it up anyway would silently delete that choice.
  // DERIVED from the playback length, never a stored flag of its own (owner, 2026-08-17). A
  // lineup needs topping up exactly when it wants more items than one window holds: every
  // `infinite` pool, and a Custom above the window. A pool at 1 or 8 never gets here, which is
  // what makes "plays N and stops" mean it.
  const target = playbackLength(cfg);

  if (!needsTopup(target)) {
    return { ok: true, set: setName, reason: `plays ${target} — nothing to top up` };
  }

  // A FINITE target that has already been handed everything it asked for is done, and topping
  // it up anyway would silently delete the owner's choice of how long the sitting is.
  if (isTargetMet(target, SESSION.queuedTotal)) {
    return { ok: true, set: setName, reason: `target of ${target} already queued` };
  }

  // The SAME provider + binding the scan used, resolved the same way `startSession` does —
  // a top-up that selected as a different account would queue the wrong kid's next episodes.
  const provider = deps.providerFor(providerIdForSet(cfg as unknown as BlockSourceCfg));
  let binding = routing.bindingFor(cfg, SESSION.profile);
  if (typeof provider.profileBinding === 'function') {
    binding = await provider.profileBinding(binding, SESSION.profile);
  }
  const token = (await provider.profileToken?.(binding.user_uuid)) ?? null;
  // How far ahead to stay. Capped by what is LEFT of a finite target, so a pool at 20 tops up
  // to exactly 20 and then stops rather than rounding up to a whole window.
  const window = target == null
    ? ROTATION_LENGTH
    : Math.max(1, Math.min(ROTATION_LENGTH, target - SESSION.queuedTotal));
  const buildLineup = async () => {
    const res = await provider.buckets({
      setName, cfg, binding, token, kind: cfg.kind || undefined, lastMovieRk: SESSION.lastMovieRk,
    });
    return res?.play || [];
  };

  // PULL provider (Kavita): the artifact is a persistent reading list, not a playQueue, and
  // the provider owns both the append and the trim. There is no session to measure against —
  // "how much is left" is the list's own unread count, read on demand at this tick.
  if (typeof provider.topupList === 'function') {
    let res: Awaited<ReturnType<NonNullable<typeof provider.topupList>>>;
    try {
      res = await provider.topupList({
        setName, setLabel: cfg.label || setName, window, at: TOPUP_AT, build: buildLineup,
      });
    } catch (e) {
      return { ok: false, set: setName, error: `list top-up failed: ${errMessage(e)}` };
    }
    // The cooldown is only spent when something actually landed, so a run of "already full"
    // ticks does not lock out the tick that finally matters.
    if (res.added) lastTopupMs = now;
    console.log(`[topup] ${setName}: reading list +${res.added ?? 0}, trimmed ${res.trimmed ?? 0}`
      + `${res.reason ? ` (${res.reason})` : ''}`);
    return { ok: res.ok, set: setName, added: res.added ?? 0, remaining: res.unread, reason: res.reason };
  }

  if (SESSION.playQueueID == null) return { ok: true, set: setName, reason: 'no live playQueue' };

  const live = await deps.readPlayQueue(SESSION.playQueueID, { token });
  // Plex has forgotten the queue (restart, expiry) — nothing to extend, and building a new
  // one here would start playback on a device nobody asked to wake.
  if (!live) return { ok: true, set: setName, reason: 'playQueue gone' };

  if (live.remaining > TOPUP_AT) {
    return { ok: true, set: setName, remaining: live.remaining, reason: `${live.remaining} left, tops up at ${TOPUP_AT}` };
  }

  // Refill back to the WINDOW. `length` stops meaning "the evening" on a refilling channel and
  // starts meaning "how far ahead to stay" — so the ask is the window minus what is left, not
  // a whole fresh window on top of it.
  const want = Math.max(0, window - live.remaining);
  if (!want) return { ok: true, set: setName, remaining: live.remaining, reason: 'window already full' };

  // Ask for a fresh lineup and subtract what is ALREADY in the live queue — including items
  // the viewer has already passed. Re-adding a short they watched ten minutes ago is the most
  // visible way this feature can look broken, and the rotation builder has no idea what is
  // currently queued: it answers "what should this channel play", not "what is queued".
  const already = new Set(live.ratingKeys.map(String));
  let built: PlexPlayItem[];
  try {
    built = (await buildLineup()) as PlexPlayItem[];
  } catch (e) {
    return { ok: false, set: setName, error: `lineup build failed: ${errMessage(e)}` };
  }
  const fresh = built.map((it) => String(it.ratingKey)).filter((rk) => rk && rk !== 'undefined' && !already.has(rk));
  if (!fresh.length) {
    // Genuinely out of material: every eligible item is already queued. On a channel with
    // `on_complete: restart` this should not happen; on the default (drop) it is the honest
    // end of the line, and the lineup is allowed to finish.
    return { ok: true, set: setName, remaining: live.remaining, added: 0, reason: 'nothing eligible left to add' };
  }

  const slice = fresh.slice(0, want);
  let sizeAfter: number | null;
  try {
    sizeAfter = await deps.extendPlayQueue(SESSION.playQueueID, slice, { token });
  } catch (e) {
    return { ok: false, set: setName, error: `extend failed: ${errMessage(e)}` };
  }
  lastTopupMs = now;
  // Plex silently drops keys the playing token cannot see, so report what the queue GREW by,
  // not what we handed it. A persistent 0 here is the wrong-account symptom, not a quiet
  // success — the create path learned the same lesson.
  const added = sizeAfter == null ? slice.length : Math.max(0, sizeAfter - live.ratingKeys.length);
  // Against the ACCEPTED count, not what we asked for: a finite target must not be spent on
  // keys Plex silently dropped, or a pool at 20 would stop early and blame itself.
  SESSION.queuedTotal += added;
  console.log(`[topup] ${setName}: ${live.remaining} left -> added ${added} (asked ${slice.length}), queue now ${sizeAfter ?? '?'}`);
  return { ok: true, set: setName, remaining: live.remaining, added };
}

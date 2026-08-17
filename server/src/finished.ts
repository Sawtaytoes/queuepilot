// "Finished" is ONE rule with two consumers, and this file owns both of them.
//
// The rule (decision 2026-08-15-a-done-entry-revives-when-there-is-something-to-play): a
// curated entry is finished when its live resolution comes back EMPTY, which is what
// `nextQueue` reports as `newlyDone` and `queues.markDone` persists as `done: true`.
//
// What was missing is WHEN it got evaluated. `markDone` had exactly one caller —
// `session.startSession` — so the rule ran on a session START and nowhere else: a movie
// finished at 22:34 kept its plain tile, greyed nothing and said nothing, until the card was
// tapped again (evidence: "2001: A Space Odyssey", bob_alice, 2026-08-16 — Plex had
// `viewCount: 1` and a history row; `queues.yaml` had a bare entry and `/api/queues` said
// `done: false` for all 21). Two evaluations are added, both here:
//
//   * `reconcileQueue()` — the write side re-runs when PLAYBACK ENDS, not only when it
//     starts, so `queues.yaml` agrees with Plex seconds after the credits. It is the same
//     `applyQueueWriteSide()` a scan runs, over the same provider `buckets()` resolution;
//     the only thing it does not do is play anything.
//   * `watchedFor()` — the same watched-history source the ENGINE judges a movie by, so
//     `/api/queues` can report `isFinished` live and the badge is right the moment you look,
//     including for something watched outside QueuePilot (a phone, a laptop).
//
// The persisted flag stays the record of truth for everything that WRITES (the TTL sweep,
// "Remove all completed"); `isFinished` only ever tells the grid what the next scan will
// decide.
import * as cache from './cache.js';
import { liveClient } from './engine/plex-live.js';
import * as routing from './engine/routing.js';
import * as select from './engine/select.js';
import { WATCH_COUNT_ACCOUNTS } from './env.js';
import { errMessage } from './errors.js';
import * as mqttc from './mqttc.js';
import { providerFor } from './providers/index.js';
import { providerIdForSet, type BlockSourceCfg } from './providers/blocks.js';
import * as queues from './queues.js';
import * as sets from './sets.js';
import { SESSION } from './session.js';
import type {
  BucketsResult, EngineBinding, NowPlaying, RoutingQueueCfg, RoutingSetCfg,
} from './types.js';

/**
 * How long a set's watched-history read is reused. It is refetched on demand, so this only
 * bounds a REFRESH STORM (`/api/queues` is `no-store` and the grid refetches on tab focus,
 * on reconnect and on every SSE `data`): one history fan-out per minute per
 * accounts×sections, shared by every set that names the same pair. Playback moving the
 * watched state does not wait for it — `watchPlaybackEnd()` drops the memo on the same
 * now-playing event it reconciles from.
 */
const WATCHED_TTL_MS = 60 * 1000;

/** How long after playback ends before the queue is reconciled — see `watchPlaybackEnd()`. */
const RECONCILE_DELAY_MS = 5000;

interface WatchedMemo {
  at: number;
  value: Promise<Set<string>>;
}

const _watched = new Map<string, WatchedMemo>();

/** Drop every memoized watched-history read (playback ended, or a scan just wrote). */
export function forgetWatched(): void {
  _watched.clear();
}

/**
 * The watched ratingKeys a scan of this set would judge by: `select.watchedForSet`, memoized
 * on (accounts × sections) rather than on the set, because that pair is what the fan-out
 * actually reads — every one of Bob's curated queues names the same one, so they share a
 * single read.
 *
 * The PROMISE is memoized, not the resolved set, so N concurrent tiles asking at once make
 * one history fan-out rather than N. A failed read is not cached.
 */
export async function watchedFor(
  cfg: RoutingSetCfg,
  binding: EngineBinding | null | undefined,
): Promise<Set<string>> {
  const accts = (binding && binding.watch_count_accounts) || WATCH_COUNT_ACCOUNTS;
  const key = `${accts.join(',')}|${routing.setSections(cfg).join(',')}`;
  const memo = _watched.get(key);
  if (memo && Date.now() - memo.at < WATCHED_TTL_MS) return memo.value;
  const value = select.watchedForSet(liveClient(), cfg, binding).catch((e: unknown) => {
    // A history read that failed must never make the grid claim things are finished, and
    // must not stick: drop it so the next request retries.
    console.log(`[finished] watched history unavailable (${errMessage(e)})`);
    _watched.delete(key);
    return new Set<string>();
  });
  _watched.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Persist what a resolution just decided: revive stale-done entries, mark the newly-finished
 * ones, then sweep whatever has aged out.
 *
 * Lifted VERBATIM out of `session.startSession` so a scan and a reconcile cannot drift —
 * including the two gates that read oddly and are deliberate: a `reel` writes nothing at all
 * (so it is exempt from the TTL sweep by construction), and a `keep_completed` set still
 * revives and sweeps but never marks
 * (decision 2026-08-07-non-consuming-keep-completed-queue-flag).
 */
export async function applyQueueWriteSide(
  setName: string,
  cfg: RoutingQueueCfg,
  res: BucketsResult,
): Promise<{ marked: number }> {
  if (cfg.reel) return { marked: 0 };
  if (Array.isArray(res.revived) && res.revived.length) {
    await queues.clearDone(setName, res.revived);
  }
  const newly = res.newlyDone || [];
  const isMarking = Boolean(newly.length) && !cfg.keep_completed;
  if (isMarking) {
    await queues.markDone(setName, newly);
  }
  await queues.sweepCompleted(setName, {
    keepCompleted: Boolean(cfg.keep_completed),
    reel: Boolean(cfg.reel),
    removeCompletedAfter: cfg.remove_completed_after,
  });
  return { marked: isMarking ? newly.length : 0 };
}

/**
 * Re-run the write side for one curated set WITHOUT playing anything.
 *
 * Everything a scan does to decide what is finished — `provider.buckets()` over the set's own
 * binding and token — and nothing it does to deliver it. Silent and best-effort: this runs
 * off a playback event nobody asked for, so a Plex hiccup logs and leaves the file alone.
 */
export async function reconcileQueue(
  setName: string,
  profileTitle: string | null = null,
): Promise<{ reconciled: boolean }> {
  const reg = routing.loadSets();
  const cfg = reg && reg.sets[setName];
  // Only a CURATED queue has entries to mark. A rotation channel's lineup is computed, and a
  // reel writes nothing by rule.
  if (!cfg || cfg.enabled === false || cfg.source !== 'queue' || cfg.reel) return { reconciled: false };
  try {
    const binding = routing.bindingFor(cfg, profileTitle);
    const provider = providerFor(providerIdForSet(cfg as unknown as BlockSourceCfg));
    // Same unguarded call as `startSession` — a provider with no `profileToken` throws here
    // and is caught below rather than silently reconciling under the wrong account.
    const token = await provider.profileToken!(binding.user_uuid);
    const res = await provider.buckets({ setName, cfg, binding, token, kind: 'movie' });
    const { marked } = await applyQueueWriteSide(setName, cfg, res);
    // The history that decided this just moved, and so did the file. Neither memo may serve
    // the pre-playback answer to the refresh this reconcile is about to trigger.
    forgetWatched();
    await cache.bumpGeneration();
    if (marked) console.log(`[finished] ${setName}: marked ${marked} finished after playback`);
    return { reconciled: true };
  } catch (e) {
    console.log(`[finished] reconcile of '${setName}' skipped (${errMessage(e)})`);
    return { reconciled: false };
  }
}

/** True once the now-playing payload is showing a real item rather than an idle player. */
function isOnScreen(now: NowPlaying | null): boolean {
  if (!now || !now.ratingKey) return false;
  return now.state === 'playing' || now.state === 'paused' || now.state === 'buffering';
}

/**
 * Reconcile the active set whenever an item leaves the screen.
 *
 * The end of playback is the moment Plex writes the history row this all keys off, and HA's
 * "Queuepilot Now Playing" bridge reports it as the retained payload going `idle` (or the
 * ratingKey changing, when a queue auto-advances). Both are "that item is over".
 *
 * The delay is not a guess about the network: Plex scrobbles as the credits run, and the
 * media_player state can beat the history row there by a second or two. Waiting also
 * collapses the idle→playing flicker of an auto-advance into one reconcile.
 *
 * WHICH set is read off the retained `queuepilot/state` topic rather than the in-process
 * session, so a server restarted mid-movie still reconciles the set that is actually playing.
 */

/**
 * Announce that a sitting ended, and whether the set wants the room shut down.
 *
 * Read off the SESSION rather than the queue: "plays 8 and stops" means eight items HANDED
 * OVER, and a viewer who skipped four of them still got eight. `isComplete` separates the two
 * endings an automation might treat differently — the length was reached, or the pool ran out
 * early — so a lights-out rule need not fire on a channel that simply had nothing left.
 */
function announceFinished(): void {
  const setName = SESSION.set;

  if (!setName) return;

  const target = SESSION.target;

  void (async () => {
    // Read at announce time, not cached at start: the owner may have toggled it mid-sitting,
    // and this is one YAML read against a file the registry already caches.
    const entry = await sets.getSet(setName).catch(() => null);
    _publishFinished({
      isComplete: target != null && SESSION.queuedTotal >= target,
      played: SESSION.queuedTotal,
      power_off: Boolean(entry && (entry as { power_off_when_done?: boolean }).power_off_when_done),
      set: setName,
      target,
    });
  })();
}

/** Set by mqttd, so this module announces without importing the broker. */
let _publishFinished: (payload: FinishedPayload) => void = () => {};

export function setFinishedPublisher(fn: (payload: FinishedPayload) => void): void {
  _publishFinished = fn;
}

/** The `resp/finished` payload — one SITTING ending, not one item. */
export interface FinishedPayload {
  set: string | null;
  /** How many items this sitting handed over in total. */
  played: number;
  /** The playback length it was running under; null = infinite. */
  target: number | null;
  /** True when a finite target was actually reached, false when the pool simply ran dry. */
  isComplete: boolean;
  /** The set asked for the room to be shut down. A REQUEST for HA, never an action here. */
  power_off: boolean;
}

export function watchPlaybackEnd(): void {
  let wasOn: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  mqttc.onNowPlaying((now: NowPlaying | null) => {
    const nowRk = isOnScreen(now) ? String(now!.ratingKey) : null;
    const ended = wasOn && wasOn !== nowRk;
    // NOTHING is on screen now, and something was a moment ago — the SITTING ended, as
    // opposed to one item ending and the next starting (which is `ended` with a new `nowRk`).
    const isIdle = Boolean(wasOn) && nowRk == null;
    wasOn = nowRk;
    if (isIdle) announceFinished();
    if (!ended) return;
    const state = mqttc.lastState();
    const setName = state && state.set ? String(state.set) : null;
    if (!setName) return;
    const profile = state && state.profile ? String(state.profile) : null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void reconcileQueue(setName, profile);
    }, RECONCILE_DELAY_MS);
  });
}

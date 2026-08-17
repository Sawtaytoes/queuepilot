// In-process session start: the sole implementation since Python was removed (2026-08-12).
//
// Selection and delivery both go through a PROVIDER (./providers) rather than a Plex client:
// buckets() produces the lineup, materialize() builds the runtime artifact, handoff() starts
// it — pushing a playQueue at the Shield on Plex, or returning a URL to open on a pull
// provider like Kavita. Nothing in this file may branch on which backend it is talking to.
//
// The queue write-side (markDone/clearDone/sweepCompleted) is provider-neutral — it is about
// entries in the shared queues.yaml recipe store being finished, not about Plex — and it now
// lives in finished.js, which runs it from here on a session START and again when PLAYBACK
// ENDS. This file still owns WHEN a scan happens; it no longer owns the rule.
import * as routing from './engine/routing.js';
import { playbackLength } from './engine/playbackLength.js';
import * as finished from './finished.js';
import { providerFor } from './providers/index.js';
import { providerIdForSet, type BlockSourceCfg } from './providers/blocks.js';
import * as profiles from './profiles.js';
import * as adb from './adb.js';
import * as playback from './playback.js';
import * as driver from './driver.js';
import * as resume from './resume.js';
import {
  PLAYBACK_FSM, ADB_ENABLED, RESUME_ON_ADVANCE,
} from './env.js';
import { errMessage, isCancelled } from './errors.js';
import type {
  CancelFlag, Device, HandoffResult, PlayItem, PlexPlayItem,
  ProviderArtifact, PublishedStateExtra, SessionStartPayload, SessionState,
} from './types.js';

/**
 * One lineup item as the SESSION holds it, once the play items have been flattened.
 *
 * LATENT BUG, encoded rather than fixed (see `PlayItem` in types.ts): this shape is
 * Plex-only. It is built with `String(it.ratingKey)` and `it.season`/`it.episode`, and a
 * Kavita play item has none of the three — so a pull-provider lineup would land here as
 * `ratingKey: 'undefined'` with the rest missing. Unreachable today because the pull path
 * never runs through `startSession`; the optional fields are what keep the gap visible.
 */
interface SessionQueueItem {
  ratingKey: string;
  title?: string | undefined;
  season?: number | null | undefined;
  episode?: number | null | undefined;
}

/** The mutable module-level singleton. Declared as an interface so `this` inside `asDict()`
 * is the session itself — it is a real method, NOT an arrow function, and typing it as one
 * would break the `this` it reads. */
interface SessionSingleton {
  kind: string | null;
  set: string | null;
  profile: string | null;
  queue: SessionQueueItem[];
  cursor: number;
  lastMovieRk: string | null;
  userUuid: string | null;
  /**
   * The LIVE playQueue this session pushed, so a later top-up can extend the queue the
   * viewer is actually in rather than building a second one.
   *
   * Set from the handoff result, which is the only place the id exists — `materialize()`
   * returns a descriptor and `createPlayQueue` runs inside the fused handoff. Null on a pull
   * provider (Kavita has no playQueue; its artifact is a reading list) and null before the
   * first scan.
   */
  playQueueID: number | string | null;
  /**
   * How many items this session has handed the viewer in total — the initial lineup plus every
   * top-up since. The counter a FINITE playback length is measured against.
   *
   * Counted rather than read off the live playQueue, because those answer different questions:
   * the playQueue is what is still THERE, and a viewer who skipped four shorts has been given
   * four items the queue no longer holds. "Plays 8 and stops" means eight handed over, not
   * eight surviving.
   */
  queuedTotal: number;
  /**
   * The playback length this session started under, so the finish event can say whether the
   * sitting reached its end or merely ran out of material. Null = infinite.
   */
  target: number | null;
  asDict(this: SessionSingleton): SessionState;
}

/** The retained `queuepilot/resp/last-played` payload — `lastPlayedFromItem()`'s return, and
 * what `mqttd.js publishLastPlayed()` puts on the wire. Exported so that publisher's
 * parameter is this type rather than a second hand-written copy of it. */
export interface LastPlayed {
  title: string | null;
  type: string;
  ratingKey: string | null;
}

/** The `extra` half of a state publish: everything a caller may merge on top of `asDict()`.
 * `engine` is stamped by the publisher, and `boot` is mqttd's own connect marker.
 *
 * An alias of the shared `PublishedStateExtra` (types.ts) — it was an identical hand-written
 * copy, as were mqttd's and driver's, which is what let the driver's copy grow an argument
 * the publisher never took. The name stays because the e2e harnesses import it. */
export type SessionStateExtra = PublishedStateExtra;

export type PublishState = (extra: SessionStateExtra) => void;
export type PublishLastPlayed = (item: LastPlayed | null) => void;

/**
 * What `startSession()` hands back: one of its own early-outs, or the handoff result
 * verbatim (which is how a cancelled/failed play propagates without being re-wrapped).
 */
export type SessionResult =
  | { cancelled: true }
  | { error: string }
  | { ok: true; playback: HandoffResult; set: string; count: number }
  | HandoffResult;

// Mutable session (mirrors service.Session) for advance + last-played.
export const SESSION: SessionSingleton = {
  kind: null,
  set: null,
  profile: null,
  queue: [],
  cursor: 0,
  lastMovieRk: null,
  // The active binding's managed-user uuid, so the LATER calls on this session (resume seek,
  // advance) drive playback as the same account the lineup was selected as.
  userUuid: null,
  playQueueID: null,
  queuedTotal: 0,
  target: null,
  asDict() {
    return {
      kind: this.kind, set: this.set, profile: this.profile,
      queue_len: this.queue.length, cursor: this.cursor,
    };
  },
};

let _publishState: PublishState = () => {};
let _publishLastPlayed: PublishLastPlayed = () => {};
export function setPublishers(
  { state, lastPlayed }: { state?: PublishState; lastPlayed?: PublishLastPlayed } = {},
): void {
  if (state) _publishState = state;
  if (lastPlayed) _publishLastPlayed = lastPlayed;
  // The SAME publisher the session uses, handed to the driver so the FSM path's mid-flight
  // "awaiting" reaches the state topic. `?? null` only because driver's setter is typed
  // `PublishStateFn | null`; it stored the undefined before and guards with a truthiness test
  // either way, so nothing changes. No cast: both sides are `PublishedStateExtra` now, which
  // is what makes an arity slip here a compile error rather than a silent dropped payload.
  driver.setPublishState?.(state ?? null);
}

function cancelFlag(): Required<CancelFlag> {
  let isRaised = false;
  return {
    is_set: () => isRaised,
    isSet: () => isRaised,
    set: () => { isRaised = true; },
    clear: () => { isRaised = false; },
  };
}

// Only one start in flight; a newer start cancels the prior.
let _activeCancel: CancelFlag | null = null;

function lastPlayedFromItem(item: PlayItem | null | undefined): LastPlayed | null {
  if (!item) return null;
  // A Plex-shaped VIEW of a lineup item, every field optional: `show`, `type`, `season` and
  // `ratingKey` exist on `PlexPlayItem` only, and reading them off a Kavita item yields
  // undefined at runtime — which is exactly what the original expression did. See `PlayItem`.
  const it = item as Partial<PlexPlayItem>;
  return {
    title: it.title || it.show || null,
    type: it.type || (it.season != null ? 'episode' : 'movie'),
    ratingKey: it.ratingKey != null ? String(it.ratingKey) : null,
  };
}

/**
 * Start a session from an MQTT/API payload.
 */
export async function startSession(
  payload: SessionStartPayload = {},
  opts: { cancel?: CancelFlag } = {},
): Promise<SessionResult> {
  // `.set!` rather than `.set?.()`: a flag without `set` is a caller error and threw here
  // before, and swallowing it would leave the previous start running.
  if (_activeCancel) _activeCancel.set!();
  const cancel = opts.cancel || cancelFlag();
  _activeCancel = cancel;

  if (ADB_ENABLED) {
    try { await adb.ensurePlexOpen(); } catch (e) {
      console.log(`[session] ensurePlexOpen: ${errMessage(e)}`);
    }
  }

  const kind = payload.kind || 'cartoons';
  let setName: string | null = payload.set || 'auto';
  const cardProfile = payload.profile || null;
  // "Play THIS entry" — an entry key from the web grid's per-tile ▶, narrowing the lineup to
  // one member of a curated queue/channel. Everything else about the start is unchanged: the
  // same profile gate, the same device, the same resume/mark-done bookkeeping. A physical
  // card never sends it; it only ever arrives from the UI.
  const only = payload.only ? String(payload.only) : null;
  const isAuto = setName === 'auto' || setName === '' || setName == null;
  let profileTitle: string | null = null;
  let detectedProfile: string | null = null;

  // NOTE (found, not fixed): `loadSets()` returns null for "keep the current sets" — the file
  // was absent, unreadable or empty — and this function has never handled that; it reads
  // `reg.sets` straight away and throws. The `!` preserves that exactly rather than inventing
  // an error path that mqttd would then publish differently.
  const reg = routing.loadSets();

  if (isAuto) {
    _publishState({ awaiting: 'profile', ...SESSION.asDict() });
    const title = await profiles.waitForProfile({ cancel, match: null });
    if (isCancelled(cancel)) return { cancelled: true };
    if (!title) {
      _publishState({ error: 'no profile is signed in on the Shield. Open Plex and pick one.', ...SESSION.asDict() });
      return { error: 'no profile' };
    }
    profileTitle = detectedProfile = title;
    setName = routing.channelFor(kind, title, reg!) || profiles.setForProfile(title);
    if (!setName) {
      _publishState({ error: `profile '${title}' has no set mapped`, ...SESSION.asDict() });
      return { error: 'no set' };
    }
    console.log(`[session] '${title}' + kind '${kind}' -> set '${setName}'`);
  } else {
    profileTitle = cardProfile;
  }

  const cfg = reg!.sets[setName];
  if (!cfg || cfg.enabled === false) {
    _publishState({ error: `set '${setName}' not enabled`, ...SESSION.asDict() });
    return { error: 'disabled' };
  }

  let required: string | null = cfg.requires_profile || null;
  if (required && cardProfile && cardProfile !== required && !isAuto) {
    _publishState({
      error: `card asks for profile '${cardProfile}' but set '${cfg.label || setName}' requires '${required}'`,
      ...SESSION.asDict(),
    });
    return { error: 'profile mismatch' };
  }
  if (!required && !isAuto) required = cardProfile;

  if (PLAYBACK_FSM) {
    if (required && !profileTitle) profileTitle = required;
  } else if (required && detectedProfile !== required) {
    _publishState({ awaiting: `profile:${required}`, ...SESSION.asDict() });
    // Best-effort ADB switch in background + log wait
    const switchP = ADB_ENABLED
      ? adb.switchTo(required, cancel, null).catch((e: unknown) => [false, errMessage(e)])
      : Promise.resolve([false, 'ADB off']);
    const title = await profiles.waitForProfile({ cancel, match: required });
    if (isCancelled(cancel)) return { cancelled: true };
    if (!title) {
      const [, why] = await switchP;
      if (why) console.log(`[session] gate failed for '${required}' (${why})`);
      _publishState({
        error: `'${cfg.label || setName}' needs the '${required}' Plex profile, and the Shield did not switch to it. Pick it on the TV.`,
        ...SESSION.asDict(),
      });
      return { error: 'profile gate' };
    }
    profileTitle = detectedProfile = title;
  }

  // The engine no longer holds a Plex client — it holds a PROVIDER (decision
  // 2026-08-12-backends-are-providers-behind-a-media-neutral-seam). Everything Plex-shaped
  // (MediaContainer, ratingKeys, managed-user tokens) is now private to providers/plex.js.
  // Today every set resolves to the Plex provider, so this is a rewrap with no behaviour
  // change; the gates are what prove that.
  // A `RoutingSetCfg` IS a block source; it just isn't assignable to `BlockSourceCfg`'s
  // index signature, which an interface never gets implicitly. The cast is that rule, not a
  // shape change.
  const provider = providerFor(providerIdForSet(cfg as unknown as BlockSourceCfg));
  // `bindingFor` can only read what the SET stores, and a curated queue stores no account —
  // just `requires_profile`, a display name. Left at that, the queue selected its lineup as
  // the OWNER (env WATCH_COUNT_ACCOUNTS + the admin token) however it was gated. The provider
  // fills the account in, because a name -> an accountID is a provider fact; a binding that
  // already names one (every rotation channel) comes back untouched.
  let binding = routing.bindingFor(cfg, profileTitle);
  if (typeof provider.profileBinding === 'function') {
    binding = await provider.profileBinding(binding, profileTitle);
  }
  SESSION.kind = kind;
  SESSION.set = setName;
  SESSION.profile = profileTitle;
  SESSION.cursor = 0;
  SESSION.userUuid = binding.user_uuid || null;
  let resumeMs = 0;
  let playItems: PlayItem[] = [];

  // UNGUARDED on purpose, and the `!` says so: `profileToken` is OPTIONAL on the `Provider`
  // interface (every other optional member is called behind a `typeof … === 'function'`
  // check), but this call site has never had one. A push provider without it throws right
  // here — a latent requirement of the push path, not of the interface. Adding a guard would
  // change behaviour, so the assertion preserves the throw instead.
  const tok = await provider.profileToken!(binding.user_uuid);

  const res = await provider.buckets({
    setName, cfg, binding, token: tok, kind, lastMovieRk: SESSION.lastMovieRk, only,
  });

  if (cfg.source === 'queue') {
    // D4 write-side: persist finished + revive stale-done + TTL sweep. This stays ABOVE the
    // seam on purpose — it is about entries in the shared queues.yaml recipe store being
    // finished, not about Plex, so a second provider reuses it verbatim.
    //
    // It now lives in finished.js because a session START is no longer the only thing that
    // runs it: the end of PLAYBACK reconciles the same set the same way, so the file agrees
    // with Plex without waiting for the next scan. One copy, so the two cannot drift.
    await finished.applyQueueWriteSide(setName, cfg, res);
    if (res.done?.length) console.log(`[session] ${setName} finished (kept): ${res.done}`);
    if (res.unresolved?.length) console.log(`[session] ${setName} unresolved: ${res.unresolved}`);
    if (!res.play?.length) {
      // A one-entry start fails for its own reasons, and "add entries to queues.yaml" is the
      // wrong advice for every one of them — the queue is fine, this entry is not.
      const why = res.unknownEntry
        ? `'${setName}' has no entry ${res.unknownEntry} any more — it was removed or renamed. Reload the page.`
        : only
          ? `that entry in '${cfg.label || setName}' has nothing left to play — it is fully watched, or it no longer resolves in the library.`
          : `queue '${setName}' has nothing to play (empty, or every entry watched - add entries to queues.yaml)`;
      _publishState({ error: why, ...SESSION.asDict() });
      return { error: only ? 'empty entry' : 'empty queue' };
    }
    playItems = res.play;
    resumeMs = res.offset || 0;
    if (res.last) _publishLastPlayed(lastPlayedFromItem(res.last));
  } else if (res.rewatch) {
    if (!res.play?.length) {
      _publishState({ error: 'no rewatch candidate found for this profile', ...SESSION.asDict() });
      return { error: 'no rewatch' };
    }
    playItems = res.play;
    // Same Plex-shaped read as everywhere else on this path (see `SessionQueueItem`):
    // `ratingKey` is `string | number` on a Plex item and absent on a Kavita one, while
    // `lastMovieRk` and `BucketsContext.lastMovieRk` are `string | null`. Assigned verbatim,
    // as before — the cast records the mismatch rather than coercing it away.
    SESSION.lastMovieRk = (playItems[0] as Partial<PlexPlayItem>).ratingKey as unknown as string;
    _publishLastPlayed(lastPlayedFromItem(playItems[0]));
  } else {
    if (!res.play?.length) {
      _publishState({ error: `channel '${setName}' has nothing unwatched to play`, ...SESSION.asDict() });
      return { error: 'empty rotation' };
    }
    playItems = res.play;
    _publishLastPlayed(lastPlayedFromItem(playItems[0]));
  }

  // max_items cap
  const cap = cfg.max_items;
  if (typeof cap === 'number' && cap > 0) playItems = playItems.slice(0, cap);

  // The Plex-only read the `PlayItem` union exists to make visible: `String(it.ratingKey)` is
  // `'undefined'` for a Kavita item and `season`/`episode` are simply absent. Left exactly as
  // it was — the pull path does not reach `startSession`, so this stays unreachable.
  SESSION.queue = playItems.map((item) => {
    const it = item as Partial<PlexPlayItem>;
    return {
      ratingKey: String(it.ratingKey),
      title: it.title,
      season: it.season,
      episode: it.episode,
    };
  });

  // A scan STARTS a sitting, so the running total restarts with it — a top-up adds to this,
  // and a finite playback length is met when it reaches the target.
  SESSION.queuedTotal = SESSION.queue.length;
  SESSION.target = playbackLength(cfg);

  const ratingKeys = SESSION.queue.map((q) => q.ratingKey);
  // LATENT BUG (types.ts `SessionStartPayload.target`): this is EITHER a resolved device (the
  // MQTT path, where mqttd.js swapped the id for the announced entry) OR a bare registry-id
  // string (any caller that skips mqttd), and playback/driver read `.uri`/`.mode`/`.name` off
  // it either way. The union is the honest type; resolving it here would be the fix, and the
  // fix is a behaviour change.
  const device: string | Device | null = payload.target || null;
  // Arm resume-on-advance for THIS lineup before playing: playMedia resumes only the head, so
  // every other episode needs a seek once the player reaches it. Re-arming replaces any plan
  // left over from the previous scan.
  if (RESUME_ON_ADVANCE) {
    // `ResumeCandidate` is an index-signature shape, which an interface is never implicitly
    // assignable to — the cast is that rule. `device` is the `SessionStartPayload.target`
    // union noted above: resume/playback/driver all read `.uri`/`.mode`/`.name` off it, and a
    // string id reaching them is the latent bug, not something to normalise here.
    const plan = resume.resumePlan(playItems as resume.ResumeCandidate[], { headRatingKey: ratingKeys[0] });
    resume.arm({ plan, device: device as Device | null, setName });
    if (plan.size) {
      console.log(`[resume] armed ${plan.size} queued episode(s) to resume on advance: `
        + [...plan.entries()].map(([k, v]) => `${k}@${Math.round(v / 1000)}s`).join(' '));
      resume.startWatch({
        fetchSession: () => playback.currentSession({ device: device as Device | null }),
        seek: (ms: number) => playback.seekTo(ms, {
          device: device as Device | null, setName, userUuid: SESSION.userUuid,
        }),
      });
    }
  } else {
    resume.disarm();
  }
  const setLabel = cfg.label || setName;

  // materialize -> handoff. Both return a DESCRIPTOR of how to start this; neither performs
  // playback itself. On Plex that is a playQueue pushed at the Shield; on a pull provider it
  // is a URL to open. Collapsing them into one play() would hard-code the push model.
  // NOT awaited — as it never was. `materialize()` is SYNC on Plex (it returns a descriptor)
  // and ASYNC on Kavita (it builds a Reading List), so on a PULL provider this hands `handoff`
  // a Promise instead of an artifact. Unreachable today for the same reason the `PlayItem`
  // mismatch is (the pull path never reaches `startSession`); adding an `await` here is a
  // behaviour change on the push path, so the cast records the gap instead.
  const artifact = provider.materialize(
    playItems,
    { offset: resumeMs, setName, binding },
  ) as ProviderArtifact;

  // `cancelled` is a PUSH-result field (a pull handoff has no device to cancel), so the read
  // below is total over both members of `HandoffResult` without widening either.
  let result: HandoffResult & { cancelled?: boolean };
  if (PLAYBACK_FSM) {
    result = await provider.handoff(artifact, {
      useFsm: true, requiredProfile: required, device: device as Device | null, cancel, setLabel,
    });
  } else {
    // Legacy: join ADB switch then play
    if (required && ADB_ENABLED) {
      try { await adb.switchTo(required, cancel, null); } catch (e) {
        console.log(`[session] adb switch: ${errMessage(e)}`);
      }
    }
    if (isCancelled(cancel)) return { cancelled: true };
    result = await provider.handoff(artifact, { useFsm: false, device: device as Device | null });
  }

  if (result?.cancelled) return result;
  if (result?.error) {
    _publishState({ error: result.error, playback: result, ...SESSION.asDict() });
    return result;
  }
  // Remember the queue we just pushed, so `topup` extends THIS one. Read off the handoff
  // result because that is where it is created; a pull provider has no playQueue and leaves
  // it null, which is exactly what topup's Plex branch checks for.
  SESSION.playQueueID = (result as { playQueueID?: number | string | null }).playQueueID ?? null;
  _publishState({ playback: result, ...SESSION.asDict() });
  return { ok: true, playback: result, set: setName, count: ratingKeys.length };
}

export async function advanceSession(): Promise<SessionResult> {
  if (!SESSION.queue.length) return { error: 'no active session' };
  SESSION.cursor = Math.min(SESSION.cursor + 1, SESSION.queue.length - 1);
  const rest = SESSION.queue.slice(SESSION.cursor);
  if (!rest.length) {
    _publishState({ error: 'end of queue', ...SESSION.asDict() });
    return { error: 'end of queue' };
  }
  const ratingKeys = rest.map((q) => q.ratingKey);
  const result = await playback.playRatingKeys(ratingKeys, {
    setName: SESSION.set, offset: 0, userUuid: SESSION.userUuid,
  });
  _publishLastPlayed(lastPlayedFromItem(rest[0]));
  _publishState({ playback: result, ...SESSION.asDict() });
  return result;
}

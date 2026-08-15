// In-process session start: the sole implementation since Python was removed (2026-08-12).
//
// Selection and delivery both go through a PROVIDER (./providers) rather than a Plex client:
// buckets() produces the lineup, materialize() builds the runtime artifact, handoff() starts
// it — pushing a playQueue at the Shield on Plex, or returning a URL to open on a pull
// provider like Kavita. Nothing in this file may branch on which backend it is talking to.
//
// The queue write-side (queues.js markDone/clearDone/sweepCompleted) stays here and stays
// provider-neutral: it is about entries in the shared queues.yaml recipe store being
// finished, not about Plex.
import * as routing from './engine/routing.js';
import { providerFor } from './providers/index.js';
import { providerIdForSet } from './providers/blocks.js';
import * as queues from './queues.js';
import * as profiles from './profiles.js';
import * as adb from './adb.js';
import * as playback from './playback.js';
import * as driver from './driver.js';
import * as resume from './resume.js';
import {
  PLAYBACK_FSM, ADB_ENABLED, RESUME_ON_ADVANCE,
} from './env.js';

// Mutable session (mirrors service.Session) for advance + last-played.
export const SESSION = {
  kind: null,
  set: null,
  profile: null,
  queue: [],
  cursor: 0,
  lastMovieRk: null,
  // The active binding's managed-user uuid, so the LATER calls on this session (resume seek,
  // advance) drive playback as the same account the lineup was selected as.
  userUuid: null,
  asDict() {
    return {
      kind: this.kind, set: this.set, profile: this.profile,
      queue_len: this.queue.length, cursor: this.cursor,
    };
  },
};

let _publishState = () => {};
let _publishLastPlayed = () => {};
export function setPublishers({ state, lastPlayed } = {}) {
  if (state) _publishState = state;
  if (lastPlayed) _publishLastPlayed = lastPlayed;
  driver.setPublishState?.(state);
}

function cancelFlag() {
  let set = false;
  return {
    is_set: () => set,
    isSet: () => set,
    set: () => { set = true; },
    clear: () => { set = false; },
  };
}

// Only one start in flight; a newer start cancels the prior.
let _activeCancel = null;

function lastPlayedFromItem(item) {
  if (!item) return null;
  return {
    title: item.title || item.show || null,
    type: item.type || (item.season != null ? 'episode' : 'movie'),
    ratingKey: item.ratingKey != null ? String(item.ratingKey) : null,
  };
}

/**
 * Start a session from an MQTT/API payload.
 * @param {{set?:string, kind?:string, profile?:string, target?:object}} payload
 * @param {{cancel?: object}} opts
 */
export async function startSession(payload = {}, opts = {}) {
  if (_activeCancel) _activeCancel.set();
  const cancel = opts.cancel || cancelFlag();
  _activeCancel = cancel;

  if (ADB_ENABLED) {
    try { await adb.ensurePlexOpen(); } catch (e) {
      console.log(`[session] ensurePlexOpen: ${e.message}`);
    }
  }

  const kind = payload.kind || 'cartoons';
  let setName = payload.set || 'auto';
  const cardProfile = payload.profile || null;
  // "Play THIS entry" — an entry key from the web grid's per-tile ▶, narrowing the lineup to
  // one member of a curated queue/channel. Everything else about the start is unchanged: the
  // same profile gate, the same device, the same resume/mark-done bookkeeping. A physical
  // card never sends it; it only ever arrives from the UI.
  const only = payload.only ? String(payload.only) : null;
  const isAuto = setName === 'auto' || setName === '' || setName == null;
  let profileTitle = null;
  let detectedProfile = null;

  const reg = routing.loadSets();

  if (isAuto) {
    _publishState({ awaiting: 'profile', ...SESSION.asDict() });
    const title = await profiles.waitForProfile({ cancel, match: null });
    if (cancel.isSet()) return { cancelled: true };
    if (!title) {
      _publishState({ error: 'no profile is signed in on the Shield. Open Plex and pick one.', ...SESSION.asDict() });
      return { error: 'no profile' };
    }
    profileTitle = detectedProfile = title;
    setName = routing.channelFor(kind, title, reg) || profiles.setForProfile(title);
    if (!setName) {
      _publishState({ error: `profile '${title}' has no set mapped`, ...SESSION.asDict() });
      return { error: 'no set' };
    }
    console.log(`[session] '${title}' + kind '${kind}' -> set '${setName}'`);
  } else {
    profileTitle = cardProfile;
  }

  const cfg = reg.sets[setName];
  if (!cfg || cfg.enabled === false) {
    _publishState({ error: `set '${setName}' not enabled`, ...SESSION.asDict() });
    return { error: 'disabled' };
  }

  let required = cfg.requires_profile || null;
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
      ? adb.switchTo(required, cancel, null).catch((e) => [false, e.message])
      : Promise.resolve([false, 'ADB off']);
    const title = await profiles.waitForProfile({ cancel, match: required });
    if (cancel.isSet()) return { cancelled: true };
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

  const binding = routing.bindingFor(cfg, profileTitle);
  SESSION.kind = kind;
  SESSION.set = setName;
  SESSION.profile = profileTitle;
  SESSION.cursor = 0;
  SESSION.userUuid = binding.user_uuid || null;
  let resumeMs = 0;
  let playItems = [];

  // The engine no longer holds a Plex client — it holds a PROVIDER (decision
  // 2026-08-12-backends-are-providers-behind-a-media-neutral-seam). Everything Plex-shaped
  // (MediaContainer, ratingKeys, managed-user tokens) is now private to providers/plex.js.
  // Today every set resolves to the Plex provider, so this is a rewrap with no behaviour
  // change; the gates are what prove that.
  const provider = providerFor(providerIdForSet(cfg));
  const tok = await provider.profileToken(binding.user_uuid);

  const res = await provider.buckets({
    setName, cfg, binding, token: tok, kind, lastMovieRk: SESSION.lastMovieRk, only,
  });

  if (cfg.source === 'queue') {
    // D4 write-side: persist finished + revive stale-done + TTL sweep. This stays ABOVE the
    // seam on purpose — it is about entries in the shared queues.yaml recipe store being
    // finished, not about Plex, so a second provider reuses it verbatim.
    if (!cfg.reel) {
      if (Array.isArray(res.revived) && res.revived.length) {
        await queues.clearDone(setName, res.revived);
      }
      const newly = res.newlyDone || [];
      if (newly.length && !cfg.keep_completed && !cfg.reel) {
        await queues.markDone(setName, newly);
      }
      await queues.sweepCompleted(setName, {
        keepCompleted: Boolean(cfg.keep_completed),
        reel: Boolean(cfg.reel),
        removeCompletedAfter: cfg.remove_completed_after,
      });
    }
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
    SESSION.lastMovieRk = playItems[0].ratingKey;
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

  SESSION.queue = playItems.map((it) => ({
    ratingKey: String(it.ratingKey),
    title: it.title,
    season: it.season,
    episode: it.episode,
  }));

  const ratingKeys = SESSION.queue.map((q) => q.ratingKey);
  const device = payload.target || null;
  // Arm resume-on-advance for THIS lineup before playing: playMedia resumes only the head, so
  // every other episode needs a seek once the player reaches it. Re-arming replaces any plan
  // left over from the previous scan.
  if (RESUME_ON_ADVANCE) {
    const plan = resume.resumePlan(playItems, { headRatingKey: ratingKeys[0] });
    resume.arm({ plan, device, setName });
    if (plan.size) {
      console.log(`[resume] armed ${plan.size} queued episode(s) to resume on advance: `
        + [...plan.entries()].map(([k, v]) => `${k}@${Math.round(v / 1000)}s`).join(' '));
      resume.startWatch({
        fetchSession: () => playback.currentSession({ device }),
        seek: (ms) => playback.seekTo(ms, { device, setName, userUuid: SESSION.userUuid }),
      });
    }
  } else {
    resume.disarm();
  }
  const setLabel = cfg.label || setName;

  // materialize -> handoff. Both return a DESCRIPTOR of how to start this; neither performs
  // playback itself. On Plex that is a playQueue pushed at the Shield; on a pull provider it
  // is a URL to open. Collapsing them into one play() would hard-code the push model.
  const artifact = provider.materialize(playItems, { offset: resumeMs, setName, binding });

  let result;
  if (PLAYBACK_FSM) {
    result = await provider.handoff(artifact, {
      useFsm: true, requiredProfile: required, device, cancel, setLabel,
    });
  } else {
    // Legacy: join ADB switch then play
    if (required && ADB_ENABLED) {
      try { await adb.switchTo(required, cancel, null); } catch (e) {
        console.log(`[session] adb switch: ${e.message}`);
      }
    }
    if (cancel.isSet()) return { cancelled: true };
    result = await provider.handoff(artifact, { useFsm: false, device });
  }

  if (result?.cancelled) return result;
  if (result?.error) {
    _publishState({ error: result.error, playback: result, ...SESSION.asDict() });
    return result;
  }
  _publishState({ playback: result, ...SESSION.asDict() });
  return { ok: true, playback: result, set: setName, count: ratingKeys.length };
}

export async function advanceSession() {
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

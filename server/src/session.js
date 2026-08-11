// D6/D7: in-process session start (port of queue_builder/service._do_start) used when
// PLAYBACK_ENGINE=node. Selection uses the Node engine (D3); queue write-side is D4
// markDone/clearDone/sweepCompleted; device drive is driver.driveToPlaying / playback.
import * as routing from './engine/routing.js';
import * as resolve from './engine/resolve.js';
import * as rotation from './engine/rotation.js';
import * as select from './engine/select.js';
import { liveClient } from './engine/plex-live.js';
import * as queues from './queues.js';
import * as profiles from './profiles.js';
import * as adb from './adb.js';
import * as playback from './playback.js';
import * as driver from './driver.js';
import * as resume from './resume.js';
import {
  PLAYBACK_FSM, ADB_ENABLED, ROTATION_LENGTH, ENGINE, RESUME_ON_ADVANCE,
} from './env.js';

// Mutable session (mirrors service.Session) for advance + last-played.
export const SESSION = {
  kind: null,
  set: null,
  profile: null,
  queue: [],
  cursor: 0,
  lastMovieRk: null,
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

// 1/n² rewatch pick — mirrors pick_rewatch_movie for memberless channels.
function pickRewatch(counts, titles, excludes, excludeRk) {
  const candidates = [];
  for (const [rk, n] of counts) {
    if (excludes.has(String(rk))) continue;
    if (excludeRk && String(rk) === String(excludeRk)) continue;
    if (n < 1) continue;
    candidates.push([rk, n]);
  }
  if (!candidates.length) return null;
  const weights = candidates.map(([, n]) => 1 / (n * n));
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    r -= weights[i];
    if (r <= 0) {
      const rk = candidates[i][0];
      return { ratingKey: rk, title: titles.get(rk) || null };
    }
  }
  const [rk] = candidates[candidates.length - 1];
  return { ratingKey: rk, title: titles.get(rk) || null };
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
  let resumeMs = 0;
  let playItems = [];

  const client = liveClient();
  const tok = await client.accountToken(binding.user_uuid);

  if (cfg.source === 'queue') {
    const entries = resolve.loadEntries(setName);
    let res;
    if (cfg.reel) {
      res = await resolve.buildReel(client, setName, cfg, entries, tok);
    } else {
      const watched = await select.watchedForSet(client, cfg, binding);
      res = await resolve.nextQueue(client, setName, cfg, entries, watched, tok);
      // D4 write-side: persist finished + revive stale-done + TTL sweep
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
      _publishState({
        error: `queue '${setName}' has nothing to play (empty, or every entry watched - add entries to queues.yaml)`,
        ...SESSION.asDict(),
      });
      return { error: 'empty queue' };
    }
    playItems = res.play;
    resumeMs = res.offset || 0;
    if (res.last) _publishLastPlayed(lastPlayedFromItem(res.last));
  } else {
    // rotation channel
    let behavior = cfg.behavior;
    let mode;
    if (behavior === 'rewatch') mode = 'rewatch';
    else if (behavior === 'progress') mode = 'episodic';
    else mode = cfg.mode || (kind === 'movie' ? 'rewatch' : 'episodic');

    if (mode === 'rewatch') {
      const { counts, titles } = await select.rewatchCounts(
        client, routing.rewatchSections(cfg), binding.movie_ratings,
        binding.watch_count_accounts, tok,
      );
      const excludes = new Set((binding.movie_excludes || []).map(String));
      const pick = pickRewatch(counts, titles, excludes, SESSION.lastMovieRk);
      if (!pick) {
        _publishState({ error: 'no rewatch candidate found for this profile', ...SESSION.asDict() });
        return { error: 'no rewatch' };
      }
      SESSION.lastMovieRk = pick.ratingKey;
      playItems = [{ ratingKey: pick.ratingKey, title: pick.title }];
      _publishLastPlayed(lastPlayedFromItem(playItems[0]));
    } else {
      const queue = await rotation.buildRotation(client, cfg, binding, ROTATION_LENGTH, {
        shuffle(arr) {
          for (let i = arr.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
        },
      });
      if (!queue.length) {
        _publishState({ error: `channel '${setName}' has nothing unwatched to play`, ...SESSION.asDict() });
        return { error: 'empty rotation' };
      }
      playItems = queue;
      _publishLastPlayed(lastPlayedFromItem(playItems[0]));
    }
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
      console.log(`[resume] armed ${plan.size} queued episode(s) to resume on advance`);
      resume.startWatch({
        fetchSession: () => playback.currentSession({ device, setName }),
        seek: (ms) => playback.seekTo(ms, { device, setName }),
      });
    }
  } else {
    resume.disarm();
  }
  const setLabel = cfg.label || setName;

  let result;
  if (PLAYBACK_FSM) {
    result = await driver.driveToPlaying(null, {
      ratingKeys,
      requiredProfile: required,
      offset: resumeMs,
      device,
      setName,
      cancel,
      setLabel,
    });
  } else {
    // Legacy: join ADB switch then play
    if (required && ADB_ENABLED) {
      try { await adb.switchTo(required, cancel, null); } catch (e) {
        console.log(`[session] adb switch: ${e.message}`);
      }
    }
    if (cancel.isSet()) return { cancelled: true };
    result = await playback.playRatingKeys(ratingKeys, {
      setName, device, offset: resumeMs,
    });
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
  const result = await playback.playRatingKeys(ratingKeys, { setName: SESSION.set, offset: 0 });
  _publishLastPlayed(lastPlayedFromItem(rest[0]));
  _publishState({ playback: result, ...SESSION.asDict() });
  return result;
}

// Silence unused ENGINE import warning paths — ENGINE gates preview only; selection always Node here.
void ENGINE;

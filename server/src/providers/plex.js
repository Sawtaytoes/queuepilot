// The Plex provider, on the media-neutral shape from decision
// 2026-08-12-backends-are-providers-behind-a-media-neutral-seam.
//
// THIS FILE IS A REWRAP, NOT A REWRITE. It lands before the Kavita provider precisely so that
// any diff the golden-corpus gates catch is unambiguously the refactor's fault (ADR
// "Sequencing", obligation 3). It therefore calls select/resolve/rotation in exactly the
// order session.js called them in, with the same arguments, and returns the same shapes.
// A refactor at this seam that moves a single episode is a family-TV regression.
//
// What it does NOT do: it does not touch select.js / resolve.js / rotation.js. Those keep
// speaking Plex's `container(path, token)` wire format internally, which is now correctly a
// PRIVATE implementation detail of this provider rather than the engine's interface. That is
// the whole point of the widening — the engine above this line no longer knows what a
// MediaContainer is.
import * as resolve from '../engine/resolve.js';
import * as rotation from '../engine/rotation.js';
import * as select from '../engine/select.js';
import * as routing from '../engine/routing.js';
import { liveClient } from '../engine/plex-live.js';
import { sections as plexSections } from '../plex.js';
import { toWeight } from '../engine/weight.js';
import * as playback from '../playback.js';
import * as driver from '../driver.js';
import { ROTATION_LENGTH } from '../env.js';

// The 1/n² rewatch pick, moved verbatim from session.js. Memberless channels weight by
// 1/(count²) so a film seen once is far likelier than one seen three times.
function pickRewatch(counts, titles, excludes, excludeRk, weights = {}) {
  const candidates = [];
  for (const [rk, n] of counts) {
    if (excludes.has(String(rk))) continue;
    if (excludeRk && String(rk) === String(excludeRk)) continue;
    if (n < 1) continue;
    candidates.push([rk, n]);
  }
  if (!candidates.length) return null;
  // The channel's `weights:` map MULTIPLIES the 1/n² least-watched bias rather than replacing
  // it: a 3x film is three times as likely as it would otherwise have been, but a film seen
  // once still beats the same film seen three times. There is no round to take slots in here —
  // the card plays exactly one movie — so this is the one place a weight is odds, not slots.
  const odds = candidates.map(([rk, n]) => toWeight(weights[String(rk)]) / (n * n));
  let total = 0;
  for (const w of odds) total += w;
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i += 1) {
    r -= odds[i];
    if (r <= 0) {
      const rk = candidates[i][0];
      return { ratingKey: rk, title: titles.get(rk) || null };
    }
  }
  const [rk] = candidates[candidates.length - 1];
  return { ratingKey: rk, title: titles.get(rk) || null };
}

function defaultShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// The production rng. `random` is what the WEIGHTED member shuffle draws from (engine/weight.js);
// a seeded test injects its own object with both members.
const defaultRng = { shuffle: defaultShuffle, random: () => Math.random() };

/**
 * @param {{def?: object, client?: object}} opts
 * `client` is injectable so the parity gates can substitute plex-replay.js exactly as they
 * do today — the replay client is what proves this seam is real rather than decorative.
 */
export function plexProvider({ def = null, client = null } = {}) {
  const c = client || liveClient();

  return {
    id: def?.id || 'plex',
    kind: 'plex',
    label: def?.label || 'Plex',

    /** Push, not pull: a card starts the show on a screen that is already on. */
    delivery: 'push',

    /**
     * Libraries, for the queue editor's provider block.
     *
     * Only VIDEO libraries: membership is opt-in and every video library is eligible, but a
     * Music or Photos section can never hold something this app plays. Ids are stringified
     * because a block's `libraries` are provider-scoped strings — the number/string split
     * belongs to Plex's wire format, not to the block schema.
     */
    async libraries() {
      const secs = await plexSections();
      return secs
        .filter((l) => l.video)
        .map((l) => ({ id: String(l.id), title: l.title }))
        .sort((a, b) => a.title.localeCompare(b.title));
    },

    /**
     * Plex's per-profile identity is a managed-user token minted against plex.tv. The engine
     * above this line never sees it — it asks for a profile and gets items back.
     */
    profileToken: (userUuid) => c.accountToken(userUuid),

    /**
     * Watched state for a set+profile. Only the curated-queue path consumes this directly;
     * the rotation path folds it into buckets().
     */
    progressState: ({ cfg, binding }) => select.watchedForSet(c, cfg, binding),

    /**
     * The ordered lineup for one set under one profile.
     *
     * Returns the resolver's own shape unchanged — { play, offset, last, done, unresolved,
     * revived, newlyDone } — because session.js's write-side bookkeeping (markDone /
     * clearDone / sweepCompleted against queues.yaml) is provider-NEUTRAL: it is about
     * entries in the shared recipe store being finished, not about Plex. Keeping it above
     * this seam is what lets Kavita reuse it verbatim.
     */
    async buckets({ setName, cfg, binding, token, kind, lastMovieRk = null }) {
      if (cfg.source === 'queue') {
        const entries = resolve.loadEntries(setName);
        if (cfg.reel) return resolve.buildReel(c, setName, cfg, entries, token);
        const watched = await select.watchedForSet(c, cfg, binding);
        // The rng is REQUIRED, not optional: a channel (kind: anime) plays its members in a
        // shuffled order, and nextQueue only shuffles when handed one. Python defaulted it to
        // the `random` module; this call site did not, so every channel quietly played in
        // queues.yaml file order from the Python retirement until this fix.
        return resolve.nextQueue(c, setName, cfg, entries, watched, token, defaultRng);
      }

      // Rotation channel. `behavior` is the newer knob and wins; `mode` is the legacy one.
      let mode;
      if (cfg.behavior === 'rewatch') mode = 'rewatch';
      else if (cfg.behavior === 'progress') mode = 'episodic';
      else mode = cfg.mode || (kind === 'movie' ? 'rewatch' : 'episodic');

      if (mode === 'rewatch') {
        const { counts, titles } = await select.rewatchCounts(
          c, routing.rewatchSections(cfg), binding.movie_ratings,
          binding.watch_count_accounts, token,
        );
        const excludes = new Set((binding.movie_excludes || []).map(String));
        // The exclusion of the previously-played film is SESSION state, threaded in by the
        // caller — a provider is stateless across starts and must not hold it.
        const pick = pickRewatch(counts, titles, excludes, lastMovieRk, cfg.weights || {});
        if (!pick) return { play: [], rewatch: true };
        return { play: [{ ratingKey: pick.ratingKey, title: pick.title }], rewatch: true };
      }

      const queue = await rotation.buildRotation(c, cfg, binding, ROTATION_LENGTH, defaultRng);
      return { play: queue };
    },

    /**
     * Plex's runtime artifact is a playQueue.
     *
     * NOTE, honestly: playback.js fuses playQueue creation and the push into one call
     * (playRatingKeys -> createPlayQueue -> playMedia), and driver.driveToPlaying wraps that
     * again with the profile FSM. Splitting them for real means reordering production
     * playback code, which is exactly the behaviour change this rewrap must not make. So
     * materialize() returns a DESCRIPTOR and handoff() performs the fused drive. The seam is
     * media-neutral at the interface, which is what Kavita needs; making it literal inside
     * playback.js is follow-up work, not a prerequisite.
     */
    materialize(items, { offset = 0, setName = null } = {}) {
      return {
        provider: this.id,
        kind: 'plex',
        ratingKeys: items.map((it) => String(it.ratingKey)),
        offset,
        setName,
      };
    },

    /** Push the playQueue at the Shield. Returns the playback result session.js publishes. */
    async handoff(artifact, {
      useFsm = false, requiredProfile = null, device = null, cancel = null, setLabel = null,
    } = {}) {
      if (useFsm) {
        return driver.driveToPlaying(null, {
          ratingKeys: artifact.ratingKeys,
          requiredProfile,
          offset: artifact.offset,
          device,
          setName: artifact.setName,
          cancel,
          setLabel,
        });
      }
      return playback.playRatingKeys(artifact.ratingKeys, {
        setName: artifact.setName,
        device,
        offset: artifact.offset,
      });
    },
  };
}

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
import type {
  BucketsResult,
  EngineBinding,
  HandoffOptions,
  PlexArtifact,
  PlexClient,
  PlexPlayItem,
  Provider,
  ProviderDefinition,
  ProviderLibrary,
  PushResult,
  RoutingSetCfg,
} from '../types.js';

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

/**
 * What `buckets()` actually needs, which is NARROWER than `BucketsContext`.
 *
 * `BucketsContext` declares every field optional because Kavita reads a disjoint subset; the
 * Plex side dereferences `cfg` and `binding` unconditionally, so they are REQUIRED here and
 * `cfg` is the real `RoutingSetCfg` union rather than the interface's `| Record<string,
 * unknown>` escape hatch — that union is what makes `cfg.source === 'queue'` narrow to the
 * queue branch's fields. Declaring the implementation narrower than the interface is legal
 * (method parameters are bivariant) and is the honest statement of what a Plex scan needs.
 */
interface PlexBucketsContext {
  /** REQUIRED here, optional on `BucketsContext`: the curated-queue branch loads the entry
   *  file by this name, so a scan without one has nothing to resolve. */
  setName: string;
  cfg: RoutingSetCfg;
  binding: EngineBinding;
  token?: string | null;
  kind?: string;
  lastMovieRk?: string | null;
  /** The one-entry override — see `BucketsContext.only`. Curated-queue branch only. */
  only?: string | null;
}

/** The rng seam. A seeded test injects its own object with both members. */
interface Rng {
  shuffle: (arr: unknown[]) => void;
  random: () => number;
}

export interface PlexProviderOptions {
  def?: ProviderDefinition | null;
  client?: PlexClient | null;
}

// The 1/n² rewatch pick, moved verbatim from session.js. Memberless channels weight by
// 1/(count²) so a film seen once is far likelier than one seen three times.
function pickRewatch(
  counts: Iterable<[string | number, number]>,
  titles: Map<string | number, string | null | undefined>,
  excludes: Set<string>,
  excludeRk: string | null,
  weights: Record<string, number> = {},
): { ratingKey: string | number; title: string | null } | null {
  const candidates: [string | number, number][] = [];
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
    // Both index reads are in-bounds by the loop bound; `odds` is built one-for-one off
    // `candidates`. The assertions are what `noUncheckedIndexedAccess` costs, not a change.
    r -= odds[i] as number;
    if (r <= 0) {
      const rk = (candidates[i] as [string | number, number])[0];
      return { ratingKey: rk, title: titles.get(rk) || null };
    }
  }
  const [rk] = candidates[candidates.length - 1] as [string | number, number];
  return { ratingKey: rk, title: titles.get(rk) || null };
}

function defaultShuffle(arr: unknown[]): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = arr[i];
    arr[i] = arr[j];
    arr[j] = a;
  }
}

// The production rng. `random` is what the WEIGHTED member shuffle draws from (engine/weight.js);
// a seeded test injects its own object with both members.
const defaultRng: Rng = { shuffle: defaultShuffle, random: () => Math.random() };

/**
 * `client` is injectable so the parity gates can substitute plex-replay.js exactly as they
 * do today — the replay client is what proves this seam is real rather than decorative.
 */
export function plexProvider({ def = null, client = null }: PlexProviderOptions = {}): Provider {
  const c: PlexClient = client || liveClient();

  return {
    id: def?.id || 'plex',
    kind: 'plex',
    label: def?.label || 'Plex',

    /** Push, not pull: a card starts the show on a screen that is already on. */
    delivery: 'push',

    /** Episodes — see kavita.js's `unit`. */
    unit: 'episode',

    /**
     * Libraries, for the queue editor's provider block.
     *
     * Only VIDEO libraries: membership is opt-in and every video library is eligible, but a
     * Music or Photos section can never hold something this app plays. Ids are stringified
     * because a block's `libraries` are provider-scoped strings — the number/string split
     * belongs to Plex's wire format, not to the block schema.
     */
    async libraries(): Promise<ProviderLibrary[]> {
      const secs = await plexSections();
      return secs
        .filter((l) => l.video)
        // `title as string`: a Plex section's title is optional on the wire shape, while
        // ProviderLibrary declares `title: string`. Asserted rather than defaulted to '' —
        // a blank-titled library in the editor's picker is worse than the untyped status quo,
        // and this maps a LIVE `/library/sections` row, which always carries one.
        .map((l) => ({ id: String(l.id), title: l.title as string }))
        .sort((a, b) => a.title.localeCompare(b.title));
    },

    /**
     * Plex's per-profile identity is a managed-user token minted against plex.tv. The engine
     * above this line never sees it — it asks for a profile and gets items back.
     */
    profileToken: (userUuid: string | null) => c.accountToken(userUuid),

    /**
     * Watched state for a set+profile. Only the curated-queue path consumes this directly;
     * the rotation path folds it into buckets().
     */
    progressState: ({ cfg, binding }: PlexBucketsContext): Promise<Set<string>> => (
      select.watchedForSet(c, cfg, binding)
    ),

    /**
     * The ordered lineup for one set under one profile.
     *
     * Returns the resolver's own shape unchanged — { play, offset, last, done, unresolved,
     * revived, newlyDone } — because session.js's write-side bookkeeping (markDone /
     * clearDone / sweepCompleted against queues.yaml) is provider-NEUTRAL: it is about
     * entries in the shared recipe store being finished, not about Plex. Keeping it above
     * this seam is what lets Kavita reuse it verbatim.
     */
    async buckets({
      setName, cfg, binding, token, kind, lastMovieRk = null, only = null,
    }: PlexBucketsContext): Promise<BucketsResult> {
      if (cfg.source === 'queue') {
        let entries = resolve.loadEntries(setName);
        // "Play THIS one" (the grid's per-tile ▶). Narrowing the ENTRY LIST — rather than
        // adding a branch inside nextQueue — is what keeps this honest: the one entry still
        // goes through the same resolve/watched/batch machinery, so it gets the same next
        // unwatched episode, the same episodes-per-play count and the same resume offset it
        // would have got when the queue reached it on its own. A one-entry queue IS the
        // normal path with a shorter list.
        if (only) {
          entries = entries.filter((e) => e.key === only);
          if (!entries.length) return { play: [], unknownEntry: only };
        }
        if (cfg.reel) return resolve.buildReel(c, setName, cfg, entries, token);
        const watched = await select.watchedForSet(c, cfg, binding);
        // The rng is REQUIRED, not optional: a channel (kind: anime) plays its members in a
        // shuffled order, and nextQueue only shuffles when handed one. Python defaulted it to
        // the `random` module; this call site did not, so every channel quietly played in
        // queues.yaml file order from the Python retirement until this fix.
        return resolve.nextQueue(c, setName, cfg, entries, watched, token, defaultRng);
      }

      // Rotation channel. `behavior` is the newer knob and wins; `mode` is the legacy one.
      let mode: string;
      if (cfg.behavior === 'rewatch') mode = 'rewatch';
      else if (cfg.behavior === 'progress') mode = 'episodic';
      else mode = cfg.mode || (kind === 'movie' ? 'rewatch' : 'episodic');

      if (mode === 'rewatch') {
        const { counts, titles } = await select.rewatchCounts(
          c, routing.rewatchSections(cfg), binding.movie_ratings,
          // `?? null`, not `|| null`: `token` is optional on the context and select.js's
          // signature is `string | null`. An absent token and a null token already meant the
          // same thing to every reader (the admin/default X-Plex-Token), so this normalizes
          // the ABSENCE without touching the empty-string case.
          binding.watch_count_accounts, token ?? null,
        );
        const excludes = new Set((binding.movie_excludes || []).map(String));
        // The exclusion of the previously-played film is SESSION state, threaded in by the
        // caller — a provider is stateless across starts and must not hold it.
        const pick = pickRewatch(counts, titles, excludes, lastMovieRk, cfg.weights || {});
        if (!pick) return { play: [], rewatch: true };
        // `PlexPlayItem.title` is `string | undefined`, but this branch has ALWAYS emitted an
        // explicit `title: null` for a pick whose title did not resolve, and that null crosses
        // to MQTT. Asserted rather than switched to `undefined`, which JSON.stringify would
        // drop from the payload — a wire change, not a typing one. (Reported.)
        const item = { ratingKey: pick.ratingKey, title: pick.title } as PlexPlayItem;
        return { play: [item], rewatch: true };
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
    materialize(
      items: PlexPlayItem[],
      { offset = 0, setName = null, binding = null }: {
        offset?: number; setName?: string | null; binding?: EngineBinding | null;
      } = {},
    ): PlexArtifact {
      return {
        provider: this.id,
        kind: 'plex',
        ratingKeys: items.map((it) => String(it.ratingKey)),
        offset,
        setName,
        // The account this lineup was SELECTED as must also be the account it is PLAYED as —
        // carry the resolved binding's uuid on the artifact rather than letting playback
        // re-derive it from the set (which only knows the default binding).
        userUuid: (binding && binding.user_uuid) || null,
      };
    },

    /** Push the playQueue at the Shield. Returns the playback result session.js publishes. */
    async handoff(artifact: PlexArtifact, {
      useFsm = false, requiredProfile = null, device = null, cancel = null, setLabel = null,
    }: HandoffOptions = {}): Promise<PushResult> {
      if (useFsm) {
        return driver.driveToPlaying({
          ratingKeys: artifact.ratingKeys,
          requiredProfile,
          offset: artifact.offset,
          device,
          setName: artifact.setName,
          cancel,
          setLabel,
          userUuid: artifact.userUuid,
        });
      }
      return playback.playRatingKeys(artifact.ratingKeys, {
        setName: artifact.setName,
        device,
        offset: artifact.offset,
        userUuid: artifact.userUuid,
      });
    },
  };
}

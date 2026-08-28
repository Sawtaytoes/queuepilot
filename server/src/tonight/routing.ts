// WP-7 — ONE MAP FROM AN ACTIVITY TO THE BACKENDS BEHIND IT.
//
// ── Two vocabularies, and this is where they meet ────────────────────────────────────────
//
// The Tonight surface asks two different questions with the same word, and exactly one file
// on each side of the wire is allowed to know both answers.
//
//   * A TILE is a kind of evening. Six of them, the row is settled and Surprise Me is last
//     (decision 2026-08-25-video-games-absorbs-retro-and-surprise-me-narrows-first §1).
//   * A QUEUE ACTIVITY is what WP-5 stores on a set. Four of them, and "Movies & Shows" is
//     deliberately ONE (`activity.ts`).
//
// Nothing outside this file may branch on a tile to decide a backend, and nothing anywhere
// may branch on a provider kind to decide a tile — that was WP-6's bridge and it is deleted.
//
// ── The one place the two genuinely disagree, and why it is not a bug ────────────────────
//
// `watching` covers BOTH the Movies tile and the Shows tile.
//
//   * The queue model refuses a finer content list on the owner's own evidence — "the Older
//     Kids queue would show up under both Shows and Shorts, but I don't think of it like
//     that in my head". A queue under two headings is the failure it avoids.
//   * The tile row is six because a film night and a series night are two different
//     evenings, and that list is pinned by test.
//
// So the residue is real, it is named in the implementation plan §5 as the one open question
// that changes the SCHEMA rather than a screen, and it is NOT this package's to settle.
// `tileForSet()` holds the whole of it in one function. When the content-type question is
// answered, that function is where the answer lands and nothing else moves.
//
// ── One session talks to ONE backend ────────────────────────────────────────────────────
//
// An activity may be served by more than one backend — Video Games is Steam and MiSTer
// today. A SESSION is still bound to exactly one: the draw picks a backend first and then
// draws inside it, so a reroll cannot walk from a Steam queue to a MiSTer one halfway
// through an evening. A queue that draws from two providers is refused rather than guessed
// at, which is the rule `providers/blocks.ts isMixed` already enforces at launch
// (decision 2026-08-13-a-queue-draws-from-exactly-one-provider).
//
// CODE here, DATA in `/config/queuepilot.sqlite`. Fixtures are Ada, Grace and Linus.
import type { Activity } from '../activity.js';

/**
 * The six tiles, in the settled order. Surprise Me is last and stays last.
 *
 * Wire values: they arrive in a `POST /api/tonight/pick` body, so they are kebab-case and
 * stable, and they are spelled identically in `web/src/lib/tonight.ts`.
 */
export const TONIGHT_TILES = [
  'video-games',
  'board-games',
  'movies',
  'shows',
  'reading',
  'surprise',
] as const;

export type TonightTile = (typeof TONIGHT_TILES)[number];

export const isTonightTile = (value: unknown): value is TonightTile =>
  TONIGHT_TILES.includes(value as TonightTile);

/**
 * How Pick draws for a tile.
 *
 *   * `board-games` — the absorbed Board Game Picker engine. It draws from a SHELF, not from
 *     a queue: a board game is not queued, it is in a cupboard. `POST /api/board-games/pick`
 *     owns it and this package does not touch it.
 *   * `queue-first` — the pick draws one QUEUE, and the queue's own engine draws the item
 *     when it starts. See `WHY_QUEUE_FIRST` for why this is the answer for four tiles and
 *     not only for the two the plan names.
 *   * `narrow-first` — Surprise Me. It chooses nothing until the browser's second screen
 *     supplies Media, Games or Reading, then delegates to the chosen activity's real engine.
 */
export type PickEngine = 'board-games' | 'narrow-first' | 'queue-first';

export interface TileRoute {
  tile: TonightTile;
  /** The queue activity whose sets this tile draws from; `null` when it draws from no queue. */
  queueActivity: Activity | null;
  /** Provider kinds that serve this tile IN THIS BUILD — what `provider_kind` can hold. */
  providerKinds: readonly string[];
  /**
   * Backends the settled decisions name for this tile that are NOT built. Listed so the map
   * is the whole answer rather than the built half of it.
   *
   * Eden (Switch), Cemu (Wii U) and Dolphin (GameCube/Wii) are named by the 2026-08-25
   * activity decision §1. YouTube is named as a future provider by the absorb brief §7 and
   * is explicitly not built — there is no Filtered Pool variant of it.
   */
  plannedProviderKinds: readonly string[];
  engine: PickEngine;
}

/**
 * THE MAP. One row per tile, and a row is added in the same change that adds a tile or a
 * provider. There is no default branch: the record is keyed on `TonightTile`, so a tile this
 * table has not heard of is a compile error.
 *
 * ⚠️ `web/src/lib/tonightRouting.ts` carries the same table for the browser, and
 * `e2e/tonight-routing-test.ts` compares the two field by field. Change one and the gate
 * fails until you change the other.
 */
export const TILE_ROUTES: Readonly<Record<TonightTile, TileRoute>> = {
  'board-games': {
    engine: 'board-games',
    plannedProviderKinds: [],
    providerKinds: ['board-game-picker'],
    queueActivity: 'board-games',
    tile: 'board-games',
  },
  movies: {
    engine: 'queue-first',
    plannedProviderKinds: ['youtube'],
    providerKinds: ['plex'],
    queueActivity: 'watching',
    tile: 'movies',
  },
  reading: {
    engine: 'queue-first',
    plannedProviderKinds: [],
    providerKinds: ['kavita'],
    queueActivity: 'reading',
    tile: 'reading',
  },
  shows: {
    engine: 'queue-first',
    plannedProviderKinds: ['youtube'],
    providerKinds: ['plex'],
    queueActivity: 'watching',
    tile: 'shows',
  },
  surprise: {
    engine: 'narrow-first',
    plannedProviderKinds: [],
    providerKinds: [],
    queueActivity: null,
    tile: 'surprise',
  },
  'video-games': {
    engine: 'queue-first',
    plannedProviderKinds: ['cemu', 'dolphin', 'eden'],
    providerKinds: ['mister', 'steam'],
    queueActivity: 'video-games',
    tile: 'video-games',
  },
};

export const routeForTile = (tile: TonightTile): TileRoute => TILE_ROUTES[tile];

/**
 * Which tile a set sits under.
 *
 * Reads the activity WP-5 stores on the set — the EFFECTIVE value, which is the override if
 * somebody typed one and the provider's own answer otherwise. It does NOT re-derive from the
 * provider kind: that was WP-6's browser-side bridge, written before a queue stored anything,
 * and a second derivation is a second opinion that can disagree with this one.
 *
 * ⚠️ The `watching` branch is the ONLY guess left on this screen. `behavior: 'rewatch'` is
 * the Movies rotation's own marker and is the only evidence any set carries, so a rewatch
 * channel is a film night and everything else under `watching` is a series night. A CURATED
 * queue full of films therefore reads as Shows, because nothing on it says otherwise, and a
 * `QueueSet` has no `behavior` field at all. Do not add a second guess elsewhere to
 * compensate — settle the content-type question and give this function a column to read.
 */
export function tileForSet(set: {
  activity: Activity;
  behavior?: string | null;
}): TonightTile {
  switch (set.activity) {
    case 'board-games':
      return 'board-games';
    case 'reading':
      return 'reading';
    // MiSTer, Steam and the three launchers that are not built are ONE tile. No tile names a
    // device, and there is no Retro Games tile.
    case 'video-games':
      return 'video-games';
    default:
      return set.behavior === 'rewatch' ? 'movies' : 'shows';
  }
}

/** The tiles a queue activity can appear under — the map read backwards. `watching` answers
 *  two, which is the open question in one place; every other activity answers one. */
export const tilesForQueueActivity = (activity: Activity): TonightTile[] =>
  TONIGHT_TILES.filter((tile) => TILE_ROUTES[tile].queueActivity === activity);

/**
 * Why four tiles share one engine, written down because the implementation plan's table
 * names per-activity filters and an agent reading only that table would think they were
 * forgotten. They were measured, and the data is not there:
 *
 *   * MOVIES — "runtime, rating gate, seen-before". Plex carries `duration` and
 *     `contentRating` on a raw section dump, and `finished.watchedFor()` can answer
 *     seen-before, but all three are facts about an ITEM. There is no age→rating table
 *     anywhere in this server (`birthYear` is on a person and reaches nothing), and the
 *     rating gate that does exist is a per-binding allowlist somebody typed. Drawing an item
 *     here would also be a SECOND opinion about what is left to watch, sitting beside the
 *     queue's own resolver — the class of bug `queuesRoutes.tagFinishedMovies` already warns
 *     about in its header.
 *   * SHOWS and READING — "queue-first" is what the plan asks for by name.
 *   * VIDEO GAMES — "players, known-how, time proxy". There is no video-game known-how
 *     table; WP-8 built the WORDING split ("Knows how to play" against "Knows the rules") and
 *     left the rows waiting. Steam reports lifetime playtime and no player count at all, and
 *     a play count may never be turned into a known-how claim
 *     (board-games decision 2026-08-17-knowing-the-rules-is-a-per-person-fact-not-a-play-count).
 *
 * So Pick chooses the QUEUE, honestly, and the queue chooses the item at launch — which is
 * the one place that already knows what is left. The filters the form collects are reported
 * back on the answer as "not applied", by name, rather than being silently dropped.
 */
export const WHY_QUEUE_FIRST: Readonly<Partial<Record<TonightTile, string>>> = {
  movies:
    'Runtime and Seen before are collected but not applied yet: both are facts about an item, '
    + 'and the queue picks the item when it starts.',
  reading: '',
  shows: '',
  'video-games':
    'Knows how to play is collected but not applied yet: there is no video-game known-how '
    + 'table, and a play count may never become a claim.',
};

/**
 * The domain shapes `server/src` actually produces and consumes.
 *
 * Hand-written from the code that emits each shape, the same way `web/src/lib/types.ts`
 * was — there is no schema to generate from, so every field below was read off the
 * function that builds it, and the file names that function in its comment. Where a
 * shape is UNTRUSTWORTHY at the boundary (an MQTT payload, a Plex response) it is typed
 * as optional rather than tidied into something the runtime does not guarantee.
 *
 * A recurring hazard this file exists to make visible: the SAME concept has two
 * different in-memory shapes on the two sides of the app. `sets.js` normalizes for the
 * WEB API; `engine/routing.js` normalizes for the ENGINE, with different field names,
 * different defaults, and — for ratings — a different container type. Both are correct
 * for their consumer and neither may be "unified" without a behaviour change, so both
 * are declared here with a comment saying who reads which.
 */

// --- small vocabularies ------------------------------------------------------ //

/** `source:` on a set. Anything that is not `rotation` normalizes to `queue` (sets.js). */
export type SetSource = 'queue' | 'rotation';

/**
 * `behavior:` on a rotation channel (v3 PR 2). Supersedes `mode` and wins over it in
 * providers/plex.js buckets(): progress -> advance through unwatched, rewatch -> weighted
 * least-watched replay.
 */
export type SetBehavior = 'progress' | 'rewatch';

/** The legacy `mode:` knob. `sets.js` MODES; rotation sets default to `both`. */
export type SetMode = 'rewatch' | 'episodic' | 'both';

/**
 * Where a multi-episode batch may stop. null at the set level = no boundary; null on an
 * ENTRY = "follow the set". Curated sets only — a channel alternates shows every item.
 */
export type BatchStop = 'member' | 'season' | null;

/**
 * How a queue STARTS, derived from its provider blocks. `push` = a lineup is sent at a
 * device (Plex -> the Shield); `pull` = there is no cast target and the provider hands
 * back a URL to open (Kavita).
 */
export type Delivery = 'push' | 'pull';

/**
 * What a provider's lineup is COUNTED in — the provider's own fact, declared on the
 * provider (see `Provider.unit`) rather than inferred from `kind` above the seam. It is
 * the wording on a tile's next-up line ("Ch 113" / "All read" vs "E5" / "All watched")
 * and nothing else. `web/src/lib/types.ts` calls the same union `EntryUnit`.
 *
 * `volume` is a PER-ITEM refinement of `chapter`, not a third provider: one Kavita library
 * holds volume-based manga beside chapter-based webtoons, so the provider declares `chapter`
 * and an individual item corrects it. Without it a whole volume renders as "Ch -100000" —
 * Kavita's no-chapter-subdivision sentinel, printed verbatim.
 */
export type MediaUnit = 'episode' | 'chapter' | 'volume' | 'play';

/**
 * The WORDS a provider's medium is described in — the provider's own fact, exposed so no
 * copy anywhere above the seam has to branch on `kind`.
 *
 * Reported from the live app, 2026-08-15: a tile on the Kavita queue said
 * *Play “The Sword-Eating Swordmaster” now*. `delivery` already told the UI that queue hands
 * back a URL rather than pushing at a device, but nothing told it the verb — so every
 * affordance kept Plex's vocabulary on a medium nobody plays.
 *
 * Deliberately just the words. Anything a provider DOES belongs on `Provider`; this is the
 * label layer, and keeping it separate is what lets it be serialized to the browser (which
 * cannot call `materialize()`) without dragging behaviour across the wire.
 */
export interface ProviderVocabulary {
  /** The imperative on a start affordance: "Play" / "Read". */
  verb: string;
  /** What one lineup item is, singular: "episode" / "chapter". */
  unit: string;
  /** …and plural, because English is not reliably `+ 's'` for every future backend. */
  units: string;
  /** What a lineup MEMBER is: "show" / "series". */
  member: string;
  /** The finished state, for "All watched" / "All read". */
  done: string;
  /**
   * The unit abbreviated to fit on a poster tile: "eps" / "ch" / "plays".
   *
   * Here rather than in the tile component because that component had grown
   * `unit === 'episode' ? 'eps' : 'ch'` — a binary that silently tags a board game "3 ch".
   * A third medium is what exposed it; the fourth should not have to find it again.
   */
  unitShort: string;
  /**
   * The product name used in authored copy: "Plex" / "Kavita".
   * The replacement engine swaps this for the word "Plex" in leftover sentences.
   */
  name: string;
  /**
   * The glyph on the start affordance: `▶` for Plex, `📖` for Kavita, `🎲` for the picker.
   *
   * A sibling of `verb`, and for exactly the same reason. `verb` alone fixed the WORD on a
   * reading queue's button and left a play triangle sitting beside it — the icon still
   * claiming "this is going to play on a screen" after the label had stopped. An icon is
   * copy; it is authored per provider like the rest of the vocabulary.
   */
  startIcon: string;
}

/**
 * The "Start from…" picker's list. Same shape the Plex-only `/show/:id/episodes`
 * route has always returned, so the modal does not grow a second parser: a
 * reading series reports one season of chapters (or volumes) and
 * `multiSeason: false` hides the season row.
 */
export interface UnitList {
  multiSeason: boolean;
  seasons: {
    season: number;
    episodes: {
      episode: number | null;
      title: string;
      watched: boolean;
    }[];
  }[];
}

/**
 * A manual START floor: begin here, WITHOUT marking anything earlier watched.
 *
 * Built by two writers that agree on the shape: `queues.js normalizeStart()` (per-entry,
 * off the wire) and `sets.js toStarts()` (the channel-level `starts:` map, per ratingKey).
 * Both drop a start that names neither a series nor an episode, and both write `season`
 * and `episode` together — a bare `{season}` is not reachable through either.
 *
 * `series` is a COLLECTION's member to begin at (a ratingKey; a hand-written YAML entry
 * may name it by title, and the engine matches either).
 */
export interface Start {
  series?: string;
  season?: number;
  episode?: number;
}

// --- bindings ---------------------------------------------------------------- //

/**
 * One profile binding as the WEB API reports it — `sets.js normalizeBinding()`.
 *
 * Ratings are ARRAYS here because this shape is JSON-serialized to the browser. See
 * `EngineBinding` for the engine's twin, where they are `Set<string>`.
 */
export interface Binding {
  plex_user: string | null;
  account_id: number | null;
  user_uuid: string | null;
  /** null (not `[]`) when the key is absent — normalizeBinding distinguishes the two. */
  allowed_ratings: string[] | null;
  movie_ratings: string[] | null;
  /** Coerced through `toInts`, so always a list (possibly empty), never null. */
  watch_count_accounts: number[];
  /** Defaults to `[]`, unlike the two ratings lists above. */
  movie_excludes: string[];
}

/**
 * The SAME binding as the engine sees it — `engine/routing.js bindingFrom()`, a port of
 * Python `config._binding_from`.
 *
 * Deliberately NOT `Binding`, and not convertible without care:
 *   * `allowed_ratings` / `movie_ratings` are `Set<string>` (the engine membership-tests
 *     them per item, thousands of times per scan) or null for "no cap".
 *   * `watch_count_accounts` is null when empty, not `[]` — callers fall back to the env
 *     `WATCH_COUNT_ACCOUNTS` on null, and an empty array would silently mean "no accounts".
 *   * `account_id` is left as Python's `int(...)`-coerced value, so a numeric string from
 *     YAML stays whatever `toInt` returned.
 *
 * Consumers: engine/select.js, engine/rotation.js, providers/plex.js, session.js.
 */
export interface EngineBinding {
  plex_user: string | null;
  account_id: number | null;
  user_uuid: string | null;
  allowed_ratings: Set<string> | null;
  movie_ratings: Set<string> | null;
  watch_count_accounts: number[] | null;
  movie_excludes: string[];
}

// --- provider blocks + definitions ------------------------------------------- //

/**
 * One `{provider, profile, libraries}` source block — `providers/blocks.js normalizeBlock()`.
 * The shape is a LIST from day one; never a scalar, never provider identity smuggled into
 * a library id.
 */
export interface ProviderBlock {
  provider: string;
  /**
   * Provider-SCOPED and means different things per provider: a Plex Home profile the
   * Shield switches to, versus which Kavita user owns the reading list.
   */
  profile: string | null;
  /** Bare provider-scoped strings — never prefixed with `plex:` / `kavita:`. */
  libraries: string[];
  /** Kavita only: chapters to read before switching series. Absent on a Plex block. */
  batch?: number;
  /**
   * READ-TIME marker: this block was SYNTHESIZED by `blocksForSet()` for a set written
   * before blocks existed. It must never be written back to disk, or a re-read would
   * treat a synthesized block as a real one. `sets.js writableBlocks()` drops it.
   */
  implicit?: boolean;
}

/** The on-disk projection of a block — `sets.js writableBlocks()`. Omits `implicit`, and
 * omits every empty knob rather than writing a null. */
export interface WritableProviderBlock {
  provider: string;
  profile?: string;
  libraries?: string[];
  batch?: number;
}

/** A configured backend — `providers/config.js normalizeDefinition()` plus the implicit
 * Plex/Kavita definitions built from deploy-time env. */
export interface ProviderDefinition {
  id: string;
  /** Lower-cased. This build knows `plex` and `kavita`; anything else throws in providerFor. */
  kind: string;
  label: string;
  /** Trailing slashes stripped. `''` for Plex, which is configured by env, not by URL here. */
  base_url: string;
}

// --- the set registry (sets.yaml, WEB API side) ------------------------------ //

/**
 * Fields `sets.js normalize()` emits for EVERY set regardless of source. Split out only so
 * the two variants below read as the discriminated pair they are.
 */
interface SetRegistryCommon {
  /**
   * PLAYBACK LENGTH — how many ITEMS this set plays in one sitting, or `'infinite'`.
   * `null` = it has never said, so it follows `length_default` below.
   *
   * On every kind of set since 2026-08-17, because three of the four hardcoded it and the
   * fourth called it a window: "What we _really_ need is a way to specify or configure the
   * number of movies/episodes to watch in a given setting" (owner).
   */
  length: number | 'infinite' | null;
  /**
   * What `length: null` resolves to for THIS set — its kind's own historical behaviour (a
   * rewatch pool 1, a filtered or curated pool 12, an ordered queue 1).
   *
   * Sent rather than re-derived in the browser: the rule keys off `source` × `behavior` ×
   * `kind`, and a second copy of it in the bundle is how the editor ends up chipping the
   * wrong option "Default".
   */
  length_default: number;
  /**
   * Announce, when this sitting finishes, that the room should be shut down.
   *
   * The app only PUBLISHES it (`queuepilot/resp/finished`); HA owns anything with a power
   * cable. "The whole system" is a TV, a receiver and a Shield, and whether to honour the
   * request — who is still in the room, what time it is — is exactly the judgement that
   * belongs in an automation rather than in a queue builder.
   */
  power_off_when_done: boolean;
  /** IMMUTABLE — HA automations / NFC cards / MQTT reference it. */
  id: string;
  label: string;
  /** Free-form ('movies' | 'anime' | 'cartoons' | …); defaults to 'movies'. Not an enum
   * on disk, and normalize() does not constrain it, so it is not one here. */
  kind: string;
  sections: number[];
  item_sections: number[];
  blocklist: string[];
  /** Rotation: mirrored from `profiles[0]`. Queue: read from the top level. */
  allowed_ratings: string[] | null;
  movie_ratings: string[] | null;
  movie_excludes: string[];
  watch_count_accounts: number[];
  plex_user: string | null;
  account_id: number | null;
  user_uuid: string | null;
  /** null on a queue set; rotation sets default to 'both'. */
  mode: SetMode | null;
  audio_language: string | null;
  /**
   * Gate a curated queue to a Plex Home profile. Rotation channels are ungated by design,
   * so normalize() still emits the field for them but the engine never reads it there.
   */
  requires_profile: string | null;
  /** ALWAYS a list, never null — a legacy set reports its one implicit Plex block. */
  providers: ProviderBlock[];
  delivery: Delivery;
  /** The words this set's medium is described in, from its own provider. See `sets.ts`. */
  vocabulary: ProviderVocabulary;
  /**
   * The KIND of backend this set draws from (`plex` / `kavita`), for the UI's
   * `[data-provider]` accent scoping.
   *
   * The kind and not the provider ID, because a second Kavita added from the connector
   * surface has its own id (`my-kavita`) and must still come out Kavita-green — keying the
   * stylesheet on ids would silently drop such a queue back to the neutral accent.
   */
  provider_kind: string;
  /** Per-scan cap; blank/<=0 = no limit. Applies to queues AND channels. */
  max_items: number | null;
  /** `enabled: false` is the only falsy form — absent reads as enabled. */
  enabled: boolean;
}

/** A curated queue as the web API reports it (`source: 'queue'`). */
export interface QueueSet extends SetRegistryCommon {
  source: 'queue';
  /** Never mark entries done (a non-consuming / playlist queue). `reel` implies it, and
   * normalize() reports both so the UI prefill matches the engine. */
  keep_completed: boolean;
  /** Play the whole lineup every scan. */
  reel: boolean;
  /** TTL string ("24h"/"7d"/…) or null = keep finished entries forever (the default). */
  remove_completed_after: string | null;
  batch_stops_at: BatchStop;
  /**
   * This queue's DEFAULT batch: how many items one entry contributes per visit when the
   * entry says nothing. null = the engine default (env `QUEUE_SERIES_DEFAULT`, which is 1).
   *
   * Per QUEUE and not global, because the right number differs by medium: "For Plex, 1
   * episode is no big [deal], but for Webtoons and Manga I'd prefer to default to 3
   * chapters — by choice for this queue" (owner, 2026-08-15). A per-entry `episodes:` still
   * wins over it.
   */
  episodes: number | null;
  /**
   * How many VOLUMES one volume-based entry contributes per visit. Independent of
   * `episodes` — a volume is a collection of chapters, so the chapter count must not
   * apply. null = 1. Sparse on disk the same way `episodes` is.
   */
  volumes: number | null;
}

/** A dynamic channel as the web API reports it (`source: 'rotation'`). */
export interface RotationSet extends SetRegistryCommon {
  source: 'rotation';
  /** ALWAYS >= 1 entry: synthesized from the legacy top-level fields when `profiles:` is
   * absent, which is why `has_explicit_profiles` exists to tell the two apart. */
  profiles: Binding[];
  /** True only when the FILE carried a real `profiles:` array. The `set:"auto"` router and
   * the web editor branch on this — a synthesized single binding must not qualify. */
  has_explicit_profiles: boolean;
  /** UI-seed hint only (a binding's `plex_user`); the engine ignores it. */
  default_profile: string | null;
  /** A legacy tier kept readable during the migration soak: hidden from pickers, skipped
   * by the auto router, still playable by id. */
  superseded_by: string | null;
  behavior: SetBehavior | null;
  /**
   * How many items this channel's lineup holds. null = the engine default (env
   * `ROTATION_LENGTH`, which is 12).
   *
   * The SIZE to `episodes`'s per-entry share, and per SET because runtime differs by card:
   * 12 is four hours of Shows and half an hour of Shorts.
   */
  /** DEPRECATED — the 2026-08-17 spelling of `length: 'infinite'`, still reported (and still
   *  read by the engine) so a file written before the rename keeps working. */
  refill: boolean;
  /** What a FINISHED series does: `'restart'` (back to its start floor) or null = drop. */
  on_complete: 'restart' | null;
  /** Explicit curated members ([] = pure dynamic rule pool). */
  members: MemberValue[];
  /** Per-show manual start floors, keyed by ratingKey. */
  starts: Record<string, Start>;
  /** Per-show weights, keyed by ratingKey (or `section-<id>` for a whole item bucket).
   * A weight of 1 is the default and is DROPPED rather than stored. */
  weights: Record<string, number>;
  /**
   * Per-show `on_complete` overrides, keyed exactly as `starts` / `weights` are
   * (`section-<id>` for a whole item bucket).
   *
   * THREE states, which is why it stores a value rather than a set of names: absent = follow
   * the set's own `on_complete`, `'restart'` = start this show over, `'drop'` = let it finish.
   * The third is the point - a pool set to restart everything needs a way to say "except this
   * one", and a boolean could only express the other direction.
   */
  on_complete_by_show: Record<string, 'restart' | 'drop'>;
}

/**
 * One entry in the registry the web API serves (`GET /api/sets`) — the return of
 * `sets.js normalize()`, discriminated on `source`.
 *
 * NOT the shape the engine runs on: see `RoutingSetCfg`.
 */
export type SetRegistryEntry = QueueSet | RotationSet;

/** `sets.js readRegistry()` — the whole registry in file order. */
export interface SetRegistry {
  sets: SetRegistryEntry[];
}

/**
 * One member of a rotation channel's `members:` list, in the accepted on-disk forms
 * (`sets.js memberWriteValue()`, mirroring queues.py): a bare ratingKey / title string,
 * or a mapping. `describe()` in engine/resolve.js parses either.
 */
export type MemberValue = string | MemberObject;

export interface MemberObject {
  ratingKey?: string;
  collection?: string;
  title?: string;
  /** How many episodes this member contributes per visit. */
  episodes?: number;
  /** Slots per round. 1 is the default and is never written. */
  weight?: number;
  start?: Start;
}

// --- the set registry (sets.yaml, ENGINE side) ------------------------------- //

/**
 * The OTHER set shape, and deliberately not the one above: `engine/routing.js loadSets()`,
 * a port of the routing-relevant slice of Python `config._load_sets_yaml`.
 *
 * Why it differs, field by field, and why merging it with `SetRegistryEntry` would be a
 * behaviour change rather than a cleanup:
 *   * `sections` becomes `episodic_sections`, and a QUEUE with no sections defaults to
 *     `[SEC_MOVIES]` — the web shape leaves it `[]`.
 *   * bindings are `EngineBinding` (ratings as `Set`), not `Binding`.
 *   * a queue set is given HARDCODED admin identity (`plex_user: 'Bob (admin)'`,
 *     `account_id: 1`, `watch_count_accounts: [1]`), which the web shape never invents.
 *   * the optional passthroughs below are only SET WHEN PRESENT (mirroring config.py's
 *     truthiness) instead of being normalized to null — `cfg.requires_profile` reading
 *     `undefined` versus `null` is the difference, and a field the loader forgets is a
 *     SILENTLY DISABLED feature, not a missing one.
 *   * `starts` / `weights` / `members` are carried VERBATIM off the YAML here, not cleaned
 *     — so their values are less constrained than the web shape's.
 *
 * Consumers: session.js, engine/resolve.js, engine/select.js, playback.js.
 */
interface RoutingSetCfgCommon {
  label: string;
  kind: string | null;
  enabled: boolean;
  mode: string | null;
  behavior: string | null;
  /** The set's episodic library ids. Named for what Python calls them. */
  episodic_sections: number[];
  item_sections: number[];
  plex_user: string | null;
  account_id: number | null;
  user_uuid: string | null;
  allowed_ratings: Set<string> | null;
  movie_ratings: Set<string> | null;
  watch_count_accounts: number[] | null;
  /** Present on the queue branch and on the rotation branch's mirrored default binding. */
  movie_excludes?: string[];
  // --- optional passthroughs: ABSENT, not null, when the file omits them --------
  requires_profile?: string;
  remove_completed_after?: string;
  include_specials?: true;
  batch_stops_at?: string;
  /** The set's default batch — how many items one entry contributes per visit. See
   *  resolve.ts `setBatch()`; entry `episodes:` overrides it, env is the floor. */
  episodes?: string;
  /**
   * How many VOLUMES one volume-based entry contributes per visit. Independent of
   * `episodes` — a volume is not a chapter. Absent = 1.
   */
  volumes?: string;
  /**
   * How many items this set's LINEUP holds — the whole scan, not one entry's share. The
   * SIZE to `episodes`'s per-entry share: a rotation channel of `length: 30` still hands
   * each show `episodes` at a time, it just keeps going until it has 30.
   *
   * Per SET and not global, because the right number depends on how long an item runs.
   * `ROTATION_LENGTH` = 12 is four hours of Shows and half an hour of Shorts, and the
   * Shorts card ran out mid-evening (owner, 2026-08-17). Absent = env ROTATION_LENGTH.
   *
   * Rotation channels only, today. Curated queues size themselves from their entries, and
   * Kavita reads `limit ?? max_items ?? ROTATION_LENGTH` — both are follow-up work.
   */
  length?: string;
  /**
   * `refill: true` — keep this channel's lineup topped up instead of letting it end.
   *
   * `length` stops meaning "the whole evening" and starts meaning "the WINDOW": how many
   * items are queued ahead at any moment. A top-up tick tops it back up to that window
   * whenever fewer than `TOPUP_AT` remain.
   *
   * Not spelled `length: all`. A single infinite lineup would mean queueing the entire
   * eligible pool up front — 442 items on the live Shorts channel — which is a slow scan on
   * a card someone just tapped and is stale the moment progress moves. The owner asked for
   * exactly the window shape: "it'd load up X number in the queue, and then add more as you
   * started getting close to the end of the queue" (2026-08-17).
   */
  refill?: true;
  /**
   * What happens to a SERIES that has no unwatched episodes left, on a refilling channel:
   * `restart` puts it back at episode 1, `drop` retires it from the lineup. Absent = drop.
   *
   * Only consulted when the show is genuinely finished — NOT when the current lineup merely
   * stopped drawing from it. Those are different questions and conflating them would restart
   * a show every window.
   */
  on_complete?: string;
  audio_language?: string;
  /** Always set (null when uncapped), unlike the passthroughs above it. */
  max_items: number | null;
  /** Carried VERBATIM and uninterpreted; providers/blocks.js owns normalization, and
   * absence is NOT defaulted to a Plex block here. */
  providers?: unknown[];
}

export interface RoutingQueueCfg extends RoutingSetCfgCommon {
  source: 'queue';
  /** Mirrors of `episodic_sections` that resolve.js reads first. */
  queue_sections: number[];
  queue_section: number | undefined;
  item_sections: [];
  reel: boolean;
  keep_completed: boolean;
}

export interface RoutingRotationCfg extends RoutingSetCfgCommon {
  source: 'rotation';
  /** Raw off the YAML: `{ratingKey: {season?, episode?, series?}}`, uncleaned. */
  starts: Record<string, Start>;
  /** Raw off the YAML: `{ratingKey | 'section-<id>': n}`, uncleaned. */
  weights: Record<string, number>;
  /** Raw off the YAML: `{ratingKey | 'section-<id>': 'restart'|'drop'}`, uncleaned.
   *  Absent, or unrecognised, follows the set's own `on_complete`. */
  on_complete_by_show: Record<string, string>;
  blocklist: string[];
  /** Raw queues.yaml-style member values; `describe()` parses them. */
  members: MemberValue[];
  profiles: EngineBinding[];
  has_explicit_profiles: boolean;
  superseded_by: string | null;
}

export type RoutingSetCfg = RoutingQueueCfg | RoutingRotationCfg;

/** `engine/routing.js loadSets()` returns this, or null to KEEP CURRENT SETS (file absent,
 * unreadable, or empty) — matching Python. null is not "no sets". */
export interface RoutingRegistry {
  sets: Record<string, RoutingSetCfg>;
  order: string[];
}

// --- queues.yaml entries ----------------------------------------------------- //

/**
 * Everything an entry mapping can carry BESIDES its identity (`queues.js splitEntry()`).
 * Rewrites preserve extras verbatim, so setting one override never drops another writer's
 * field — which is why this is open-ended rather than a closed set.
 */
export interface EntryExtras {
  /** How many episodes this entry contributes per visit. */
  episodes?: number;
  /**
   * How many VOLUMES this entry contributes per visit. Independent of `episodes:` —
   * a volume is a collection of chapters, not a chapter, so the chapter count must
   * not apply to a volume-based series. Absent / 1 = one volume.
   */
  volumes?: number;
  /** Slots per round when the set is randomized. */
  weight?: number;
  start?: Start;
  /** Written only for 'member'/'season'; "none" DROPS the key. */
  batch_stops_at?: string;
  /** The Python service's keep-and-tag marker for a finished entry. */
  done?: boolean;
  /** Epoch SECONDS, stamped alongside `done: true`. A hand-marked done with no timestamp
   * reads as null and is never auto-swept. */
  done_at?: number;
  /**
   * Epoch SECONDS this entry joined the queue.
   *
   * Load-bearing for any provider whose backend counts LIFETIME progress. A board game
   * with twenty plays behind it and a batch of three would be finished the moment it was
   * queued; progress is counted from this stamp instead. Absent on a hand-written entry,
   * which is stamped on first read rather than treated as "since the beginning of time".
   */
  queued_at?: number;
  collection?: string;
  [extra: string]: unknown;
}

/**
 * One entry as it appears on disk: a bare title/ratingKey scalar, or a mapping.
 * `entryKey()` accepts both, and a numeric-looking string is treated as a ratingKey.
 */
export type EntryValue = string | number | ({ ratingKey?: string | number; title?: string } & EntryExtras);

/** One entry as `queues.js entriesOf()` reports it. Entries whose key is null are dropped
 * before this, so `key` is non-null here. */
export interface QueueEntry {
  /** `rk:<ratingKey>` or `title:<title>` — MUST match Python `queues.entry_key`. */
  key: string;
  value: EntryValue;
  done: boolean;
  /** null when absent or non-numeric. */
  doneAt: number | null;
}

/** `queues.js splitEntry()` — an entry decomposed into identity + everything else. */
export interface EntryIdentity {
  ratingKey: string | null;
  title: string | null;
  extras: EntryExtras;
}

// --- Plex wire + client seam ------------------------------------------------- //

/**
 * The subset of a Plex `MediaContainer` the engine reads. Every field is optional because
 * Plex omits rather than zeroes (`viewCount` is simply absent at 0), and a corpus replay
 * returns exactly what was recorded.
 */
export interface PlexMediaContainer {
  Metadata?: PlexMetadata[];
  Directory?: PlexDirectory[];
  size?: number;
  totalSize?: number;
}

export interface PlexDirectory {
  key?: string | number;
  type?: string;
  title?: string;
}

/** One Plex item. Only the fields `engine/select.js`, `plex.js` and `tiles.js` actually
 * read are named; the index signature is what keeps a raw container usable without a cast. */
export interface PlexMetadata {
  ratingKey?: string | number;
  key?: string;
  guid?: string;
  type?: string;
  title?: string;
  year?: number;
  index?: number;
  parentIndex?: number;
  grandparentTitle?: string;
  grandparentRatingKey?: string | number;
  /** History rows carry the PATH (`/library/metadata/<rk>`), not the bare key. */
  grandparentKey?: string;
  duration?: number;
  extraType?: number;
  contentRating?: string;
  viewCount?: number;
  viewOffset?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
  thumb?: string;
  Collection?: { tag?: string }[];
  [field: string]: unknown;
}

/**
 * The engine's Plex seam — the ONLY thing engine/*.js is allowed to know about Plex I/O.
 * Undeclared until now; inferred from its two implementations, which is what makes the
 * parity gates meaningful:
 *   * `engine/plex-live.js liveClient()` — async, undici, via server/src/plex.js.
 *   * `engine/plex-replay.js replayClient()` — SYNCHRONOUS, reads the recorded corpus off
 *     disk. Its methods return plain values, not Promises.
 *
 * Both are valid: every engine call site awaits, and `await` on a plain value is a no-op.
 * That is why the return types are `T | Promise<T>` and must stay that way — narrowing
 * them to `Promise<T>` would make the replay client (and therefore the parity gate)
 * untypable.
 */
export interface PlexClient {
  /**
   * GET `path` and return the response's `MediaContainer` (`{}` when absent).
   * `token` null = the admin/default `X-Plex-Token`; a managed account's token otherwise.
   * The replay client buckets by token identity, so passing null vs a token picks a
   * different corpus directory — it is not an optimization detail.
   */
  container(path: string, token?: string | null): PlexMediaContainer | Promise<PlexMediaContainer>;
  /**
   * Mint (or, in replay, echo) the managed-user token for `uuid`. A null/empty uuid means
   * "use the default token" and returns null.
   */
  accountToken(uuid: string | null | undefined): string | null | Promise<string | null>;
}

// --- selection engine pool --------------------------------------------------- //

/**
 * One playable item inside a bucket.
 *
 * Two producers with deliberately different fill:
 *   * `engine/select.js showEpisodes()` — a real episode, everything populated.
 *   * `engine/select.js unwatchedBuckets()`'s item-section branch (Shorts) — only
 *     ratingKey/title/show, with `season`/`episode` explicitly null.
 * So everything past the first three is optional, and `season`/`episode` are nullable.
 */
export interface PoolItem {
  ratingKey: string;
  title?: string;
  /** The SERIES title for an episode; the literal 'Shorts' for an item-section entry. */
  show?: string;
  season?: number | null;
  episode?: number | null;
  duration?: number;
  type?: string;
  extraType?: number;
  viewCount?: number;
  viewOffset?: number;
}

/**
 * One bucket of the rotation pool — a show and its ordered unwatched episodes, an item
 * section as a single bucket, or (engine/rotation.js memberBuckets) one explicit member.
 *
 * `weight` is the whole weight contract: `engine/weight.js weightOf(bucket)` reads
 * `bucket.weight` and normalizes absent/blank/<1 to 1, so an unweighted channel is
 * bit-for-bit what it was before weights existed. Anything that constructs a bucket may
 * therefore omit it, but must never set it to 0.
 */
export interface Bucket {
  /** Display name: the show title, or 'Shorts' for an item-section bucket. */
  show: string;
  /** A ratingKey, or the synthetic `section-<id>` for an item-section bucket. */
  ratingKey: string;
  episodes: PoolItem[];
  multi_season?: boolean;
  weight?: number;
}

// --- provider seam ----------------------------------------------------------- //

/** One library row for the queue editor's provider block. Ids are provider-scoped strings. */
export interface ProviderLibrary {
  id: string;
  title: string;
  /** Kavita passes its numeric library type through; Plex omits it. */
  type?: number;
}

/** One search hit from a provider's own search (`providers/kavita.js search()`). */
export interface ProviderSearchHit {
  id: string;
  title: string;
  libraryId: string;
  libraryTitle?: string | null;
  format?: number | null;
  type: string;
}

/** `providers/kavita.js cover()` — bytes, so the API key never reaches the browser. */
export interface ProviderCover {
  buffer: Buffer;
  contentType: string;
}

/**
 * One row from a provider's `tiles()` — the provider-side answer `providers/tiles.js`
 * turns into a poster tile. Deliberately NOT a `Tile`: it is the provider's own vocabulary
 * (its item id, its unread count, its next chapter), and the mapping to tile fields —
 * including `cover` and `unit`, which only the tile shape has — happens in one place above
 * the seam. A vanished item resolves to `null` rather than throwing.
 */
export interface ProviderTileRow {
  id: string;
  /** Optional for the same reason `ProviderSearchHit.title` is asserted: `name` is a remote
   * field, and a nameless series is a provider-side anomaly, not a shape this invents. */
  title?: string;
  libraryId: string;
  format?: number | null;
  /** Items left to consume — chapters for Kavita, the "how much is waiting" a tile means. */
  unreadCount: number;
  /** The next item to play/read, or null when there is nothing left. */
  next: KavitaPlayItem | BoardGamesPlayItem | null;
}

/**
 * One pool entry from a PULL provider's `pool()`. Deliberately the Plex preview bucket
 * shape (`ratingKey`/`show`/`unwatched`/`next`) so the Channels grid needs no second
 * render path — here `ratingKey` is an OPAQUE provider item id (a Kavita seriesId), which
 * is unambiguous only because a queue draws from exactly one provider.
 */
export interface ProviderPoolBucket {
  ratingKey: string;
  show: string;
  /** Chapters left, not series left. */
  unwatched: number;
  isMember: boolean;
  libraryId: string;
  next: {
    ratingKey: string;
    title: string;
    /** Chapters have no season; `episode` carries the chapter number. */
    episode: number | null;
    season: null;
  } | null;
}

/**
 * What `buckets()` hands back. `play` is the ordered lineup and is the only field every
 * provider sets; the rest are the curated-queue resolver's own bookkeeping, returned
 * UNCHANGED because session.js's write side (markDone/clearDone/sweepCompleted against
 * queues.yaml) is provider-neutral.
 */
export interface BucketsResult {
  play: PlayItem[];
  /** Resume offset in ms for the HEAD item (curated queues). */
  offset?: number;
  /** The item to publish as last-played. */
  last?: PlayItem | null;
  /** Entry keys that finished. */
  done?: string[];
  /** Entry keys that could not be resolved this scan. */
  unresolved?: string[];
  /** Entry keys marked done that are playable again — cleared before the scan plays. */
  revived?: string[];
  /** Entry keys to persist as done after this scan. */
  newlyDone?: string[];
  /** Set by the rewatch branch, which returns a single pick rather than a lineup. */
  rewatch?: boolean;
  /** Kavita returns its buckets alongside `play` so the caller can render the pool. */
  buckets?: unknown[];
  /**
   * The `only` entry key that named an entry the set no longer holds — set INSTEAD of a
   * lineup, and only on the one-entry path. session.js branches on it for its own error
   * sentence ("has no entry X any more"), which is why it is a key rather than a boolean.
   */
  unknownEntry?: string;
}

/** A Plex lineup item, as session.js consumes it. */
export interface PlexPlayItem {
  ratingKey: string | number;
  title?: string;
  show?: string;
  season?: number | null;
  episode?: number | null;
  type?: string;
  viewOffset?: number;
  duration?: number;
}

/**
 * A Kavita lineup item (`providers/kavita.js chapterItem()` + the interleave's additions).
 *
 * NOTE: it has NO `ratingKey`, no `season`, no `episode` — see the note on `PlayItem`.
 */
export interface KavitaPlayItem {
  chapterId: number | string;
  seriesId: number | string;
  title: string;
  number?: number | string;
  /** `volume` when this item is a whole volume rather than a chapter — see `MediaUnit`. */
  unit?: MediaUnit;
  pages?: number;
  pagesRead?: number;
  bucket?: string;
  seriesFormat?: number | null;
  libraryId?: number | string | null;
}

/**
 * A lineup item, from either provider.
 *
 * LATENT MISMATCH (do not paper over): `session.js` treats every play item as Plex-shaped
 * — it builds `SESSION.queue` with `String(it.ratingKey)` and reads `it.season`/`it.episode`
 * — and a Kavita item has none of those. Today that is unreachable because the pull path
 * never runs through `startSession`, but the union is what makes the gap visible instead of
 * letting `any` hide it.
 */
/**
 * A board-game lineup item: one PLAY of one game.
 *
 * There is nothing to build on the picker's side — no reading list, no play queue — so an
 * item is only ever "this game, play N of M". `slot` is which play of the entry's batch
 * this is, so a tile can say "Play 2 of 3" without re-counting.
 */
export interface BoardGamesPlayItem {
  gameId: string;
  title: string;
  /** Always `'play'`. Present so a mixed lineup can be told apart by unit alone. */
  unit?: MediaUnit;
  /** Which play of the entry's batch this is. Named `number` to match what the tile layer
   * already reads off a next-up item, so a game needs no second mapping path. */
  number?: number | string;
  slot?: number;
  of?: number;
  bucket?: string;
}

export type PlayItem = PlexPlayItem | KavitaPlayItem | BoardGamesPlayItem;

/** Plex's runtime artifact: a playQueue descriptor. Fused with the push in `handoff()`. */
export interface PlexArtifact {
  provider: string;
  kind: 'plex';
  ratingKeys: string[];
  offset: number;
  setName: string | null;
  /** The account the lineup was SELECTED as must be the account it is PLAYED as, so the
   * binding's uuid rides on the artifact rather than being re-derived from the set. */
  userUuid: string | null;
}

/** Kavita's runtime artifact: a persistent Reading List, rebuilt per launch. */
export interface KavitaArtifact {
  provider: string;
  kind: 'kavita';
  readingListId: number | string | null;
  title: string;
  setName: string;
  head: KavitaPlayItem | null;
  count: number;
}

/**
 * Board Game Picker's runtime artifact: a DESCRIPTOR, and deliberately nothing more.
 *
 * Plex materializes a playQueue and Kavita rebuilds a Reading List because both of those
 * backends own a lineup object. The picker does not, and inventing a "tonight's list"
 * inside it would put a second queue in the app whose whole job is to not be one. So
 * `materialize()` here just names the head game and how many plays it still owes.
 */
export interface BoardGamesArtifact {
  provider: string;
  kind: 'board-game-picker';
  gameId: string;
  url: string;
  setName: string;
  /** Plays still owed on the head entry when the lineup was built. */
  remaining: number;
  head: BoardGamesPlayItem | null;
  count: number;
}

export type ProviderArtifact = PlexArtifact | KavitaArtifact | BoardGamesArtifact;

/** What a PUSH handoff returns (playback.js playRatingKeys / castPlay, and driver.js
 * driveToPlaying, which returns the same object or its own error/cancel form). */
export interface PushResult {
  queued?: number;
  played?: boolean;
  mode?: 'client' | 'cast';
  client?: string | null;
  error?: string;
  cancelled?: boolean;
  /** driver.js internals, surfaced for the log/state payload only. */
  _profile?: string | null;
  _diag?: unknown;
}

/** What a PULL handoff returns: a URL to open, and no device/session to wait for. */
export interface PullResult {
  mode: 'pull';
  url: string | null;
  readingListId?: number | string | null;
  awaiting?: null;
  error?: string;
}

export type HandoffResult = PushResult | PullResult;

/** Context for `buckets()`. The two providers read disjoint subsets of it: Plex uses
 * setName/cfg/binding/token/kind/lastMovieRk, Kavita uses cfg/libraries/batch/limit. */
/**
 * One curated entry, reduced to what a PULL provider needs to build a lineup from it.
 *
 * `batch` is the entry's own per-visit override; absent means "follow the queue's default".
 */
export interface CuratedEntryRef {
  /** The provider's own item id (a Kavita seriesId), off the entry's `ratingKey`. */
  id: string;
  batch?: number | null;
  /**
   * Epoch seconds this entry was queued — `EntryExtras.queued_at`. Providers that count
   * lifetime progress on their own side measure from here; the rest ignore it.
   */
  queuedAt?: number | null;
  /**
   * Per-visit VOLUME count for a volume-based series. Independent of `batch`
   * (which is chapters). Absent = follow the queue's volume default (1).
   */
  volumes?: number | null;
  /**
   * The entry's manual START floor, if any. Earlier unread chapters are skipped
   * from the pick and never marked read — the same rule Plex's start floor has
   * always meant. Absent = automatic next-unread.
   */
  start?: Start | null;
}

export interface BucketsContext {
  setName?: string;
  cfg?: RoutingSetCfg | Record<string, unknown>;
  binding?: EngineBinding;
  token?: string | null;
  kind?: string;
  lastMovieRk?: string | null;
  libraries?: string[];
  /**
   * The curated ENTRIES of a `source: queue` set, in stored order.
   *
   * When present these ARE the lineup. `libraries` is the pool a set draws from when it has
   * no entries of its own — which is the RULE-based case, not the curated one. Conflating
   * the two is what made the live "Manga & Webtoons" reading list hold twelve series off the
   * library shelf and only one of the ninety-three the owner had actually added.
   */
  entries?: CuratedEntryRef[];
  /**
   * Shuffle which entries lead this launch. True for a `kind: anime` set — the same rule
   * `playbackRoutes` uses to tell the engine a curated set plays in random order, and the
   * one the editor's own copy promises ("members play in random order").
   */
  isRandomOrder?: boolean;
  batch?: number | null;
  /**
   * How many VOLUMES one volume-based series contributes per visit. Separate from
   * `batch` (chapters). Absent / null = 1. The chapter count must not leak onto
   * a volume — a volume is a collection of chapters, not a chapter.
   */
  volumeBatch?: number | null;
  limit?: number | null;
  /**
   * "Play THIS entry": an ENTRY KEY that narrows a curated set's lineup to one member.
   * Web-only — no physical card sends it, and only the curated-queue branch reads it.
   */
  only?: string | null;
}

/** Options for `handoff()`. Plex reads all of them; Kavita ignores them entirely. */
export interface HandoffOptions {
  useFsm?: boolean;
  requiredProfile?: string | null;
  device?: Device | null;
  cancel?: CancelFlag | null;
  setLabel?: string | null;
}

/**
 * THE PLUGIN SEAM. Documented until now only as a comment at the top of
 * `providers/index.js`; the two real implementations are `providers/plex.js` and
 * `providers/kavita.js`.
 *
 * Nothing above this interface may branch on `kind` — if it does, the seam has leaked.
 *
 * REQUIRED vs OPTIONAL is not a style choice: the optional members below are the ones
 * call sites actually guard with `typeof p.<m> !== 'function'` (server.js:431/863/879/896),
 * and `pool` is reached only on the `delivery === 'pull'` branch (server.js:946). Declaring
 * one of those required would let a third backend typecheck and then 500 at runtime.
 */
export interface Provider {
  id: string;
  kind: string;
  label: string;
  /** Static, not a method — the UI reads it to decide whether "Play on <device>" exists. */
  delivery: Delivery;
  /**
   * Static, like `delivery`, and OPTIONAL for the same reason the members below are: every
   * reader spells it `provider.unit || 'episode'`, so a provider that predates the field
   * keeps counting in episodes rather than failing to typecheck.
   */
  unit?: MediaUnit;
  /**
   * Does this provider count progress from WHEN AN ENTRY WAS QUEUED rather than from the
   * backend's lifetime total?
   *
   * A capability, not a kind check — the launcher stamps `queued_at` only for a provider
   * that says it needs one, so no other queue's YAML grows a key it will never read.
   * Board Game Picker needs it because its play log is the household's book of record and
   * goes back years.
   */
  stampsQueuedAt?: boolean;

  // --- required -------------------------------------------------------------- //
  buckets(ctx: BucketsContext): Promise<BucketsResult>;
  /** Plex returns the watched ratingKey set; Kavita returns per-item read state. */
  progressState(ctx: BucketsContext & { artifactId?: string | number | null }):
    Promise<Set<string>> | Promise<KavitaProgressState>;
  /** SYNC on Plex (it returns a descriptor), ASYNC on Kavita (it builds the list) — so both
   * shapes are declared and every caller must await. */
  materialize(
    items: PlayItem[],
    opts?: {
      offset?: number;
      setName?: string | null;
      /** The set's HUMAN label. Kavita paints it on the list's cover; the other providers
       *  have no persistent artifact to name and ignore it. */
      setLabel?: string | null;
      binding?: EngineBinding | null;
    },
  ): ProviderArtifact | Promise<ProviderArtifact>;
  /** ASYNC on Plex (it performs the drive), SYNC on Kavita (it builds a URL). */
  handoff(artifact: ProviderArtifact, opts?: HandoffOptions): HandoffResult | Promise<HandoffResult>;

  // --- optional: every call site guards these -------------------------------- //
  libraries?(): Promise<ProviderLibrary[]>;
  search?(q: string, opts?: { libraries?: string[] }): Promise<ProviderSearchHit[]>;
  cover?(itemId: string): Promise<ProviderCover>;
  /**
   * Record ONE unit consumed, on the provider's own side.
   *
   * Only a provider whose progress is a WRITE is expected to have this. Plex and Kavita
   * learn what was watched or read from the device that did it; Board Game Picker cannot —
   * a table has no telemetry — so "we played this" is a button someone presses, and it may
   * be pressed here rather than only in the picker.
   *
   * Guarded at the call site like every optional member; a provider without it answers 404.
   */
  logProgress?(itemId: string): Promise<{ ok: boolean; remaining?: number }>;
  pool?(opts: { libraries?: string[]; members?: string[] }): Promise<ProviderPoolBucket[]>;
  /**
   * Top up a PULL provider's persistent artifact — Kavita's reading list.
   *
   * Only a pull provider has one to top up: the push side's runtime artifact is a Plex
   * playQueue, which `topup.ts` extends directly because its id lives on the session rather
   * than being discoverable from the set. Guarded at the call site like every optional
   * member here.
   *
   * `build` is injected rather than called internally so the provider does not have to
   * re-derive the set's libraries and batch — the caller already resolved those to run
   * `buckets()`.
   */
  topupList?(opts: {
    setName: string;
    /** The set's human label. Kavita's list is TITLED with it, so a top-up that omits it
     *  cannot find a list built since the 2026-08-17 rename. */
    setLabel?: string | null;
    /** How many unread items to keep queued ahead. */
    window: number;
    /** Top up only when unread has fallen to this or below. */
    at: number;
    build: () => Promise<PlayItem[]>;
  }): Promise<{ ok: boolean; reason?: string; added?: number; trimmed?: number; unread?: number }>;
  /**
   * Resolve stored item ids to poster rows, INDEX-ALIGNED with `ids`. Optional and guarded
   * (`providers/tiles.ts` checks `typeof provider.tiles !== 'function'` and degrades the
   * whole set to unresolved tiles), because a provider that cannot answer this is a grid
   * of bare titles, not a 500.
   */
  tiles?(ids: Iterable<string>, entries?: CuratedEntryRef[]): Promise<(ProviderTileRow | null)[]>;
  /**
   * The "Start from…" picker's list of playable units, grouped the way the
   * modal already consumes (`seasons[].episodes[]`). Optional: a provider that
   * cannot answer degrades the picker to its "could not read" note rather than
   * a 500. `uuid` scopes watched/read marks to a profile, the same way the
   * Plex-only route did.
   */
  listUnits?(
    itemId: string,
    opts?: { uuid?: string | null },
  ): Promise<UnitList | null>;
  /**
   * Optional per the guarded-call-site rule, but note session.js:170 calls it UNGUARDED on
   * the push path — a push provider without it throws at start. Both real providers define
   * it, so this is a latent requirement of the push path rather than of the interface.
   */
  profileToken?(userUuid: string | null): Promise<string | null> | string | null;
  /**
   * Fill in a binding that names a profile but carries no ACCOUNT for it — the shape every
   * curated queue has, since `requires_profile` stores a display name and nothing else.
   * Returns the binding to use (the same object, or a filled copy); a provider that has no
   * per-profile identity simply omits this and the binding is used as-is.
   *
   * Called on the engine side of the seam, so `profileTitle` is a NAME and the provider owns
   * every media-specific step of turning it into one (Plex: the plex.tv Home-users join).
   */
  profileBinding?(
    binding: EngineBinding,
    profileTitle: string | null,
  ): Promise<EngineBinding> | EngineBinding;
  /** Kavita only, and currently called by nothing — kept declared so a future members
   * endpoint reaches for the existing method instead of inventing a second one. */
  resolveMembers?(ids: Iterable<string>): Promise<unknown[]>;
}

/** `providers/kavita.js progressState()` — the whole queue's completion state in one call. */
export interface KavitaProgressState {
  items: {
    chapterId: number | string;
    seriesId: number | string;
    order: number;
    pagesRead: number;
    pagesTotal: number;
    done: boolean;
    lastReadAt: string | null;
  }[];
}

// --- tiles ------------------------------------------------------------------- //

/** The next-up leaf a tile shows: `plex.nextEpisode()` for a show, `plex.collectionNext()`
 * for a collection. Optional throughout — a collection hit sets member fields a show hit
 * never does, and vice versa. */
export interface NextEp {
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  /** The total this next-up counts towards: "Play 2 OF 3". Only a provider that counts a
   * finite per-entry batch sets it; absent everywhere else. */
  of?: number | null;
  multiSeason?: boolean;
  member?: string;
  memberRatingKey?: string;
  memberYear?: number | null;
  position?: number | null;
  kind?: 'show' | 'movie';
  /** Which member the stored start point named — may be EARLIER than `member`. */
  startMember?: string;
  partiallyWatched?: boolean;
  viewOffset?: number;
  duration?: number;
}

/**
 * The COMMON tile fields — the return of `tiles.js resolveTile()`, which is the one
 * resolver shared by `/api/queues` and `/api/sets/:id/members`.
 *
 * The per-endpoint extras are NOT merged in here on purpose: each endpoint adds its own
 * (server.js ~:264 and ~:386), and folding them together would claim every tile carries
 * fields that only one route emits. See `QueueTile` / `MemberTile`.
 */
export interface Tile {
  resolved: boolean;
  ratingKey: string | null;
  type: string | null;
  /** The resolved title, or `displayFor(value)` when unresolved. */
  title: string;
  year: number | null;
  /** Collections only; null for everything else. */
  childCount: number | null;
  nextEp: NextEp | null;
  /**
   * The next-up LOOKUP threw, as opposed to answering "nothing left". A null `nextEp` means
   * both, and the tile says something different for each ("All watched" vs the neutral
   * "N in order"), so the failure is carried rather than collapsed into the same null.
   */
  isNextEpFailed: boolean;
  /** Mid-playback and unwatched — the exact state the engine resumes from. Per-EPISODE:
   * a movie reads its own viewOffset, a show/collection reads the next-up leaf's. */
  partiallyWatched: boolean;
  /** ms; 0 when not started / unknown. */
  viewOffset: number;
  duration: number;
}

/** A tile as `GET /api/queues` emits it (server.js ~:264-279). */
export interface QueueTile extends Tile {
  /** The queue entry's stable key. */
  key: string;
  /** `tiles.displayFor(value)` — the raw title string, for the editor. */
  raw: string;
  /**
   * Per-entry override of the set's chapter/episode batch. `null` = follow the set.
   * A stored `1` is a real override when the set default is not 1.
   */
  episodes: number | null;
  /** Per-entry override of the set's volume batch. `null` = follow the set. */
  volumes: number | null;
  weight: number;
  batch_stops_at: BatchStop;
  start: Start | null;
  /** A finished-but-kept entry; the grid greys it. */
  done: boolean;
}

/** A tile as `GET /api/sets/:id/members` emits it (server.js ~:386-395). */
export interface MemberTile extends Tile {
  /** Index into the STORED (unsorted) members array — what a write must address. */
  index: number;
  /** The ORIGINAL stored value (not the collection-mapped one), so a PATCH round-trips. */
  raw: MemberValue;
  start: Start | null;
  episodes: number;
  weight: number;
}

// --- devices ----------------------------------------------------------------- //

/**
 * An announced playback target — `devices.js`. Two producers, one shape:
 * `shieldEntry()` (the env-default Shield, always `default: true`, never de-registered)
 * and the plex.tv row mapping, which is always `mode: 'client'` / `default: false`.
 *
 * `default` is a wire field name and stays as-is despite the workspace `is`-prefix rule.
 */
export interface Device {
  id: string;
  name: string;
  /** `''` when the env didn't provide one (and the plex.tv sweep didn't fill it in). */
  machineIdentifier: string;
  uri: string | null;
  /** 'cast' is the Shield's own sidecar path and cannot be inferred for a foreign device,
   * so every plex.tv row is announced as 'client'. */
  mode: string;
  default: boolean;
  /** Epoch seconds, one value per announce round. */
  seen?: number;
}

// --- now playing ------------------------------------------------------------- //

/**
 * The retained `queuepilot/now-playing` payload.
 *
 * It arrives off MQTT from a Home Assistant automation — there is NO schema, no validator,
 * and no version on the wire. Every field is therefore optional, deliberately: the only
 * thing the code actually requires is that `ratingKey` and `state` MAY be there
 * (`server.js withContext()` bails when `ratingKey` is falsy, and only resolves context
 * while `state` is 'playing' or 'paused'). Do not promote a field to required because the
 * live automation happens to send it.
 */
export interface NowPlaying {
  state?: string;
  ratingKey?: string;
  title?: string;
  showTitle?: string;
  show?: string;
  /** Added by `server.js withContext()`, not by HA: null when not playing/paused or when
   * the lookup failed. */
  context?: PlayingContext | null;
  [field: string]: unknown;
}

/**
 * Which TILE the on-screen item belongs to — `plex.js playingContext()`. Cached per
 * ratingKey because the answer is immutable, so pause/resume storms cost nothing.
 */
export interface PlayingContext {
  ratingKey: string;
  type: string | null;
  /** An episode's grandparent IS its series, which is what a series tile stores. */
  showRatingKey: string | null;
  /** Collection membership comes back as name TAGS, and a collection tile is stored by
   * name ("Collection: <name>") — names are the only join available. */
  collections: string[];
}

// --- session ----------------------------------------------------------------- //

/**
 * `session.js SESSION.asDict()` — exactly these five fields, no more. Note the snake_case
 * `queue_len`: it is a wire name (it crosses MQTT to HA), not a local.
 */
export interface SessionState {
  kind: string | null;
  set: string | null;
  profile: string | null;
  queue_len: number;
  cursor: number;
}

/**
 * What actually lands on the state topic — `mqttd.js publishState()` merges `asDict()`
 * with a per-call `extra` and stamps `engine`. The `extra` keys below are every one any
 * caller passes (session.js, mqttd.js, driver.js).
 */
export interface PublishedSessionState extends SessionState {
  engine: string;
  /** A human sentence, read aloud verbatim by the HA status announcement automation. */
  error?: string;
  /** 'profile' while waiting for any profile, `profile:<name>` while waiting for one. */
  awaiting?: string;
  playback?: HandoffResult;
}

/**
 * The `extra` half of a state publish: everything a caller may merge on top of `asDict()`
 * before the publisher stamps `engine`. `boot` is mqttd's own connect marker and is the only
 * key not declared above.
 *
 * ONE declaration, shared by every side of the publish seam — the type of `session.js`'s
 * injected publisher, of `mqttd.js publishState()` that gets injected into it, and of the
 * copy `session.js` hands on to `driver.js`. It is deliberately not re-spelled per file:
 * three separate hand-written versions are how the driver came to call this publisher with
 * an argument list it never had (see the arity fix, 2026-08-15).
 */
export type PublishedStateExtra =
  Partial<Omit<PublishedSessionState, 'engine'>> & { boot?: boolean };

/**
 * The MQTT/API payload that starts a session (`session.js startSession()`).
 *
 * LATENT BUG: `target` is EITHER a device-registry id string OR a resolved `Device`
 * object, depending on who calls. `mqttd.js handleStart()` (~:54-58) swaps a string id for
 * the announced entry before calling in — but `session.js` itself does no such resolution
 * and passes `payload.target` straight to `playback`/`driver`, which read `.uri`, `.mode`
 * and `.name` off it. So an HTTP caller (or any future caller that skips mqttd) that sends
 * a string id gets a "device" whose every field is undefined, and playback silently falls
 * back to the env default instead of failing. This union is the honest type. DO NOT fix it
 * here — the fix is to resolve in one place, and that is a behaviour change.
 */
export interface SessionStartPayload {
  set?: string;
  kind?: string;
  profile?: string;
  target?: string | Device | null;
  /**
   * "Play THIS entry" — an entry key from the web grid's per-tile ▶. A physical card never
   * sends it; it only ever arrives from the UI, via `mqttc.play()`'s 5th argument.
   */
  only?: string;
}

// --- SSE --------------------------------------------------------------------- //

/** The `now` payload: the enriched now-playing snapshot plus which queue we STARTED
 * (authoritative in a way the Plex-side payload can't be). */
export interface SseNowPayload {
  now: NowPlaying | null;
  set: string | null;
}

/**
 * The four events `server.js broadcast()` (and the /api/events handshake) emit.
 *
 *   * `hello` — sent once on connect, payload always `{}`.
 *   * `now`   — the playing tile + active-queue badge. Also REPLAYED to a single client on
 *               (re)connect, so a slept phone tab reconciles without a refresh.
 *   * `state` — a play RESULT landing; drives toasts only, and is deliberately NOT replayed.
 *   * `data`  — the config changed (web edit, prune, SMB hand-edit). Payload always `{}`;
 *               receiving it also kicks the warm cache server-side.
 */
export type SseEvent =
  | { type: 'hello'; data: Record<string, never> }
  | { type: 'now'; data: SseNowPayload }
  | { type: 'state'; data: PublishedSessionState | Record<string, never> }
  | { type: 'data'; data: Record<string, never> };

// --- known trouble spots ----------------------------------------------------- //

/**
 * The cancel flag, duck-typed THREE different ways across the codebase and never declared:
 *   * `session.js cancelFlag()` (~:51-59) builds an object with all four members.
 *   * `session.js` reads `.isSet()` and calls `.set()` to cancel the prior start.
 *   * `driver.js isCancelled()` (~:44-50) probes `.isSet()` THEN `.is_set()`.
 *
 * The snake_case twin is a Python-parity artifact: `threading.Event` exposes `is_set`, and
 * the port kept accepting it so a caller written against the Python service still cancels.
 * Both names are therefore optional, and a caller may legitimately supply only one — use
 * `isCancelled()` from ./errors.js rather than probing by hand.
 */
export interface CancelFlag {
  /** Node/JS spelling. */
  isSet?: () => boolean;
  /** Python `threading.Event` spelling, still honoured by driver.js. */
  is_set?: () => boolean;
  /** Raise the flag. `session.js` calls this on the PREVIOUS start when a new one arrives. */
  set?: () => void;
  clear?: () => void;
}

/**
 * The genuine TRI-STATE returned by `cache.js getResolved()`:
 *
 *   * `undefined` — cache MISS (no row, an expired row, or the cache isn't ready).
 *   * `null`      — a cached NULL result: we asked Plex, Plex had nothing, and that answer
 *                   is itself cached so the miss isn't re-fetched every request.
 *   * `T`         — a hit.
 *
 * COLLAPSING THESE IS A BUG. `undefined ?? fetch()` and `null ?? fetch()` are the same
 * expression, so any `??`/`||` fallback turns every cached negative back into a live Plex
 * round-trip — which is precisely the cost the negative cache exists to avoid. Callers
 * must test `=== undefined` explicitly.
 */
export type CachedResolved<T> = T | null | undefined;

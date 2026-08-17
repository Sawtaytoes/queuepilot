/**
 * The wire shapes `server/src/server.js` actually sends. Hand-written rather than
 * generated, because the server is plain JS with no schema to generate from — and
 * hand-written types on an untyped server are a claim, not a proof, so every field
 * here was read off the route that emits it.
 *
 * If a third consumer of these ever appears the answer is a `contracts` package
 * like rip-deck's, not a second copy.
 */

/** A manual start point. A FLOOR, never a watched-write — decision
 * `2026-07-31-per-entry-start-episode-override`. */
export type StartPoint = {
  /** Collection entries only: which member series to begin at (a ratingKey, or a
   * title on a hand-written YAML entry — the engine matches either). */
  series?: string
  season?: number
  episode?: number
}

/** `plex.nextEpisode()` for a show, `plex.collectionNext()` for a collection. */
export type NextEp = {
  season?: number | null
  episode?: number | null
  title?: string | null
  /** The total this next-up counts towards: "Play 2 OF 3". Set only by a provider that
   * counts a finite per-entry batch (board games); absent for episodes and chapters. */
  of?: number | null
  /** False for every anime (Japan doesn't do American-style seasons), so the tile
   * drops the "S1". */
  multiSeason?: boolean
  // --- collection only ---
  member?: string
  memberRatingKey?: string
  memberYear?: number | null
  position?: number | null
  kind?: "show" | "movie"
  /** Which member the stored start point named — may be earlier than `member`. */
  startMember?: string
  /** This next-up leaf has a Plex viewOffset (started, unwatched) — mid-episode resume. */
  partiallyWatched?: boolean
  /** The leaf's resume offset in ms (0 when not started). */
  viewOffset?: number
  /** The leaf's runtime in ms (0 when unknown). */
  duration?: number
}

export type EntryType =
  | "show"
  | "movie"
  | "collection"
  | null

/** What an entry's next-up line counts: episodes (the default) or a reading queue's chapters. */
/**
 * What one lineup item IS, for wording only. Mirrors the server's `MediaUnit`.
 *
 * `volume` is a PER-ITEM refinement of `chapter`: one Kavita library holds volume-based
 * manga beside chapter-based webtoons, so the provider says "chapter" and an individual
 * item corrects it. Without it a whole volume renders as "Ch -100000" (Kavita's
 * no-chapter-subdivision sentinel).
 */
export type EntryUnit =
  | "episode"
  | "chapter"
  | "volume"
  | "play"

/** One resolved entry in a curated queue (`GET /api/queues`). */
export type QueueItem = {
  key: string
  raw?: string
  resolved: boolean
  ratingKey: string | null
  /**
   * A non-Plex entry's artwork URL, sent by the server because it cannot be derived from
   * the id (`/api/thumb/<ratingKey>` is Plex's proxy). Absent on every Plex entry.
   */
  cover?: string | null
  /**
   * What this entry is counted in. 'chapter' on a reading queue, absent (= episodes)
   * everywhere else — it changes the wording of the next-up line, nothing else.
   */
  unit?: EntryUnit
  type: EntryType
  title: string
  year: number | null
  childCount: number | null
  nextEp: NextEp | null
  /**
   * The next-up lookup FAILED (Plex unreachable / errored), as opposed to coming back
   * empty. Both leave `nextEp` null, but only the empty one means "all watched".
   */
  isNextEpFailed?: boolean
  /**
   * Per-entry override of the set's chapter/episode batch. `null` = follow the
   * set (the picker then shows the set's number, tagged Default). A stored `1`
   * is a real override when the set default is not 1.
   */
  episodes: number | null
  /**
   * Per-entry override of the set's volume batch. Independent of `episodes` —
   * a volume is a collection of chapters. `null`/absent = follow the set.
   */
  volumes?: number | null
  /**
   * Per-entry override of the set's `batch_stops_at`: WHERE this entry's batch may stop
   * ("season" = never cross a season finale, "member" = never leave the current show inside
   * a collection). null = follow the set. Only meaningful when `episodes` > 1.
   */
  batch_stops_at?: BatchStop
  /**
   * How OFTEN this entry comes up when the set is randomized: slots per round, not odds.
   * 1 (the default) is normal and wears no tag; 3 means it takes about three slots for every
   * one a 1x entry takes, spread through the queue rather than back to back.
   */
  weight: number
  start: StartPoint | null
  done: boolean
  /**
   * The same thing `done` records, judged LIVE instead of read off `queues.yaml`: the next
   * scan would find nothing left to play here. `done` is only as fresh as the last scan, so
   * this is what makes a film you finished minutes ago — or watched on your phone, where
   * QueuePilot never saw it — read as Completed without waiting for the next card tap.
   * Movies only today (a finished series says so through `nextEp: null`); absent on the
   * skeleton response.
   */
  isFinished?: boolean
  /**
   * The next-up episode (or the movie itself) is mid-playback: a Plex viewOffset > 0 and
   * unwatched, the same in-progress state the engine resumes from. Drives the tile's
   * "In Progress" badge, which reads over a stale "Completed".
   */
  partiallyWatched?: boolean
  /**
   * The in-progress leaf/movie's resume offset and runtime, both in ms (0 when unknown).
   * Only meaningful while `partiallyWatched`; drives the "In Progress" badge's tooltip
   * ("12:30 of 24:00").
   */
  viewOffset?: number
  duration?: number
  /**
   * True while this item came from the SKELETON response (`GET /api/shelves`) and
   * `/api/queues` has not landed yet. The tile renders at final geometry with a
   * `Skeleton` poster instead of a `<img>`, so the swap when the resolved response
   * arrives moves nothing. Absent (falsy) on every resolved item.
   */
  pending?: boolean
}

/** One resolved member of a rotation channel (`GET /api/sets/:id/members`). */
export type ChannelMember = {
  /** Index into the STORED (unsorted) members array — the grid sorts for display
   * only, so this is what a write must address. */
  index: number
  raw?: unknown
  resolved: boolean
  ratingKey: string | null
  /** A non-Plex member's artwork URL — see `QueueItem["cover"]`. */
  cover?: string | null
  /** See `QueueItem["unit"]`. */
  unit?: EntryUnit
  type: EntryType
  title: string
  year: number | null
  childCount: number | null
  nextEp: NextEp | null
  /**
   * The next-up lookup FAILED (Plex unreachable / errored), as opposed to coming back
   * empty. Both leave `nextEp` null, but only the empty one means "all watched".
   */
  isNextEpFailed?: boolean
  start: StartPoint | null
  /** Episodes queued per visit (1 = the channel default). */
  episodes?: number
  /** Slots per round when the channel is randomized (1 = normal). */
  weight?: number
}

/** Anything the poster tile can render. */
export type TileEntry = QueueItem | ChannelMember

export type QueueSet = {
  label: string
  kind: string
  source: "queue" | "rotation" | string
  sections: number[]
  items: QueueItem[]
}

export type QueuesResponse = {
  sets: Record<string, QueueSet>
  order: string[]
}

/**
 * `GET /api/shelves` — the shelf SKELETON. Same envelope as `QueuesResponse`, but each
 * item carries only what `queues.yaml` already knows (its key, its raw title string,
 * whether it is done). No Plex call is made to build it, so it answers in ~15 ms while
 * `/api/queues` takes seconds.
 */
export type ShelfItem = {
  key: string
  raw: string
  title: string
  resolved: false
  done: boolean
}

export type ShelfSet = {
  label: string
  kind: string
  source: "queue" | "rotation" | string
  sections: number[]
  count: number
  items: ShelfItem[]
}

export type ShelvesResponse = {
  sets: Record<string, ShelfSet>
  order: string[]
}

/** One profile binding on a rotation channel (sets.yaml `profiles:` array). */
export type Binding = {
  plex_user: string | null
  account_id: number | null
  user_uuid: string | null
  allowed_ratings: string[]
  movie_ratings: string[]
  movie_excludes?: string[]
  watch_count_accounts?: number[]
}

export type RegistrySet = {
  id: string
  label: string
  kind: string
  source: "queue" | "rotation" | string
  sections: number[]
  item_sections?: number[]
  behavior?: "progress" | "rewatch"
  /** Legacy sets predate `behavior`; `mode: rewatch` is its ancestor. */
  mode?: string
  blocklist: string[]
  members?: unknown[]
  /** Per-show manual start floors for the dynamic rule pool, keyed by show ratingKey.
   * The Channels view seeds the "Start from…" picker from this and writes it back with a
   * whole-map `PATCH /api/sets/:id { starts }`. */
  starts?: Record<string, StartPoint>
  /** Per-show WEIGHTS for the dynamic rule pool, keyed by show ratingKey (or `section-<id>`
   * for a whole item bucket). Same whole-map `PATCH /api/sets/:id { weights }` shape as
   * `starts`; a weight of 1 is never stored. */
  weights?: Record<string, number>
  profiles?: Binding[]
  has_explicit_profiles?: boolean
  /** Which binding the Play/Channels dropdowns seed to (a binding's `plex_user`).
   * A stale value falls back to `profiles[0]`. */
  default_profile?: string | null
  /** Curated-queue play gate: a scan waits (and ADB-switches the Shield) until this Plex
   * Home profile is signed in before playing. null/absent = ungated. */
  requires_profile?: string | null
  /**
   * The repeating {provider, profile, libraries} source blocks. ALWAYS present and always
   * a list: a set written before blocks existed reports the single implicit Plex block it
   * has always meant, built from `sections` / `requires_profile`. So the editor never has
   * to special-case a legacy set, and reading one never rewrites it.
   */
  providers: ProviderBlockValue[]
  /**
   * How a queue on this set STARTS, derived server-side from its blocks. Queues are
   * single-provider, so one value is the whole truth. `push` = sent at a device (Plex);
   * `pull` = the app hands back a URL you open (Kavita, which has no cast at all).
   */
  delivery: "push" | "pull"
  /**
   * The WORDS this queue's medium is described in, from its own provider. Every affordance
   * that names an action or a count reads this instead of hardcoding Plex's vocabulary —
   * `delivery` says how a queue starts, this says what it is CALLED, and a tile that had
   * only the first said "Play “The Sword-Eating Swordmaster” now".
   */
  vocabulary: ProviderVocabulary
  /**
   * The KIND of backend (`plex` / `kavita`). Rendered as `data-provider` so the stylesheet
   * paints this queue in its own service's colour — the kind and not the id, so a second
   * Kavita added at runtime is still Kavita-green.
   */
  provider_kind: string
  /**
   * Curated queues only. Non-consuming / playlist mode: the engine never marks entries
   * done, so the lineup stays re-showable. `reel: true` implies this (normalize reports
   * both). Absent/false on rotation channels.
   */
  keep_completed?: boolean
  /**
   * Curated queues only. Demo-reel mode: play the whole lineup every scan (and implies
   * `keep_completed`). Orthogonal to the TTL sweep.
   */
  reel?: boolean
  /**
   * Curated queues only. Opt-in TTL for auto-removing finished entries
   * (`"24h"` / `"7d"` / …). null/absent = keep forever. Movie queues often ship as
   * `"24h"`; anime channels stay keep-forever by design.
   */
  remove_completed_after?: string | null
  /**
   * Curated sets only. The set-wide default for WHERE a multi-episode batch may stop; an
   * entry can override it. null/absent = no boundary (fill the batch across anything).
   */
  batch_stops_at?: BatchStop
  /**
   * Curated queues only. This queue's DEFAULT batch — how many items one entry contributes
   * per visit when the entry says nothing. null/absent = the engine default of 1.
   *
   * Per QUEUE, never global: "For Plex, 1 episode is no big [deal], but for Webtoons and
   * Manga I'd prefer to default to 3 chapters — by choice for this queue" (owner,
   * 2026-08-15). A per-entry `episodes` still wins over it.
   */
  episodes?: number | null
  /**
   * How many VOLUMES one volume-based entry contributes per visit. Independent of
   * `episodes` — a volume is a collection of chapters, so the chapter count must
   * not apply. null/absent = 1.
   */
  volumes?: number | null
  audio_language?: string
  superseded_by?: string | null
  // The ultra-legacy single-binding mirror, still read by `activeBinding`.
  allowed_ratings?: string[]
  movie_ratings?: string[]
  movie_excludes?: string[]
}

export type Library = {
  id: number
  title: string
  video: boolean
  type: "show" | "movie" | string
  /** Plex "Other Videos" (Personal Media) — a movie-type section that is not a
   * real Movies library. */
  other?: boolean
}

export type SetsResponse = {
  sets: RegistrySet[]
  libraries: Library[]
}

export type SearchHit = {
  ratingKey: string
  title: string
  year?: number | null
  type: "show" | "movie" | "collection"
  sectionId: number
  childCount?: number | null
  hasThumb?: boolean
  /**
   * A non-Plex result's artwork URL. Sent by `/api/search` for a PULL set, whose results are
   * its provider's items — `/api/thumb/<ratingKey>` would ask Plex about an id it has never
   * seen and answer 502.
   */
  cover?: string | null
  /** A MOVIE's own watch state (Plex omits `viewCount` at 0, so absent = unwatched). */
  viewCount?: number
  viewOffset?: number
  /** A SHOW's aggregate progress — what makes "unwatched only" / "in progress" answerable
   * for a series without a second request. */
  leafCount?: number
  viewedLeafCount?: number
}

export type Profile = {
  id?: number | null
  uuid?: string | null
  name: string
  /** plex.tv username — the PMS-log stamp for the owner (managed users stamp their title). */
  username?: string | null
  admin?: boolean
}

export type Device = {
  id: string
  name: string
  default?: boolean
}

/** What is on screen right now (`GET /api/now`, and the `now` SSE event). */
export type NowState = {
  now: {
    state?: string
    ratingKey?: string
    title?: string
    showTitle?: string
    show?: string
    context?: {
      showRatingKey?: string
      collections?: string[]
    }
  } | null
  set: string | null
}

export type PreviewBucketItem = {
  ratingKey: string
  title: string
}

export type PreviewBucket = {
  ratingKey: string
  show: string
  unwatched: number
  /** A reading pool's artwork URL — see `QueueItem["cover"]`. */
  cover?: string | null
  /** See `QueueItem["unit"]`. */
  unit?: EntryUnit
  /** Slots per round when this channel is randomized (1 = normal). Comes from the channel's
   * `weights` map; the pool tile edits it back through that map. */
  weight?: number
  next?: {
    ratingKey?: string
    season?: number | null
    episode?: number | null
    title?: string
    multiSeason?: boolean
  } | null
  /** Present since 2026-07-29: a library bucket lists each standalone item, so a
   * short gets its own tile (decision `2026-07-29-shorts-preview-lists-each-short`). */
  items?: PreviewBucketItem[]
}

export type PreviewResponse = {
  error?: string
  buckets?: PreviewBucket[]
  movie_pool?: {
    ratingKey: string
    title: string
    count: number
  }[]
  movie?: { ratingKey: string; title: string }
}

/**
 * Where a multi-episode batch may stop. "season" also implies the member boundary; null is
 * "no boundary" at the set level and "follow the set" on an entry.
 */
export type BatchStop = "member" | "season" | null

export type ShowEpisodes = {
  multiSeason: boolean
  seasons: {
    season: number
    episodes: {
      episode: number
      title?: string
      watched?: boolean
    }[]
  }[]
}

export type CollectionChild = {
  ratingKey: string
  title: string
  type: "show" | "movie" | string
  leafCount?: number
  viewedLeafCount?: number
  watched?: boolean
}

export type StatusKind = "" | "ok" | "err"

/**
 * A connected media app. `configured` is a BOOLEAN and never the token — the API has no
 * route that returns a credential, not even masked
 * (decision `2026-08-12-provider-tokens-live-in-a-separate-config-file`).
 */
export type ProviderInfo = {
  id: string
  kind: string
  label: string
  base_url: string
  supported: boolean
  configured: boolean
  /**
   * How a queue on this provider STARTS. `push` sends a lineup at a device (Plex → the
   * Shield); `pull` returns a URL you open (Kavita — it has no cast and no webhooks). The
   * UI reads this rather than branching on `kind`, so a third backend needs no UI change.
   */
  delivery: "push" | "pull"
  vocabulary: ProviderVocabulary
}

/**
 * The words a provider's medium is described in. Mirrors the server's `ProviderVocabulary`.
 *
 * Deliberately just labels: anything a provider DOES lives server-side. This is the layer
 * that stops "Play"/"episode" from being written into components that render both media.
 */
export type ProviderVocabulary = {
  /** "Play" / "Read". */
  verb: string
  /** "episode" / "chapter". */
  unit: string
  /** "episodes" / "chapters". */
  units: string
  /** "show" / "series". */
  member: string
  /** "watched" / "read". */
  done: string
  /**
   * The unit abbreviated for a poster tile: "eps" / "ch" / "plays". Optional on a stale
   * registry response that predates the field; `PLEX_WORDS` is the fallback, which is
   * what every other missing slot does.
   */
  unitShort?: string
  /**
   * The product name used in copy: "Plex" / "Kavita". Optional on a stale
   * registry response that predates the field — the replacement engine then
   * leaves "Plex" in the string, which is the same fallback every other
   * missing slot uses.
   */
  name?: string
  /**
   * The glyph on the start affordance: `▶` for Plex, `📖` for Kavita, `🎲` for the board-game
   * picker. A sibling of `verb`, and for the same reason — a play triangle on a manga queue
   * is the icon making the claim the word already stopped making.
   *
   * Optional on a registry response that predates the field; `PLEX_WORDS` supplies `▶`.
   */
  startIcon?: string
}

/** A provider's own libraries. Ids are provider-scoped and stay bare strings. */
export type ProviderLibrary = {
  id: string
  title: string
  type?: number
}

/**
 * One repeating source block on a queue. Always a LIST on the wire, never a scalar — a set
 * written before blocks existed reports the single implicit Plex block it has always meant.
 */
export type ProviderBlockValue = {
  provider: string
  profile: string
  libraries: string[]
  batch?: number
}

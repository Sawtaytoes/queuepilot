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
}

export type EntryType = "show" | "movie" | "collection" | null

/** One resolved entry in a curated queue (`GET /api/queues`). */
export type QueueItem = {
  key: string
  raw?: string
  resolved: boolean
  ratingKey: string | null
  type: EntryType
  title: string
  year: number | null
  childCount: number | null
  nextEp: NextEp | null
  episodes: number
  start: StartPoint | null
  done: boolean
  /**
   * The next-up episode (or the movie itself) is mid-playback: a Plex viewOffset > 0 and
   * unwatched, the same in-progress state the engine resumes from. Drives the tile's
   * "In Progress" badge, which reads over a stale "Completed".
   */
  partiallyWatched?: boolean
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
  type: EntryType
  title: string
  year: number | null
  childCount: number | null
  nextEp: NextEp | null
  start: StartPoint | null
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
  profiles?: Binding[]
  has_explicit_profiles?: boolean
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
}

export type Profile = {
  id?: number | null
  uuid?: string | null
  name: string
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

export type PreviewBucketItem = { ratingKey: string; title: string }

export type PreviewBucket = {
  ratingKey: string
  show: string
  unwatched: number
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
  movie_pool?: { ratingKey: string; title: string; count: number }[]
  movie?: { ratingKey: string; title: string }
}

export type ShowEpisodes = {
  multiSeason: boolean
  seasons: {
    season: number
    episodes: { episode: number; title?: string; watched?: boolean }[]
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

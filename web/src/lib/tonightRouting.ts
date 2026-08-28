import type { ActivityId } from "./tonight"
import type { Activity, RegistrySet } from "./types"

/**
 * ── WP-7. ONE MAP FROM AN ACTIVITY TO THE BACKENDS BEHIND IT ─────────────────────────
 *
 * The Tonight surface asks two different questions of the same word, and this file is the
 * only place they are allowed to meet.
 *
 *   - A **tile** is a kind of evening. There are six of them, the row is settled, and
 *     Surprise Me is last (`lib/tonight.ts`).
 *   - A **queue activity** is what WP-5 stores on a set. There are four of them, and
 *     "Movies & Shows" is deliberately ONE (`server/src/activity.ts`).
 *
 * Everything that needs "which backend serves this tile", "which queues belong to this
 * tile" or "how does Pick draw for this tile" reads the table below. Nothing else in the
 * app may branch on an activity id, and nothing else may branch on a provider kind to
 * decide an activity — that was the WP-6 bridge and it is deleted.
 *
 * ## The one place the two vocabularies genuinely disagree
 *
 * `watching` covers the **Movies** tile and the **Shows** tile. That is not an oversight in
 * either model:
 *
 *   - The queue model refuses a finer list on the owner's own evidence — *"the Older Kids
 *     queue would show up under both Shows and Shorts, but I don't think of it like that in
 *     my head"* (`2026-08-25-a-queue-is-people-plus-an-activity` §1). A queue under two
 *     headings is the failure it is avoiding.
 *   - The tile row is six and is pinned by test, because a tile is an EVENING and a film
 *     night and a series night are two different evenings.
 *
 * So the residue is real and it is **not this package's to settle** — the implementation
 * plan calls it out as the one open question that changes the schema rather than a screen.
 * `tileForSet()` below carries the whole of it, in one function, using the only marker the
 * data has today. When the content-type question is answered, that function is where the
 * answer lands and nothing else moves.
 *
 * ## One session talks to ONE backend
 *
 * A Tonight session picks an activity, and an activity may be served by more than one
 * backend (Video Games is Steam and MiSTer today). The session still ends up on exactly
 * one: `oneBackend()` below is the rule, and the server refuses a queue that draws from
 * more than one provider rather than guessing which half of it to start
 * (`2026-08-13-a-queue-draws-from-exactly-one-provider`, and `providers/blocks.ts isMixed`).
 */

/**
 * How Pick draws for an activity.
 *
 *   - **`board-games`** — the absorbed Board Game Picker engine. It draws from a SHELF, not
 *     from a queue, because a board game is not queued: it is on a shelf in a cupboard.
 *     Untouched by this package.
 *   - **`queue-first`** — the pick draws one QUEUE, and the queue's own engine draws the
 *     item when it starts. Named "queue-first" by the implementation plan for Shows and
 *     Reading; it is also what Movies and Video Games get today, and the reason is in
 *     `PICK_ENGINE_NOTES` below rather than hidden in a comment.
 *   - **`narrow-first`** — Surprise Me. It chooses nothing until the second screen supplies
 *     Media, Games or Reading; `drawSurprise` then delegates to an activity inside it.
 */
export type PickEngine =
  | "board-games"
  | "narrow-first"
  | "queue-first"

export type ActivityRoute = {
  activity: ActivityId
  /**
   * The queue activity whose sets this tile draws from, or `null` when the tile does not
   * draw from queues at all.
   *
   * Two tiles share `watching` on purpose — see the header.
   */
  queueActivity: Activity | null
  /**
   * The provider kinds that serve this activity **in this build**. These are the values
   * `RegistrySet.provider_kind` can actually hold today.
   */
  providerKinds: readonly string[]
  /**
   * Backends the settled decision names for this activity that are **not built**. Listed so
   * the map is the whole answer rather than the built half of it, and so nobody has to go
   * and re-read a decision record to find out whether an omission is a gap or a plan.
   *
   * Eden (Switch), Cemu (Wii U) and Dolphin (GameCube/Wii) are named by
   * `2026-08-25-video-games-absorbs-retro-and-surprise-me-narrows-first` §1. YouTube is
   * named as a future provider by the absorb brief §7 and is explicitly NOT built — there
   * is no Filtered Pool variant of it.
   */
  plannedProviderKinds: readonly string[]
  engine: PickEngine
}

/**
 * THE MAP. Six rows, one per tile, in the settled tile order.
 *
 * A row is added in the same change that adds a provider or a tile. There is no fallback
 * branch and no default: an activity this table has never heard of is a type error, which is
 * the point of keying the record on `ActivityId`.
 */
export const ACTIVITY_ROUTES: Readonly<
  Record<ActivityId, ActivityRoute>
> = {
  "board-games": {
    activity: "board-games",
    engine: "board-games",
    plannedProviderKinds: [],
    providerKinds: ["board-game-picker"],
    queueActivity: "board-games",
  },
  movies: {
    activity: "movies",
    engine: "queue-first",
    plannedProviderKinds: ["youtube"],
    providerKinds: ["plex"],
    queueActivity: "watching",
  },
  reading: {
    activity: "reading",
    engine: "queue-first",
    plannedProviderKinds: [],
    providerKinds: ["kavita"],
    queueActivity: "reading",
  },
  shows: {
    activity: "shows",
    engine: "queue-first",
    plannedProviderKinds: ["youtube"],
    providerKinds: ["plex"],
    queueActivity: "watching",
  },
  surprise: {
    activity: "surprise",
    engine: "narrow-first",
    plannedProviderKinds: [],
    providerKinds: [],
    queueActivity: null,
  },
  "video-games": {
    activity: "video-games",
    engine: "queue-first",
    plannedProviderKinds: ["cemu", "dolphin", "eden"],
    providerKinds: ["mister", "steam"],
    queueActivity: "video-games",
  },
}

export const routeFor = (
  activity: ActivityId,
): ActivityRoute => ACTIVITY_ROUTES[activity]

/**
 * Which tile a set sits under.
 *
 * **This replaces WP-6's `activityForSet()`, which derived the answer from the set's
 * PROVIDER KIND.** That function was a bridge written before a queue stored anything, and
 * it is deleted rather than corrected: WP-5 stores the activity on the set — as an override,
 * falling back to the provider's own answer — and re-deriving it in the browser is a second
 * opinion that can disagree with the server's.
 *
 * What survives from the bridge is exactly one line, and it is the residue the header
 * describes: `watching` is one activity and two tiles, so something has to say which. The
 * only marker the data carries is `behavior: "rewatch"`, which is the Movies rotation's own
 * flag — so a rewatch channel is a film night and everything else under `watching` is a
 * series night.
 *
 * ⚠️ **This is evidence, not a stored fact, and it is the ONLY guess left on this screen.**
 * A curated queue full of films reads as Shows here, because nothing on the set says
 * otherwise. Do not add a second guess somewhere else to compensate — settle the content-type
 * question and give this function a column to read.
 */
export function tileForSet(
  set: Pick<RegistrySet, "activity" | "behavior">,
): ActivityId {
  switch (set.activity) {
    case "board-games":
      return "board-games"
    case "reading":
      return "reading"
    // MiSTer, Steam and the three launchers that are not built yet are one tile. No tile
    // names a device.
    case "video-games":
      return "video-games"
    default:
      return set.behavior === "rewatch" ? "movies" : "shows"
  }
}

/**
 * The tiles a queue activity can appear under — the map read backwards.
 *
 * `watching` answers TWO, which is the whole of the open question in one place. Every other
 * activity answers one.
 */
export function tilesForQueueActivity(
  activity: Activity,
): readonly ActivityId[] {
  return Object.values(ACTIVITY_ROUTES)
    .filter((route) => route.queueActivity === activity)
    .map((route) => route.activity)
}

/**
 * Does a provider kind serve this activity?
 *
 * Asked at the API edge before a pick runs, so a queue whose provider has moved out from
 * under it is refused by name rather than drawn and then failed at launch.
 */
export const isProviderKindForActivity = (
  activity: ActivityId,
  kind: string,
): boolean =>
  routeFor(activity).providerKinds.includes(kind)

/**
 * ONE SESSION TALKS TO ONE BACKEND.
 *
 * Given the queues a session could draw from, this is the provider kind it will end up on,
 * or `null` when the answer is not yet forced. It is deliberately NOT "refuse when there are
 * two" — Video Games genuinely has Steam queues and MiSTer queues, and an evening that could
 * be either is a normal evening. The rule is that the moment one is DRAWN, the session is
 * bound to that one backend and the rest of the session — the launch, the reroll, the
 * shortlist — stays inside it.
 *
 * `kinds` is every distinct provider kind among the candidates. One kind means the session is
 * already bound before it starts.
 */
export function oneBackend(
  kinds: readonly string[],
): string | null {
  const distinct = [...new Set(kinds.filter(Boolean))]
  return distinct.length === 1
    ? (distinct[0] ?? null)
    : null
}

/**
 * Why each activity's Pick draws the way it does — written down because the implementation
 * plan's table names filters that no backend in this build can answer, and an agent reading
 * only the table would think they were forgotten.
 *
 * The keys are the tiles Pick can actually run. `board-games` is absent because its engine
 * is the absorbed one and needs no explanation here; `surprise` is absent because it does not
 * draw at all until it has been narrowed.
 */
export const PICK_ENGINE_NOTES: Readonly<
  Partial<Record<ActivityId, string>>
> = {
  movies:
    "Draws one movie queue. Runtime and Seen before are collected but not yet applied — " +
    "both are facts about an ITEM, and the item is chosen by the queue's own engine when " +
    "it starts, which is the only place that already knows what is left to watch.",
  reading:
    "Draws one reading queue, then the chapter that queue would open next.",
  shows:
    "Draws one shows queue, then the episode that queue would play next.",
  "video-games":
    "Draws one video-games queue. Knows how to play is collected but not yet applied: " +
    "there is no video-game known-how table, and a play count may never be turned into a " +
    "claim.",
}

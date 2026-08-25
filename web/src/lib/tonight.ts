import { tileForSet } from "./tonightRouting"
import type { Person, RegistrySet } from "./types"

/**
 * The Tonight surface's vocabulary and its two rules, with no React and no DOM in the
 * file so a Node test can call them directly.
 *
 * ## An ACTIVITY is a kind of evening, never a backend
 *
 * "Video Games" covers MiSTer, Steam, Switch (Eden), Wii U (Cemu) and GameCube/Wii
 * (Dolphin) TOGETHER. The provider is an ATTRIBUTE of a queue, not a heading over it, and
 * a provider brand never appears on a tile — no "Plex", no "Kavita", no "Steam"
 * (root decisions `2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick` §4 and
 * `2026-08-25-a-queue-is-people-plus-an-activity` §1).
 *
 * **There is no "Retro Games" tile.** MiSTer is one of the things Video Games covers, and
 * no tile names a device. The list is SIX, and its ORDER is settled rather than designed.
 * **Surprise Me is last, on purpose.**
 *
 * ## Choosing people is a FILTER, not presence detection
 *
 * Nothing in this app detects who is in the room and nothing may pretend to. Ticking a
 * person narrows the queue list the way a search field does, which is why the rule below
 * is a predicate over a queue and not a claim about a room. Scanning an NFC card still
 * goes straight to its queue and never touches this screen
 * (`2026-08-25-a-queue-is-people-plus-an-activity` §5).
 */

export type ActivityId =
  | "board-games"
  | "movies"
  | "reading"
  | "shows"
  | "surprise"
  | "video-games"

/** Which half of the session the Pick | Queues segment is on. */
export type SessionMode = "pick" | "queues"

export type Activity = {
  id: ActivityId
  label: string
  /**
   * One line under the label. **Brand-free by rule** — the hint says what the evening is,
   * never which app serves it.
   */
  hint: string
  /**
   * Where the Pick | Queues segment starts for this activity.
   *
   * Three of these are fixed by the absorb decision (§5): board games start on Pick;
   * shows and reading start on Queues. The other four are this file's call and may be
   * changed without a decision record — a default is a starting position, and the segment
   * is one tap away.
   */
  defaultMode: SessionMode
}

/**
 * The six tiles, in the settled order. `surprise` is last and stays last.
 */
export const ACTIVITIES: readonly Activity[] = [
  {
    defaultMode: "pick",
    hint: "Consoles, handhelds and the PC",
    id: "video-games",
    label: "Video Games",
  },
  {
    defaultMode: "pick",
    hint: "Off the shelf",
    id: "board-games",
    label: "Board Games",
  },
  {
    defaultMode: "pick",
    hint: "Films and documentaries",
    id: "movies",
    label: "Movies",
  },
  {
    defaultMode: "queues",
    hint: "Series and shorts",
    id: "shows",
    label: "Shows",
  },
  {
    defaultMode: "queues",
    hint: "Comics, manga and books",
    id: "reading",
    label: "Reading",
  },
  {
    defaultMode: "pick",
    // Not "we will roll a die for you" — Surprise Me opens a SECOND screen where you
    // narrow down first. See `SURPRISE_SCOPES`.
    hint: "Narrow it down, then let it choose",
    id: "surprise",
    label: "Surprise Me",
  },
]

const BY_ID = new Map(ACTIVITIES.map((a) => [a.id, a]))

export const findActivity = (
  id: ActivityId | null,
): Activity | null => (id ? (BY_ID.get(id) ?? null) : null)

/**
 * The segment's starting position for an activity.
 *
 * ⚠️ A keyed remount of `SegmentedControl` does NOT fire `onChange` — `createSinglePicker`
 * seeds its wanted value and short-circuits on an unchanged one, so the mount-time select
 * never calls back. The parent must therefore set the mode in the SAME handler that sets
 * the activity, or the segment repaints on the new default while the parent still believes
 * the old one. (WP-0's finding, verified against `@charcuterie/ui@3.10.0`.)
 */
export const defaultModeFor = (
  id: ActivityId | null,
): SessionMode => findActivity(id)?.defaultMode ?? "pick"

/**
 * One queue as this screen needs it. **The contract WP-5 fills in.**
 *
 * `name` is a display string rather than the activity's label because today's queues carry
 * a hand-typed label and nothing else. Once WP-5 lands, a queue's name IS its activity
 * ("Movies") and the people are the badges that tell two of them apart
 * (`2026-08-25-a-queue-is-people-plus-an-activity` §4) — that is a change to what fills
 * this field, not to the field.
 */
export type TonightQueue = {
  id: string
  name: string
  activity: ActivityId
  /**
   * Whether this queue carries people at all.
   *
   * **This is the WP-5 seam and it is load-bearing.** A queue written before WP-5 has no
   * roster, and applying the people filter to it would hide EVERY queue the moment one
   * person is ticked — "every selected person is on the queue" is false against an empty
   * roster. So a queue with no roster is never filtered out. WP-5 sets this true and fills
   * the two lists; the rule below is already the rule and does not change with it.
   */
  hasRoster: boolean
  /** Person ids who must be ticked for this queue to show. */
  requiredPeople: readonly string[]
  /** Person ids who may be ticked without hiding it — the "Nice to have" hatch. */
  optionalPeople: readonly string[]
  /** Display names for the card's badges. Empty until WP-5. */
  peopleNames: readonly string[]
  /** The provider's product name, shown only when two providers serve one activity. */
  providerLabel: string
  /** `push` starts at a device; `pull` hands back a URL (`/go/<id>`). */
  delivery: "pull" | "push"
}

/**
 * Project the registry onto the Tonight contract.
 *
 * `providerLabels` maps a provider KIND to its product name, so the card can say which
 * backend a queue runs on once two of them serve the same activity — the one place a
 * provider brand is allowed on this screen
 * (`2026-08-25-a-queue-is-people-plus-an-activity` §1).
 *
 * ⚠️ A set's TILE comes from `tonightRouting.tileForSet()`, which reads the activity WP-5
 * stores on the set. It used to be derived here from the set's provider kind, which was a
 * bridge written before a queue stored anything; that function is deleted rather than
 * corrected, because a second derivation in the browser can disagree with the server's.
 */
export function tonightQueues(
  sets: readonly RegistrySet[],
  providerLabels: ReadonlyMap<string, string>,
): TonightQueue[] {
  return sets.map((set) => ({
    activity: tileForSet(set),
    delivery: set.delivery === "pull" ? "pull" : "push",
    // ⚠️ WP-5: a queue's people live on the queue. Nothing in the registry carries them
    // today, so every queue reports itself rosterless and the filter lets it through.
    hasRoster: false,
    id: set.id,
    name: set.label || set.id,
    optionalPeople: [],
    peopleNames: [],
    providerLabel:
      providerLabels.get(set.provider_kind) ?? "",
    requiredPeople: [],
  }))
}

/**
 * The people filter, exactly as the decision states it:
 *
 * > a queue shows when **every selected person is on the queue** and **every required
 * > person is selected**
 *
 * Ticking Ada and Grace shows the Ada & Grace queues and hides "Ada — Movies", because
 * Grace is not on it. Optional people are the hatch: somebody there does not remove the
 * queue.
 *
 * A queue with no roster (`hasRoster: false`) is pre-WP-5 data and is never filtered —
 * see `TonightQueue.hasRoster`.
 *
 * **Nobody ticked is no filter at all**, which is the half of the rule the sentence above
 * leaves implicit and which the strict reading gets backwards. Read strictly, "every
 * required person is selected" is FALSE against an empty selection, so an empty form would
 * hide every queue that names anybody — a search field showing no results before you have
 * typed. A filter with nothing in it matches everything.
 */
export function queueMatchesPeople(
  queue: TonightQueue,
  selectedPersonIds: readonly string[],
): boolean {
  if (!queue.hasRoster) return true
  if (selectedPersonIds.length === 0) return true

  const onQueue = new Set([
    ...queue.requiredPeople,
    ...queue.optionalPeople,
  ])

  if (!selectedPersonIds.every((id) => onQueue.has(id))) {
    return false
  }

  const selected = new Set(selectedPersonIds)

  return queue.requiredPeople.every((id) =>
    selected.has(id),
  )
}

/**
 * The Which queue? list: this activity's queues, narrowed by who is ticked.
 *
 * Surprise Me crosses activities on purpose, so it narrows by people alone.
 */
export function queuesForTonight(
  queues: readonly TonightQueue[],
  activity: ActivityId | null,
  selectedPersonIds: readonly string[],
): TonightQueue[] {
  if (!activity) return []

  return queues.filter(
    (queue) =>
      (activity === "surprise" ||
        queue.activity === activity) &&
      queueMatchesPeople(queue, selectedPersonIds),
  )
}

/**
 * True when a provider brand has to be shown on a queue card — two or more providers
 * serving the same activity is exactly the condition the decision names.
 */
export function isProviderWorthNaming(
  queues: readonly TonightQueue[],
): boolean {
  const labels = new Set(
    queues.map((q) => q.providerLabel).filter(Boolean),
  )

  return labels.size > 1
}

/**
 * What the Go button says. The count is people PLUS guests, because a guest is a seat at
 * the table even though it is not a roster row.
 */
export function goLabel(
  selectedPersonIds: readonly string[],
  guestCount: number,
): string {
  const seats = selectedPersonIds.length + guestCount

  if (seats === 0) return "Go"

  return `Go · ${seats} ${seats === 1 ? "person" : "people"}`
}

/** Roster order, never alphabetical — a reorder is a decision somebody made. */
export const rosterOrder = (
  people: readonly Person[],
): Person[] =>
  [...people].sort((a, b) => a.position - b.position)

/**
 * ── Surprise Me is a SECOND SCREEN, not a one-tap random pick ────────────────────────
 *
 * Tapping the tile does not choose anything. It opens a narrowing step, and only after
 * you narrow does it choose. The owner's words:
 *
 * > "it took you to another screen where you could narrow it down like 'video games', so
 * > it's any queue for that given the people, or 'media', and it chooses between YouTube
 * > or Movies/Shows on Plex."
 *
 * So the narrowing list is **coarser than the tile row**, not the same list again —
 * "media" spans Movies, Shows and YouTube in one entry. That is the whole reason it
 * cannot be derived from `ACTIVITIES`.
 *
 * ⚠️ **The groupings are NOT settled and are deliberately not guessed here.** The owner
 * has been asked for them. This list is the seam: fill it in and the narrowing step
 * renders, with no other change to the screen. While it is empty the step says so
 * plainly rather than offering a made-up taxonomy.
 */
export type SurpriseScope = {
  id: string
  label: string
  /** One line under the label — what this scope draws from. */
  hint: string
  /** The activities this scope may choose across. */
  activities: readonly ActivityId[]
}

/** Empty ON PURPOSE — see `SurpriseScope`. */
export const SURPRISE_SCOPES: readonly SurpriseScope[] = []

/** Everything a chosen Surprise scope may pick from, once the scopes exist. */
export function queuesForSurpriseScope(
  queues: readonly TonightQueue[],
  scope: SurpriseScope,
  selectedPersonIds: readonly string[],
): TonightQueue[] {
  return queues.filter(
    (queue) =>
      scope.activities.includes(queue.activity) &&
      queueMatchesPeople(queue, selectedPersonIds),
  )
}

/**
 * ── The activity filters ─────────────────────────────────────────────────────────────
 *
 * Step 3 of the form, and **only when the segment is on Pick**. There is never a second
 * "Mode" row: Pick | Queues IS how the session runs, and a filter that repeated it would be
 * the thing the decision spends a clause forbidding
 * (`2026-08-22-…-tonight-pick` §5).
 *
 * The set per activity, and each default, come from the settled mockup rather than from
 * taste. Two are worth knowing because they are not the neutral answer: board games and
 * video games open with **Keep it light: On**, and both open with **knows-how: Someone**
 * rather than Any. Reading opens with Keep it light Off.
 *
 * ⚠️ **These are collected but not yet acted on.** The pick engine is WP-7 and WP-8; until
 * one of them lands, a filter's value goes nowhere and the screen says so under Go rather
 * than implying a pick it cannot make.
 */
export type ActivityFilter = {
  id: string
  label: string
  /** `segment` for two or three short answers; `picker` once the list wants a panel. */
  control: "picker" | "segment"
  options: readonly { value: string; label: string }[]
  defaultValue: string
}

const KNOWS_HOW = (label: string): ActivityFilter => ({
  control: "segment",
  defaultValue: "someone",
  id: "knows",
  label,
  options: [
    { label: "Any", value: "any" },
    { label: "Someone", value: "someone" },
    { label: "All", value: "all" },
  ],
})

const KEEP_IT_LIGHT = (
  defaultValue: string,
): ActivityFilter => ({
  control: "segment",
  defaultValue,
  id: "light",
  label: "Keep it light",
  options: [
    { label: "Off", value: "off" },
    { label: "On", value: "on" },
  ],
})

export const ACTIVITY_FILTERS: Record<
  ActivityId,
  readonly ActivityFilter[]
> = {
  "board-games": [
    {
      control: "segment",
      defaultValue: "best",
      id: "fit",
      label: "Player-count fit",
      options: [
        { label: "OK", value: "ok" },
        { label: "Best", value: "best" },
      ],
    },
    KNOWS_HOW("Knows the rules"),
    KEEP_IT_LIGHT("on"),
  ],
  movies: [
    {
      control: "picker",
      defaultValue: "120",
      id: "runtime",
      label: "Runtime",
      options: [
        { label: "Any length", value: "any" },
        { label: "90 minutes or less", value: "90" },
        { label: "2 hours or less", value: "120" },
        { label: "3 hours or less", value: "180" },
      ],
    },
    {
      control: "segment",
      defaultValue: "any",
      id: "seen",
      label: "Seen before",
      options: [
        { label: "Any", value: "any" },
        { label: "Rewatch", value: "rewatch" },
      ],
    },
  ],
  reading: [KEEP_IT_LIGHT("off")],
  // A shows evening runs the rotation. Nothing to narrow, and an empty row is better than
  // an invented control.
  shows: [],
  // Surprise Me narrows on its OWN screen — see `SURPRISE_SCOPES`.
  surprise: [],
  "video-games": [
    KNOWS_HOW("Knows how to play"),
    KEEP_IT_LIGHT("on"),
  ],
}

/** Every filter for an activity at its default — what the form opens with. */
export function defaultFilterValues(
  activity: ActivityId | null,
): Record<string, string> {
  if (!activity) return {}

  return Object.fromEntries(
    ACTIVITY_FILTERS[activity].map((filter) => [
      filter.id,
      filter.defaultValue,
    ]),
  )
}

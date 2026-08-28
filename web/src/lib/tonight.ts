import { queueNumbers, queueTitle } from "./people"
import { tileForSet } from "./tonightRouting"
import type {
  GroupWithRoster,
  MemberKind,
  MemberRole,
  Person,
  QueueMember,
  RegistrySet,
} from "./types"

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
 * One member of a queue's audience, resolved to what the FILTER needs.
 *
 * **Mirrors `server/src/tonight/pick.ts toResolvedMembers()` and its `ResolvedMember`.** Two
 * implementations of one shape, for the same reason `lib/people.ts describeRule` mirrors
 * `describeMembership`: the two workspaces cannot import each other, and
 * `tonight-routing-test.ts` is what stops them drifting.
 *
 * ⚠️ **A GROUP IS NOT FLATTENED TO ITS PEOPLE.** "Younger Kids" is at least one of three, so
 * flattening it into three person ids turns "either of them is enough" into "all of them" —
 * which is the rule itself, inverted. The group stays ONE member carrying its own count.
 */
export type TonightMember = {
  kind: MemberKind
  id: string
  role: MemberRole
  /** The badge's text — a person's display name, or the group's label. */
  label: string
  /** For a GROUP: its required roster. For a PERSON: just themself. */
  people: readonly string[]
  /** How many of `people` count as this member being present. 1 for a person. */
  minPresent: number
}

/**
 * One queue as this screen needs it.
 *
 * `name` is `queueTitle`'s answer: the queue's own name when somebody typed one, its
 * ACTIVITY when nobody did, numbered only in the second case. One function, so this list and
 * the Admin grid cannot call the same queue two different things
 * (`2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`).
 */
export type TonightQueue = {
  id: string
  /** What this queue is CALLED — `queueTitle`'s answer, so it matches the Admin grid. */
  name: string
  activity: ActivityId
  /**
   * Whether this queue carries people at all.
   *
   * **This is load-bearing and it is not a leftover.** Several live queues legitimately have
   * NOBODY on them — a queue no group claimed comes up empty by design — and applying the
   * rule to an empty roster would hide them the moment one person is ticked ("every selected
   * person is on the queue" is false against an empty roster). So a queue with no members is
   * never filtered out, and stays reachable.
   */
  hasRoster: boolean
  /** Who this queue is for. The badges under its name, and the whole of the filter. */
  members: readonly TonightMember[]
  /** The provider's product name, shown only when two providers serve one activity. */
  providerLabel: string
  /** `push` starts at a device; `pull` hands back a URL (`/go/<id>`). */
  delivery: "pull" | "push"
}

/**
 * Turn a queue's stored trays into the shape the filter reads.
 *
 * A PERSON member is themself and counts as one. A GROUP member is its REQUIRED roster and
 * counts as `minPresent` of them — a set, a number and a spare, and collapsing any two of
 * them loses the rule.
 *
 * A group nothing knows about resolves to an EMPTY roster, and an empty required member can
 * never be satisfied, so the queue drops out of the filter rather than passing it by
 * accident. That is the safe direction, and it is the server's own — a queue that should
 * have been offered and was not is visible on the screen; a queue offered to people it is
 * not for is not.
 */
export function resolveMembers(
  members: readonly QueueMember[],
  people: readonly Person[],
  groups: readonly GroupWithRoster[],
): TonightMember[] {
  return members.map((member): TonightMember => {
    if (member.kind === "group") {
      const group = groups.find(
        (one) => one.id === member.id,
      )
      const required = (group?.roster ?? []).filter(
        (row) => row.role === "required",
      )

      return {
        id: member.id,
        kind: "group",
        label: group?.label ?? member.id,
        // `null` is "all of them", which is what every group written before the rule meant —
        // the absence is not silently 1.
        minPresent:
          group == null
            ? 1
            : Math.max(
                0,
                Math.min(
                  group.minPresent ?? required.length,
                  required.length,
                ),
              ),
        people: required.map((row) => row.personId),
        role: member.role,
      }
    }

    return {
      id: member.id,
      kind: "person",
      label:
        people.find((one) => one.id === member.id)
          ?.displayName ?? member.id,
      minPresent: 1,
      people: [member.id],
      role: member.role,
    }
  })
}

/**
 * Project the registry onto the Tonight contract.
 *
 * `providerLabels` maps a provider KIND to its product name, so the card can say which
 * backend a queue runs on once two of them serve the same activity — the one place a
 * provider brand is allowed on this screen
 * (`2026-08-25-a-queue-is-people-plus-an-activity` §1).
 *
 * `membersByQueue` is `GET /api/queue-people`, keyed on set id. A set with no entry has
 * nobody on it, which is legal and is what "Anybody" means on a card.
 *
 * ⚠️ A set's TILE comes from `tonightRouting.tileForSet()`, which reads the activity WP-5
 * stores on the set. It used to be derived here from the set's provider kind, which was a
 * bridge written before a queue stored anything; that function is deleted rather than
 * corrected, because a second derivation in the browser can disagree with the server's.
 */
export function tonightQueues(
  sets: readonly RegistrySet[],
  providerLabels: ReadonlyMap<string, string>,
  membersByQueue: Readonly<
    Record<string, QueueMember[]>
  > = {},
  people: readonly Person[] = [],
  groups: readonly GroupWithRoster[] = [],
): TonightQueue[] {
  // The SAME numbering the Admin grid applies, over the same whole registry, so a queue is
  // called one thing in this app. Computed once for the list rather than per row: the number
  // is a property of the set beside its neighbours, not of the row.
  const numbers = queueNumbers(sets, membersByQueue)

  return sets.map((set) => {
    const members = resolveMembers(
      membersByQueue[set.id] ?? [],
      people,
      groups,
    )

    return {
      activity: tileForSet(set),
      delivery: set.delivery === "pull" ? "pull" : "push",
      hasRoster: members.length > 0,
      id: set.id,
      members,
      // Its own name when it has one, its ACTIVITY when it has not — `queueTitle`, the same
      // function the cards use (decision
      // `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`). This used to be
      // `set.label || set.id`, which printed a slug for a nameless queue.
      name: queueTitle(set, numbers.get(set.id) ?? null),
      providerLabel:
        providerLabels.get(set.provider_kind) ?? "",
    }
  })
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
 * **Mirrors `server/src/queuePeople.ts queueMatchesSelection()`, statement for statement.**
 * Pick is people-aware server-side and this list is the same question asked in the browser;
 * `tonight-routing-test.ts` §5 is what stops the two answering differently.
 *
 * A queue with NOBODY on it (`hasRoster: false`) is never filtered — see
 * `TonightQueue.hasRoster`.
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

  return membersMatchPeople(
    queue.members,
    selectedPersonIds,
  )
}

/**
 * The rule itself, over a queue's members alone.
 *
 * Split out of `queueMatchesPeople` so the PLAY LANDING can ask the same question without
 * first building a `TonightQueue` — it has the trays off `usePeople()` and nothing else it
 * needs. One implementation, two callers: two copies of this would drift, and the way they
 * drift is that one screen offers a queue the other hides
 * (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`).
 *
 * `hasRoster` stays on the caller above, because it answers a DIFFERENT question — whether
 * the queue has been filed at all — and the landing reads that off `members.length` directly.
 */
export function membersMatchPeople(
  members: readonly TonightMember[],
  selectedPersonIds: readonly string[],
): boolean {
  if (members.length === 0) return true

  const selected = new Set(selectedPersonIds)
  if (selected.size === 0) return true

  const onQueue = new Set<string>()
  for (const member of members)
    for (const personId of member.people)
      onQueue.add(personId)

  for (const personId of selected)
    if (!onQueue.has(personId)) return false

  for (const member of members) {
    if (member.role !== "required") continue
    const present = member.people.filter((personId) =>
      selected.has(personId),
    ).length
    if (present < member.minPresent) return false
  }

  return true
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
 * The owner settled the three groupings on 2026-08-28: Media, Games and Reading. Media
 * spans Movies and Shows now, with YouTube joining when its provider exists; Games spans
 * Video Games and Board Games; Reading is the reading activity on its own.
 */
export type SurpriseScope = {
  id: string
  label: string
  /** One line under the label — what this scope draws from. */
  hint: string
  /** The activities this scope may choose across. */
  activities: readonly ActivityId[]
}

export const SURPRISE_SCOPES: readonly SurpriseScope[] = [
  {
    activities: ["movies", "shows"],
    hint: "Movies, shows and YouTube when it arrives",
    id: "media",
    label: "Media",
  },
  {
    activities: ["video-games", "board-games"],
    hint: "Video games and board games",
    id: "games",
    label: "Games",
  },
  {
    activities: ["reading"],
    hint: "Comics, manga and books",
    id: "reading",
    label: "Reading",
  },
]

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

import type {
  Activity,
  GroupWithRoster,
  MemberRole,
  Person,
  QueueMember,
  RegistrySet,
} from "./types"

/**
 * The people a queue is FOR, reduced to what a screen has to draw.
 *
 * WP-5 made a queue required people + optional people + one activity, and this module is the
 * pure half of that: no fetching, no React, nothing that needs a browser. Everything here is
 * exercised by `people.test.ts`, which is why the trays and the shelf faces have no logic of
 * their own worth testing.
 *
 * ⚠️ **The LIBRARY owns the shape; this app owns the DATA.** The three trays are a
 * Charcuterie `Board` — lanes, cards, and a move handle that is a menu first and a drag
 * second. Nothing here paints a lane or implements a drag. What it does is turn people and
 * groups into `BoardItem`s and turn a `BoardMove` back into a member list.
 */

/** What each activity is called on screen. The queue's name IS this — there is no other. */
export const ACTIVITY_LABELS: Record<Activity, string> = {
  "board-games": "Board Games",
  reading: "Reading",
  "video-games": "Video Games",
  watching: "Movies & Shows",
}

/** The three places a person can be. `roster` is "Everyone else" — the absence of a member. */
export const TRAYS = [
  {
    help: "The queue does not come up without them",
    key: "required",
    label: "Must be here",
  },
  {
    help: "Welcome, but not needed",
    key: "optional",
    label: "Nice to have",
  },
  {
    help: "Not on this queue",
    key: "roster",
    label: "Everyone else",
  },
] as const

export type TrayKey = (typeof TRAYS)[number]["key"]

/** A person or a group, as one card in a tray. The editor shows both side by side because a
 *  group IS a saved set of people — a one-tap shortcut, not a second kind of thing. */
export type Candidate = {
  kind: "person" | "group"
  id: string
  label: string
  /**
   * The group's own rule in words — "At least one of Ada, Grace. Linus may join." Null for a
   * person, who is only ever themself.
   */
  rule: string | null
  /** How many people this card stands for. 1 for a person. */
  size: number
}

/** Two letters at most, upper-cased — what fits inside a 26px circle. */
export function initials(label: string): string {
  const words = String(label ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) return "?"
  if (words.length === 1)
    return (words[0] as string).slice(0, 1).toUpperCase()

  return (
    (words[0] as string).slice(0, 1) +
    (words[1] as string).slice(0, 1)
  ).toUpperCase()
}

/**
 * A stable hue for one id, 0-359.
 *
 * The APP owns this, not the library: Folio hashes a repo name into a hue and hands the
 * result to a prop, and this is the same division. A hue derived from the ID and not from the
 * NAME, so renaming somebody does not change their colour — the face is how you find them on
 * a card, and a colour that moves is worse than no colour.
 */
export function hueFor(id: string): number {
  let hash = 0
  for (const char of String(id ?? "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360000
  }
  return hash % 360
}

/** Say a group's rule in one sentence. Mirrors `server/src/queuePeople.ts describeMembership`
 *  — two implementations of one sentence, and the server's is the one the API returns; this
 *  one exists so the tray can label a card without a second round trip. */
export function describeRule(
  group: GroupWithRoster,
  nameOf: (personId: string) => string,
): string {
  const required = group.roster.filter(
    (m) => m.role === "required",
  )
  const optional = group.roster.filter(
    (m) => m.role === "optional",
  )
  const minimum = group.minPresent ?? required.length
  const names = required.map((m) => nameOf(m.personId))

  let sentence: string
  if (required.length === 0)
    sentence = "Anybody in this group"
  // One person is not a quantity. "All of Ada" reads as a mistake, and it is what a group of
  // one — which is most of them — would otherwise say on every card.
  else if (required.length === 1)
    sentence = String(names[0])
  else if (minimum >= required.length)
    sentence = `All of ${names.join(", ")}`
  else if (minimum === 1)
    sentence = `At least one of ${names.join(", ")}`
  else
    sentence = `At least ${minimum} of ${names.join(", ")}`

  if (optional.length === 0) return sentence
  return `${sentence}. ${optional
    .map((m) => nameOf(m.personId))
    .join(", ")} may join.`
}

/** Every person and group in the house, as cards. This is what "the whole house at once"
 *  means — Option B's one advantage over the other two editors, and its one cost. */
export function candidates(
  people: readonly Person[],
  groups: readonly GroupWithRoster[],
): Candidate[] {
  const nameOf = (personId: string) =>
    people.find((p) => p.id === personId)?.displayName ??
    personId

  return [
    ...people.map(
      (person): Candidate => ({
        id: person.id,
        kind: "person",
        label: person.displayName,
        rule: null,
        size: 1,
      }),
    ),
    ...groups.map(
      (group): Candidate => ({
        id: group.id,
        kind: "group",
        label: group.label,
        rule: describeRule(group, nameOf),
        size: group.roster.length,
      }),
    ),
  ]
}

const memberKey = (kind: string, id: string) =>
  `${kind}:${id}`

/** Which tray each candidate is in right now. Anybody with no member row is "Everyone else". */
export function trayOf(
  candidate: Candidate,
  members: readonly QueueMember[],
): TrayKey {
  const found = members.find(
    (m) =>
      memberKey(m.kind, m.id) ===
      memberKey(candidate.kind, candidate.id),
  )
  return found ? found.role : "roster"
}

/** The three lanes, as `{trayKey -> candidates}`, each in its stored order. */
export function byTray(
  all: readonly Candidate[],
  members: readonly QueueMember[],
): Record<TrayKey, Candidate[]> {
  const out: Record<TrayKey, Candidate[]> = {
    optional: [],
    required: [],
    roster: [],
  }

  for (const candidate of all)
    out[trayOf(candidate, members)].push(candidate)

  // The two audience trays keep the ORDER the store gave them; "Everyone else" keeps the
  // roster order it arrived in, which is people then groups.
  const rank = (candidate: Candidate) =>
    members.findIndex(
      (m) =>
        memberKey(m.kind, m.id) ===
        memberKey(candidate.kind, candidate.id),
    )
  out.required.sort((a, b) => rank(a) - rank(b))
  out.optional.sort((a, b) => rank(a) - rank(b))

  return out
}

/**
 * Move one candidate to one tray, and hand back the whole member list to PUT.
 *
 * The whole list, because the write is all-or-nothing — that is the only way the editor can
 * say "everybody back to Everyone else". Moving somebody to `roster` therefore DROPS their
 * row rather than storing a third role.
 */
export function moveToTray(
  members: readonly QueueMember[],
  candidate: { kind: "person" | "group"; id: string },
  tray: TrayKey,
  toIndex = Number.MAX_SAFE_INTEGER,
): QueueMember[] {
  const key = memberKey(candidate.kind, candidate.id)
  const without = members.filter(
    (m) => memberKey(m.kind, m.id) !== key,
  )

  if (tray === "roster") return renumber(without)

  const role: MemberRole = tray
  const sameTray = without.filter((m) => m.role === role)
  const elsewhere = without.filter((m) => m.role !== role)
  const at = Math.max(0, Math.min(toIndex, sameTray.length))

  sameTray.splice(at, 0, {
    id: candidate.id,
    kind: candidate.kind,
    position: at,
    role,
  })

  return renumber([...sameTray, ...elsewhere])
}

/** Positions are per tray, so a caller never invents a global index that means nothing. */
function renumber(
  members: readonly QueueMember[],
): QueueMember[] {
  const next: Record<MemberRole, number> = {
    optional: 0,
    required: 0,
  }
  return [...members]
    .sort((a, b) =>
      a.role === b.role
        ? 0
        : a.role === "required"
          ? -1
          : 1,
    )
    .map((m) => ({ ...m, position: next[m.role]++ }))
}

/**
 * The number a queue wears after its activity, or null for the first of its kind.
 *
 * There is no queue name, so two queues sharing people and activity read identically — "Allow,
 * and add a number." Registry order decides, so the number is stable and creating a second
 * queue never renumbers the first.
 */
export function queueNumbers(
  sets: readonly Pick<
    RegistrySet,
    "id" | "activity" | "source"
  >[],
  membersBySet: Readonly<Record<string, QueueMember[]>>,
): Map<string, number | null> {
  const seen = new Map<string, number>()
  const out = new Map<string, number | null>()

  for (const set of sets) {
    const signature = [
      // SOURCE is in the signature, and it has to be. A curated queue and a filtered pool are
      // two different things on two different pages and never sit beside each other, so a
      // pool eating number 1 makes the Ordered Queues page start at 3 — which reads as a bug
      // rather than as a disambiguation. Measured, not guessed: the landing fixture's first
      // three curated Movies queues came out 3, 4 and 5.
      set.source,
      set.activity,
      ...(membersBySet[set.id] ?? [])
        .map((m) => `${m.role}:${m.kind}:${m.id}`)
        .sort(),
    ].join("|")
    const count = (seen.get(signature) ?? 0) + 1
    seen.set(signature, count)
    out.set(set.id, count === 1 ? null : count)
  }

  return out
}

/**
 * WHAT A QUEUE CARD SAYS.
 *
 * The queue's own name when somebody typed one, and its ACTIVITY when nobody did — numbered
 * only when two nameless queues would otherwise read identically
 * (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`):
 *
 *     Manga & Webtoons     a name, kept verbatim
 *     Movies               a name, kept verbatim
 *     Movies & Shows       no name — the activity
 *     Movies & Shows 2     …and the second one of those
 *
 * `has_explicit_label` and NOT `label`, because the server makes `label` printable by falling
 * back to the id: a nameless queue would otherwise print `movies_shows` here. An older
 * payload without the flag reads as "no name typed", which is the safe direction — it prints
 * the activity rather than an id.
 *
 * The NUMBER is only ever appended to the activity. Two queues called "Movies" are the
 * owner's own doing and he can tell them apart; two called "Movies & Shows" are the app's,
 * and numbering them is the app's job.
 */
export function queueTitle(
  set: {
    activity: Activity
    has_explicit_label?: boolean
    label?: string
  },
  duplicateNumber: number | null,
): string {
  const typed = set.has_explicit_label
    ? (set.label ?? "").trim()
    : ""

  if (typed) return typed

  const label =
    ACTIVITY_LABELS[set.activity] ?? set.activity

  return duplicateNumber == null
    ? label
    : `${label} ${duplicateNumber}`
}

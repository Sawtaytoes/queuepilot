import type {
  GroupWithRoster,
  MemberRole,
  Person,
  QueueMember,
} from "./types"

/**
 * The people a queue is FOR, reduced to what a screen has to draw.
 *
 * WP-5 made a queue required people + optional people + one activity, and this module is the
 * pure half of that: no fetching, no React, nothing that needs a browser. Everything here is
 * exercised by `people.test.ts`, which is why the trays and the shelf faces have no logic of
 * their own worth testing.
 *
 * ⚠️ **The LIBRARY owns the shape; this app owns the DATA.** The queue editor is a vertical
 * audience list with three placements. Nothing here paints a section or a control. What it
 * does is turn people and groups into candidates and turn a placement back into a member list.
 */

/**
 * What a queue is CALLED, and the duplicate number beside it. One rule in `shared/`, imported
 * here and by the server's native TV catalog, so the TV and this app cannot name the same queue
 * two ways (decision `2026-10-22-a-queue-title-is-one-shared-rule-for-the-web-and-the-tv`).
 */
export {
  ACTIVITY_LABELS,
  queueListNumbers,
  queueNumbers,
  queueTitle,
} from "../../../shared/queueTitle"

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

/** A person or a group, as one row in the audience list. A group is a saved rule, not a second
 * queue placement model. */
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
    sentence = `All of ${joinNames(names, "and")}`
  else if (minimum === 1)
    sentence = `At least one of ${joinNames(names, "or")}`
  else
    sentence = `At least ${minimum} of ${joinNames(names, "or")}`

  if (optional.length === 0) return sentence
  return `${sentence}. ${joinNames(
    optional.map((m) => nameOf(m.personId)),
    "and",
  )} may join.`
}

/** Join a short people list in the same words the rule uses: `or` for alternatives and `and`
 * for people who all belong to the rule. */
function joinNames(
  names: readonly string[],
  conjunction: "and" | "or",
): string {
  if (names.length < 2) return names[0] ?? ""
  if (names.length === 2)
    return `${names[0]} ${conjunction} ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`
}

/** Every person and group in the house, as rows in one audience list. */
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
 * WHO A QUEUE IS FOR, in one short string — the text form of `PeopleRow`.
 *
 * A shelf, a landing card and the queue editor all draw the faces. A DROPDOWN cannot: an
 * option row is a line of text, and `SelectListbox` takes a `badge` string beside it. Without
 * one, a list of queues is a list of activities — "Movies & Shows", "Movies & Shows 2",
 * "Movies & Shows 3" — because the hand-typed name that used to carry the household is gone
 * (decision `2026-08-25-a-queue-is-people-plus-an-activity`). The owner reported exactly that
 * on 2026-08-26: *"it's not clear now that we're using auto-names."*
 *
 * REQUIRED members only, and it is not an oversight. The nice-to-have tray is what a face can
 * say with a dashed ring and a line of text cannot; listing both would put four names in a
 * dropdown badge and tell you less than two do. It is the same reduction the shelf makes when
 * it draws optional faces at `sm`.
 *
 * Three names at most, then a `+n` — the badge sits at the right-hand end of an option row
 * that already holds a name, and a long one pushes the row into a wrap or an ellipsis.
 */
export function queuePeopleLabel(
  members: readonly QueueMember[],
  people: readonly Person[],
  groups: readonly GroupWithRoster[],
): string {
  const nameOf = (member: QueueMember): string =>
    member.kind === "group"
      ? (groups.find((g) => g.id === member.id)?.label ??
        member.id)
      : (people.find((p) => p.id === member.id)
          ?.displayName ?? member.id)

  const required = members.filter(
    (m) => m.role === "required",
  )

  // "Anybody" and not an empty string: a queue nobody has filed yet is a real state, and a
  // blank badge reads as data that failed to load. Same word `PeopleRow` uses for it.
  if (required.length === 0) return "Anybody"

  const names = required.map(nameOf)

  if (names.length <= 3) return names.join(", ")

  return `${names.slice(0, 3).join(", ")} +${names.length - 3}`
}

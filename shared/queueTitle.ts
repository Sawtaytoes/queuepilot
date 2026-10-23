/**
 * WHAT A QUEUE IS CALLED — the one rule the web app and the server both import.
 *
 * Until 2026-10-22 this lived in `web/src/lib/people.ts` alone, and the native TV catalog
 * (`server/src/nativeTv.ts`) wrote its own: every Plex queue was "Movies & Shows", numbered
 * "Movies & Shows · 2" with a middle dot, so a queue the owner had named "Anime" on the web
 * was a numbered activity on the TV. Two copies of a display rule drift; one copy cannot
 * (decision `2026-10-22-a-queue-title-is-one-shared-rule-for-the-web-and-the-tv`).
 *
 * PURE and dependency-free on purpose. It is compiled by two different programs — the web's
 * (Bundler resolution, DOM lib, no Node types) and the server's (NodeNext, Node types) — and
 * bundled by both Vite and esbuild. An import from either workspace here would pull that
 * workspace's whole world into the other one, so nothing is imported, not even a type.
 */

/** The activities a queue can be under. Wire values, kebab-case and stable. */
export const ACTIVITIES = [
  "watching",
  "reading",
  "video-games",
  "board-games",
] as const

export type Activity = (typeof ACTIVITIES)[number]

/** What each activity is called on screen. "Movies & Shows" is ONE activity on purpose. */
export const ACTIVITY_LABELS: Readonly<
  Record<Activity, string>
> = {
  "board-games": "Board Games",
  reading: "Reading",
  "video-games": "Video Games",
  watching: "Movies & Shows",
}

/** The fields a title is read from. */
export interface TitledQueue {
  activity: Activity
  has_explicit_label?: boolean
  label?: string
}

/** The name somebody TYPED, or `""` when nobody did. Reads `has_explicit_label`, never `label`
 *  alone — see `queueTitle`. */
const typedName = (set: {
  has_explicit_label?: boolean
  label?: string
}): string =>
  set.has_explicit_label ? (set.label ?? "").trim() : ""

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
 * The NUMBER is only ever appended to the activity, after a plain space. Two queues called
 * "Movies" are the owner's own doing and he can tell them apart; two called "Movies & Shows"
 * are the app's, and numbering them is the app's job.
 */
export function queueTitle(
  set: TitledQueue,
  duplicateNumber: number | null,
): string {
  const typed = typedName(set)

  if (typed) return typed

  const label =
    ACTIVITY_LABELS[set.activity] ?? set.activity

  return duplicateNumber == null
    ? label
    : `${label} ${duplicateNumber}`
}

/** One queue, reduced to what its duplicate number is keyed on. */
export interface NumberedQueue {
  id: string
  activity: Activity
  source: string
  has_explicit_label?: boolean
  label?: string
}

/** One member row, reduced to what its duplicate number is keyed on. */
export interface NumberedMember {
  id: string
  kind: string
  role: string
}

/**
 * The number a queue wears after its activity, or `null` for the first of its kind.
 *
 * A nameless queue is called after its activity, so two nameless queues sharing people and
 * activity read identically — "Allow, and add a number." The CALLER'S order decides, so the number is stable and creating a second
 * queue never renumbers the first.
 *
 * The signature is the source, the activity and the SORTED member list. Two queues that list the
 * same people in a different tray order are the same card and collide, because they read
 * identically. SOURCE is in it because a Picks queue and a Rules queue are two different things
 * in two different sections and never sit beside each other: without it a Rules queue eats a
 * Picks queue's number, and the landing fixture's first three Picks Movies queues came out
 * 3, 4 and 5.
 *
 * A NAMED queue takes no number and uses none up. The number is only ever appended to the
 * activity, so a queue the owner named "Movies" never prints one, and counting it made the one
 * nameless queue beside it read "Movies & Shows 2" with no "Movies & Shows" anywhere on the page
 * (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`: numbered "only
 * when two nameless ones would read identically").
 *
 * `membersBySet` is keyed by the set id that is being NUMBERED. A filtered queue has no member
 * rows of its own, so the caller hands it its parent's — `/api/queue-people` does that alias on
 * the wire, and the native catalog does it in process.
 */
export function queueNumbers<Member extends NumberedMember>(
  sets: readonly NumberedQueue[],
  membersBySet: Readonly<
    Record<string, readonly Member[] | undefined>
  >,
): Map<string, number | null> {
  const seen = new Map<string, number>()
  const out = new Map<string, number | null>()

  for (const set of sets) {
    if (typedName(set)) {
      out.set(set.id, null)
      continue
    }

    const signature = [
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
 * Every FILTERED queue lifted out of the list and re-inserted directly after its parent, in the
 * order it was already in.
 *
 * Registry order is the file's order, and nothing stops a filtered queue being written a long
 * way from its parent (or the parent being dragged past it). So the nesting is COMPUTED rather
 * than trusted off the file. An ORPHAN — a filtered queue whose parent is not in this list —
 * keeps its own place instead of disappearing: losing a queue quietly is the worse failure.
 */
export function nestFilteredQueues(
  ids: readonly string[],
  byId: (
    id: string,
  ) => { filtered_from?: string | null } | null | undefined,
): string[] {
  const present = new Set(ids)
  const childrenOf = new Map<string, string[]>()

  for (const id of ids) {
    const parentId = byId(id)?.filtered_from

    if (!parentId || !present.has(parentId)) continue

    childrenOf.set(parentId, [
      ...(childrenOf.get(parentId) ?? []),
      id,
    ])
  }

  const nested = new Set([...childrenOf.values()].flat())

  return ids.flatMap((id) =>
    nested.has(id)
      ? []
      : [id, ...(childrenOf.get(id) ?? [])],
  )
}

/**
 * A LEGACY TIER kept readable during a migration soak: a Rules set (`source: rotation`) that
 * names the sets that replaced it in `superseded_by`. It stays in the registry so an old NFC
 * card or MQTT payload that names it still resolves, and it is out of EVERY picker — the web
 * Queues page, the web pickers, the duplicate numbering, and the native TV catalog all ask
 * this one predicate.
 */
export const isSupersededTier = (set: {
  source?: unknown
  superseded_by?: unknown
}): boolean =>
  set.source === "rotation" && Boolean(set.superseded_by)

/** A registry set, reduced to what the Queues page lists and numbers it by. */
export interface ListedQueue extends NumberedQueue {
  filtered_from?: string | null
  superseded_by?: string | null
}

/**
 * The numbers the QUEUES PAGE draws, over the registry in registry order.
 *
 * Picks queues (`source: queue`) first, each filtered queue nested under its parent, then the
 * Rules queues (`source: rotation`) that are not superseded legacy tiers — exactly the two
 * sections the page draws, in the order it draws them. A number only means anything among
 * cards somebody can see at once.
 *
 * A set the page does not draw (a superseded tier) gets no entry, so `.get()` answers
 * `undefined` and the caller's `?? null` prints the bare activity.
 *
 * The web Queues page and the native TV catalog both call THIS, so the two cannot number the
 * same queue differently.
 */
export function queueListNumbers<
  Member extends NumberedMember,
>(
  sets: readonly ListedQueue[],
  membersBySet: Readonly<
    Record<string, readonly Member[] | undefined>
  >,
): Map<string, number | null> {
  const byId = new Map(sets.map((set) => [set.id, set]))
  const picks = nestFilteredQueues(
    sets
      .filter((set) => set.source === "queue")
      .map((set) => set.id),
    (id) => byId.get(id),
  )
  const rules = sets
    .filter(
      (set) =>
        set.source === "rotation" && !isSupersededTier(set),
    )
    .map((set) => set.id)

  return queueNumbers(
    [...picks, ...rules].flatMap((id) => {
      const set = byId.get(id)

      return set ? [set] : []
    }),
    membersBySet,
  )
}

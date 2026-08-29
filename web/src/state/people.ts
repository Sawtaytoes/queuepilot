import { useSyncExternalStore } from "react"

import { api } from "../lib/api"
import type {
  GroupRosterMember,
  PeopleResponse,
  QueueMember,
  QueuePeopleResponse,
} from "../lib/types"
import { uiBusy } from "./busy"

/**
 * The people slice — the roster, every group's rule, and every queue's audience.
 *
 * A slice of its own rather than a field on `state/store.ts`, for the reason that file's own
 * header gives about search input: the queue editor writes audience changes on every move, and putting
 * them in the main snapshot would re-render every shelf and every poster on each one. The main
 * store stays the thing `uiBusy()` reads all at once.
 *
 * TWO calls and not one: `/api/people` is the roster and changes when somebody is added, and
 * `/api/queue-people` is the audience and changes on every save. They are fetched together at
 * load and refreshed apart.
 */

export type PeopleSnapshot = {
  people: PeopleResponse["people"]
  groups: PeopleResponse["groups"]
  /** Set id -> its required and optional audience rows. A set with no entry has nobody on it, which is legal and is what
   *  "Anybody" on a card means. */
  byQueue: Record<string, QueueMember[]>
  /** False until the first fetch lands, so a card can tell "nobody yet" from "not asked". */
  isLoaded: boolean
}

let snapshot: PeopleSnapshot = {
  byQueue: {},
  groups: [],
  isLoaded: false,
  people: [],
}

const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getPeople = () => snapshot

export const usePeople = () =>
  useSyncExternalStore(subscribe, getPeople, getPeople)

function setPeople(patch: Partial<PeopleSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  emit()
}

/** Load the roster and every queue's trays. Best effort — the people table is empty until the
 *  owner confirms the mapping file, and an app that will not paint without it is worse than a
 *  card that says "Anybody". */
async function readPeople(): Promise<
  Pick<
    PeopleSnapshot,
    "byQueue" | "groups" | "isLoaded" | "people"
  >
> {
  const [roster, queues] = await Promise.all([
    api<PeopleResponse>("GET", "/api/people"),
    api<QueuePeopleResponse>("GET", "/api/queue-people"),
  ])

  return {
    byQueue: queues.queues ?? {},
    groups: roster.groups ?? [],
    isLoaded: true,
    people: roster.people ?? [],
  }
}

export async function loadPeople(): Promise<void> {
  try {
    setPeople(await readPeople())
  } catch {
    // Loaded, with nobody in it. The editor says so in words rather than showing three lanes
    // that look broken.
    setPeople({ isLoaded: true })
  }
}

/** Refresh the internal roster and group-audience slice after an SSE config change. */
export async function refreshPeople(): Promise<boolean> {
  try {
    const next = await readPeople()
    if (uiBusy()) return false
    setPeople(next)
    return true
  } catch {
    return false
  }
}

/**
 * Write one queue's audience, optimistically.
 *
 * Optimistic because a move that waits for a round trip before the row moves reads as a move
 * that failed. The server's answer replaces the guess, so a refusal — an unknown member, a
 * group offering two provider profiles — snaps the card back rather than leaving the screen
 * disagreeing with the store.
 */
export async function saveQueuePeople(
  setId: string,
  members: readonly QueueMember[],
): Promise<void> {
  const previous = snapshot.byQueue[setId] ?? []
  setPeople({
    byQueue: { ...snapshot.byQueue, [setId]: [...members] },
  })

  try {
    const saved = await api<{ members: QueueMember[] }>(
      "PUT",
      `/api/sets/${encodeURIComponent(setId)}/people`,
      { members },
    )
    setPeople({
      byQueue: {
        ...snapshot.byQueue,
        [setId]: saved.members,
      },
    })
  } catch (e) {
    setPeople({
      byQueue: { ...snapshot.byQueue, [setId]: previous },
    })
    throw e
  }
}

/** One queue's trays, or an empty list. Never undefined — a card that has nobody on it and a
 *  card that has not loaded look the same to a caller, and `isLoaded` is what tells them
 *  apart. */
export const queuePeople = (setId: string): QueueMember[] =>
  snapshot.byQueue[setId] ?? []

// ── The roster editor's writes ──────────────────────────────────────────────────────────── //
//
// Until these landed the roster arrived only through `/config/people-mapping.yaml`, so adding
// or renaming somebody meant editing YAML on the appliance and restarting the app. These
// writes now live inside the app.
//
// ⚠️ **NOT optimistic, unlike `saveQueuePeople` above.** An audience move is a gesture whose whole
// point is that the card moves NOW, and the round trip is the only thing between two states
// the caller can already see. These three are form submits behind a button: the answer is a
// server-generated id, a refused blank name or a list of what a delete un-filed, and guessing
// any of that would mean painting a person who may not exist. So each one re-reads and the
// caller awaits it.

/** Add somebody. The id is generated from the name, by the server, and is immutable after. */
export async function createPerson(
  displayName: string,
): Promise<void> {
  await api("POST", "/api/people", { displayName })
  await loadPeople()
}

/** Rename somebody. Their id — and so their colour — does not move. */
export async function renamePerson(
  id: string,
  displayName: string,
): Promise<void> {
  await api(
    "PATCH",
    `/api/people/${encodeURIComponent(id)}`,
    { displayName },
  )
  await loadPeople()
}

/**
 * Remove somebody, and every tray and roster that names them.
 *
 * Answers WHAT went with them, because the caller has to say so before doing it — a person on
 * three Must-be-here trays is three queues that stop coming up, and that is not visible from
 * the row being deleted.
 */
export async function removePerson(id: string): Promise<{
  groups: string[]
  queues: string[]
}> {
  const answer = await api<{
    unfiled: { groups: string[]; queues: string[] }
  }>("DELETE", `/api/people/${encodeURIComponent(id)}`)
  await loadPeople()
  return answer.unfiled
}

// ── People-group editor writes ─────────────────────────────────────────────────────────── //

/** Create the stored group shell. Its people rule is written separately by the editor. */
export async function createPeopleGroup(
  label: string,
): Promise<string> {
  const answer = await api<{ id: string }>(
    "POST",
    "/api/groups",
    { label },
  )
  return answer.id
}

/** Rename only. The group keeps its provider profile and set claims. */
export async function renamePeopleGroup(
  id: string,
  label: string,
): Promise<void> {
  await api(
    "PATCH",
    `/api/groups/${encodeURIComponent(id)}`,
    { label },
  )
}

/** The editor sends the complete people rule so removing a person is expressible. */
export async function savePeopleGroupMembership(
  id: string,
  minPresent: number | null,
  roster: readonly Pick<
    GroupRosterMember,
    "personId" | "role"
  >[],
): Promise<void> {
  await api(
    "PUT",
    `/api/groups/${encodeURIComponent(id)}/membership`,
    {
      minPresent,
      roster: roster.map((member) => ({
        personId: member.personId,
        role: member.role,
      })),
    },
  )
}

/** Delete the group and the queue/group-roster references it owns. */
export async function deletePeopleGroup(
  id: string,
): Promise<void> {
  await api(
    "DELETE",
    `/api/groups/${encodeURIComponent(id)}`,
  )
  await loadPeople()
}

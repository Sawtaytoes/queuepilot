import { useSyncExternalStore } from "react"

import { api } from "../lib/api"
import type {
  PeopleResponse,
  QueueMember,
  QueuePeopleResponse,
} from "../lib/types"

/**
 * The people slice — the roster, every group's rule, and every queue's two trays.
 *
 * A slice of its own rather than a field on `state/store.ts`, for the reason that file's own
 * header gives about search input: the queue editor writes trays on every drag, and putting
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
  /** Set id -> its two trays. A set with no entry has nobody on it, which is legal and is what
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
export async function loadPeople(): Promise<void> {
  try {
    const [roster, queues] = await Promise.all([
      api<PeopleResponse>("GET", "/api/people"),
      api<QueuePeopleResponse>("GET", "/api/queue-people"),
    ])
    setPeople({
      byQueue: queues.queues ?? {},
      groups: roster.groups ?? [],
      isLoaded: true,
      people: roster.people ?? [],
    })
  } catch {
    // Loaded, with nobody in it. The editor says so in words rather than showing three lanes
    // that look broken.
    setPeople({ isLoaded: true })
  }
}

/**
 * Write one queue's trays, optimistically.
 *
 * Optimistic because a drag that waits for a round trip before the card moves reads as a drag
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

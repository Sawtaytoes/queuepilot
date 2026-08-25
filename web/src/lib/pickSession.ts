/**
 * TONIGHT'S PICK, WRITTEN DOWN — so leaving the screen does not lose it.
 *
 * ## The bug this exists for
 *
 * The pick and reroll's memory were plain `useState`, and there was no storage of any kind
 * behind the screen. So walking away from the card lost it, and re-rolling afterwards drew
 * from the whole shelf again — with a hundred-odd titles a specific game may not resurface
 * for a long time, which is exactly what happened: the game came up, the page was left, and
 * it took narrowing the filters right down to get it back.
 *
 * ## Why `localStorage` and not the URL
 *
 * A pick is a RESULT, not an address. Putting it in the URL would make a shared or bookmarked
 * link claim to be somebody else's pick from last Tuesday, and the criteria behind it are a
 * dozen fields that do not belong in a path. This is a scratchpad for one browser, and the
 * card's own route (`/result`) stays a plain address that reads whatever the scratchpad holds.
 *
 * ## It expires, and it has to
 *
 * A pick is for AN EVENING. Reopening the app three days later and being shown Tuesday's card
 * as though it were tonight's is worse than an empty screen, because nothing on it says how
 * old it is. Twelve hours covers a game night that runs late and does not survive to the next
 * one.
 *
 * ## Every function takes its storage
 *
 * So the tests are a plain object in a Node environment, and so a browser with storage denied
 * (private mode, a locked-down profile) degrades to the old behaviour rather than throwing on
 * first paint. Reading a corrupt value is the same as reading nothing.
 */

import type { ActivityId } from "./tonight"
import type {
  PickCandidateWire,
  PickCriteriaWire,
  TonightPickWire,
} from "./types"

/**
 * The key, versioned. A shape change bumps this rather than trying to migrate a scratchpad.
 *
 * **v2 (WP-7)** — a session is now one of TWO shapes, because Pick reaches more than one
 * engine. A board-game session holds candidates off the shelf; a queue session holds queues
 * drawn for an activity. They share what an evening is (who is here, when it was saved,
 * where it came from) and nothing else, so `kind` is a real discriminant rather than a bag
 * of optional fields. A v1 value left in a browser is simply not tonight's pick and is
 * dropped — a scratchpad is not data to migrate.
 */
export const PICK_SESSION_KEY = "queuepilot.pick.v2"

/** Twelve hours. One evening, with room for one that runs late. */
export const PICK_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * Where the card came from, and it decides whether there is a reroll.
 *
 * `queue` has NO reroll — the queue already chose, and a control that re-draws would be
 * offering to overrule it. Same rule the absorbed app's own queue-arrival card followed.
 */
export type PickOrigin = "pick" | "queue"

/** What every session carries, whichever engine drew it. */
type PickSessionCommon = {
  activity: ActivityId
  /** Who is at the table. Carried so the finish step need not ask again. */
  personIds: string[]
  guestCount: number
  origin: PickOrigin
  /** ISO 8601. Read back to decide whether this is still tonight. */
  savedAt: string
}

/** A draw off the SHELF — the absorbed Board Game Picker engine. */
export type BoardGamePickSession = PickSessionCommon & {
  kind: "board-game"
  criteria: PickCriteriaWire
  /** Every game offered and turned down — reroll's memory, and the thing that was lost. */
  excludedGameIds: string[]
  candidates: PickCandidateWire[]
}

/**
 * A draw from the QUEUES — Movies, Shows, Reading and Video Games (WP-7).
 *
 * `backend` is the one provider this session is bound to. A reroll sends it back so the
 * evening cannot walk from a Steam queue to a MiSTer one halfway through.
 */
export type QueuePickSession = PickSessionCommon & {
  kind: "queue"
  backend: string | null
  /** Every queue offered and turned down — the same memory, one shape up. */
  excludedSetIds: string[]
  picks: TonightPickWire[]
  /** Filters the form collected that no backend can act on yet. Shown on the card. */
  notes: string[]
}

export type PickSession =
  | BoardGamePickSession
  | QueuePickSession

/** The browser's own storage, or nothing when it is denied. Never throws. */
export function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function writePickSession(
  session: PickSession,
  storage: Storage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(
      PICK_SESSION_KEY,
      JSON.stringify(session),
    )
  } catch {
    // A full or denied quota loses the durability and nothing else. The card on screen is
    // still the card on screen.
  }
}

export function clearPickSession(
  storage: Storage | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(PICK_SESSION_KEY)
  } catch {
    /* nothing to clear */
  }
}

/**
 * Tonight's pick, or `null`.
 *
 * `null` for absent, for unparseable, for the wrong shape and for too old — every one of them
 * means "there is no pick to show", and telling them apart would be four empty states saying
 * the same sentence.
 */
export function readPickSession(
  storage: Storage | null = defaultStorage(),
  now: Date = new Date(),
): PickSession | null {
  let raw: string | null = null
  try {
    raw = storage?.getItem(PICK_SESSION_KEY) ?? null
  } catch {
    return null
  }
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object") return null
  const session = parsed as Record<string, unknown>

  if (typeof session.savedAt !== "string") return null

  const savedAt = Date.parse(session.savedAt)
  if (
    !Number.isFinite(savedAt) ||
    now.getTime() - savedAt > PICK_SESSION_MAX_AGE_MS
  ) {
    return null
  }

  const common = {
    activity:
      (session.activity as ActivityId) ?? "board-games",
    guestCount:
      typeof session.guestCount === "number"
        ? session.guestCount
        : 0,
    origin: (session.origin === "queue"
      ? "queue"
      : "pick") as PickOrigin,
    personIds: Array.isArray(session.personIds)
      ? (session.personIds as string[])
      : [],
    savedAt: session.savedAt,
  }

  if (session.kind === "queue") {
    const picks = session.picks
    // An empty draw is not a session. The same rule the board-game branch has always had:
    // there is no pick to show, and four empty states saying that would be four ways to say
    // one sentence.
    if (!Array.isArray(picks) || picks.length === 0) {
      return null
    }
    return {
      ...common,
      backend:
        typeof session.backend === "string"
          ? session.backend
          : null,
      excludedSetIds: Array.isArray(session.excludedSetIds)
        ? (session.excludedSetIds as string[])
        : [],
      kind: "queue",
      notes: Array.isArray(session.notes)
        ? (session.notes as string[])
        : [],
      picks: picks as QueuePickSession["picks"],
    }
  }

  const candidates = session.candidates
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    !session.criteria
  ) {
    return null
  }

  return {
    ...common,
    candidates:
      candidates as BoardGamePickSession["candidates"],
    criteria: session.criteria as PickCriteriaWire,
    excludedGameIds: Array.isArray(session.excludedGameIds)
      ? (session.excludedGameIds as string[])
      : [],
    kind: "board-game",
  }
}

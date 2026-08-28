import { api } from "./api"
import {
  criteriaFromTonight,
  tableSize,
} from "./boardGames"
import type { PickSession } from "./pickSession"
import {
  defaultFilterValues,
  type SurpriseScope,
} from "./tonight"
import type { TonightPreset } from "./tonightPreset"
import { routeFor } from "./tonightRouting"
import type {
  PickResponse,
  TonightPickResponse,
} from "./types"

/**
 * ONE DRAW, TWO CALLERS.
 *
 * The Tonight form's Go button and a preset card's address (`/tonight/go?…`) have to produce
 * the SAME evening — same request, same engine choice, same session written down, same card
 * on screen. They were one function inside `TonightView`'s Go button, which is exactly where
 * a second caller cannot reach it, and a copy would be two places for "which engine does this
 * activity use" to disagree.
 *
 * ## The engine is chosen by the map, never by this file
 *
 * `routeFor` (WP-7) is the one table from an activity to the backend behind it, and it is
 * written twice on purpose — once for the server and once for the browser — with
 * `e2e/tonight-routing-test.ts` comparing them field by field. This function reads that map
 * and does not second-guess it:
 *
 *   * `board-games` draws from the SHELF (`POST /api/board-games/pick`) and is chosen by table
 *     size, which is why an empty table is refused rather than defaulted.
 *   * `narrow-first` (Surprise Me) is handled by `drawSurprise` after its own screen has
 *     supplied one of the three approved scopes. A bare preset remains refused because a
 *     preset card cannot answer that second question.
 *   * everything else is QUEUE-FIRST (`POST /api/tonight/pick`): one queue is drawn for the
 *     activity and the people, and the queue's own engine chooses the item when it starts.
 *
 * ## It returns a session; it does not navigate and it does not store
 *
 * Writing the scratchpad and moving the browser belong to the caller, so this stays testable
 * in a Node environment with a stub request function and no DOM.
 */
export type DrawOutcome =
  | { isDrawn: true; session: PickSession }
  | { isDrawn: false; reason: string }

/** The one call this makes, injectable so a test needs no network. */
export type DrawRequest = <T>(
  method: string,
  url: string,
  body?: unknown,
) => Promise<T>

export async function drawTonight(
  preset: TonightPreset,
  request: DrawRequest = api,
): Promise<DrawOutcome> {
  const { activity, filters, guestCount, personIds } =
    preset
  const route = routeFor(activity)
  const savedAt = new Date().toISOString()

  if (route.engine === "narrow-first") {
    return {
      isDrawn: false,
      reason:
        "Surprise Me narrows down first. Choose Media, Games or Reading.",
    }
  }

  if (route.engine === "board-games") {
    // The people on this screen are a FILTER, so an empty answer is not "nought players", it
    // is "you have not said" — and a shelf pick is chosen by how many are at the table.
    // Guests count, which is how a table with no roster rows still gets a pick.
    if (tableSize(personIds, guestCount) === 0) {
      return {
        isDrawn: false,
        reason:
          "Tick who is playing, or add a guest — a pick needs to know how many are at the table.",
      }
    }

    const criteria = criteriaFromTonight({
      filters,
      guestCount,
      personIds,
    })
    const answer = await request<PickResponse>(
      "POST",
      "/api/board-games/pick",
      criteria,
    )

    if (answer.shortlist.length === 0) {
      return {
        isDrawn: false,
        reason:
          answer.result?.outcome === "empty"
            ? (answer.result.suggestion ??
              "Nothing on the shelf fits that.")
            : "Nothing on the shelf fits that.",
      }
    }

    return {
      isDrawn: true,
      session: {
        activity,
        candidates: answer.shortlist,
        criteria,
        excludedGameIds: [],
        guestCount,
        kind: "board-game",
        origin: "pick",
        personIds: [...personIds],
        savedAt,
      },
    }
  }

  const answer = await request<TonightPickResponse>(
    "POST",
    "/api/tonight/pick",
    {
      activity,
      excludedSetIds: [],
      guestCount,
      personIds: [...personIds],
    },
  )

  if (!answer.pick || answer.shortlist.length === 0) {
    return {
      isDrawn: false,
      reason:
        answer.reason ?? "Nothing matches that tonight.",
    }
  }

  return {
    isDrawn: true,
    session: {
      activity,
      backend: answer.backend,
      excludedSetIds: [],
      guestCount,
      kind: "queue",
      notes: answer.notes ?? [],
      origin: "pick",
      personIds: [...personIds],
      picks: answer.shortlist,
      savedAt,
    },
  }
}

/**
 * Draw after Surprise Me's second screen has supplied its approved scope.
 *
 * The scope chooses an ACTIVITY first, uniformly, then delegates to that activity's existing
 * engine. That keeps the two real engines single-sourced: Board Games still uses the shelf,
 * and every queue-first activity still uses `/api/tonight/pick`. When one activity has no
 * eligible answer, the remaining activities in the scope are tried before the scope is called
 * empty. The result session records the activity that actually won, so its card and reroll use
 * the same established rules as a direct pick.
 */
export async function drawSurprise(
  {
    guestCount,
    personIds,
    scope,
  }: {
    guestCount: number
    personIds: readonly string[]
    scope: SurpriseScope
  },
  request: DrawRequest = api,
  random: () => number = Math.random,
): Promise<DrawOutcome> {
  const activities = [...scope.activities]

  for (
    let index = activities.length - 1;
    index > 0;
    index -= 1
  ) {
    const swap = Math.min(
      index,
      Math.max(0, Math.floor(random() * (index + 1))),
    )
    const current = activities[index]!
    activities[index] = activities[swap]!
    activities[swap] = current
  }

  const reasons: string[] = []
  for (const activity of activities) {
    const outcome = await drawTonight(
      {
        activity,
        filters: defaultFilterValues(activity),
        guestCount,
        personIds: [...personIds],
      },
      request,
    )
    if (outcome.isDrawn) return outcome
    reasons.push(outcome.reason)
  }

  return {
    isDrawn: false,
    reason:
      reasons[0] ??
      `Nothing in ${scope.label} matches the people you ticked.`,
  }
}

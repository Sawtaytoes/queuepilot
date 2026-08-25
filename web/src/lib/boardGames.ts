/**
 * The board-game half of Tonight: the form's answers turned into a pick request, and the
 * words a card says.
 *
 * Pure — no React, no DOM, no fetch — so `boardGames.test.ts` can call every one of these
 * in a Node environment. The API shapes live in `lib/types.ts` beside every other wire type.
 */

import type { ActivityId } from "./tonight"
import type {
  BoardGameCard,
  KnownHowClaim,
  PickCriteriaWire,
} from "./types"

/**
 * "Keep it light: On" means a complexity ceiling of 2.4.
 *
 * Not invented here: 2.4 is the top of the **medium-light** band in the vocabulary the
 * absorbed picker already used on its own complexity control, and re-picking the number would
 * have meant two apps disagreeing about the same word. It is a starting point and is meant to
 * move after a real game night, which is why it is a named constant and not a literal in a
 * mapping table.
 */
export const LIGHT_MAX_WEIGHT = 2.4

/**
 * The head count for a pick: everybody ticked, plus the anonymous seats.
 *
 * A guest is a seat at the table with no roster row, so they count towards the player count
 * and towards nothing else — no complexity ceiling, no familiarity history, and no attendance
 * row when the play is logged, because there is nobody to attach one to.
 */
export const tableSize = (
  personIds: readonly string[],
  guestCount: number,
): number => personIds.length + Math.max(0, guestCount)

/**
 * The Tonight form, as the pick engine's criteria.
 *
 * Three filters, and each maps to exactly one field:
 *
 *   - **Player-count fit** — `Best` is the community's `best` list only; `OK` widens to the
 *     counts it also recommends. Neither is the box range, which is a manufacturing claim.
 *   - **Knows the rules** — `Any` / `Someone` / `All`. The engine's third value is spelled
 *     `everyone`, which is the word the decision that created the fact uses.
 *   - **Keep it light** — a complexity ceiling, not a time limit. Time is its own axis and
 *     the form does not ask about it yet.
 *
 * The ticked people go through as `personIds` as well as into the count. They are what the
 * familiarity bonus counts plays for and whose personal complexity ceilings apply — dropping
 * them and sending only a number would silently offer somebody a game they will not play.
 */
export function criteriaFromTonight({
  filters,
  guestCount,
  personIds,
}: {
  filters: Record<string, string>
  guestCount: number
  personIds: readonly string[]
}): PickCriteriaWire {
  return {
    excludedGameIds: [],
    fitness:
      filters.fit === "ok"
        ? "bestOrRecommended"
        : "bestOnly",
    maxWeight:
      filters.light === "on" ? LIGHT_MAX_WEIGHT : null,
    personIds: [...personIds],
    playerCount: tableSize(personIds, guestCount),
    rulesKnown:
      filters.knows === "all"
        ? "everyone"
        : filters.knows === "any"
          ? "any"
          : "someone",
  }
}

/**
 * What the known-how control is CALLED, and it is not the same sentence for every activity.
 *
 * A board game has rules you read; a video game has controls you learn. The fact is the same
 * shape — one person, one title, "I can start this without help" — and the words are not.
 */
export const knownHowLabel = (
  activity: ActivityId,
): string =>
  activity === "video-games"
    ? "Knows how to play"
    : "Knows the rules"

/**
 * Who the finish step ticks BY DEFAULT: everybody who was at the table.
 *
 * ⚠️ This is a PROPOSAL, and the difference matters more than the code does. Sitting through
 * a game is decent evidence that you can start it again, so the screen offers it already
 * ticked and lets the answer be corrected before anything is written. It is **not** an
 * inference from a play count, and nothing derives a claim from one — a play may RENEW a
 * claim and may never invent one, which is why this returns a suggestion for a person to
 * confirm rather than a set of rows to insert.
 */
export const knownHowProposal = (
  personIds: readonly string[],
): string[] => [...personIds]

/** Everybody who has already stated a claim about this game. */
export const knownHowFor = (
  claims: readonly KnownHowClaim[],
  gameId: string,
): string[] =>
  claims
    .filter((claim) => claim.gameId === gameId)
    .map((claim) => claim.personId)

/**
 * BGG's 1–5 complexity, said in words. "2.4" means nothing standing at a shelf.
 *
 * `null` is "nobody has rated it", which is NOT "trivial" — a 0 here would win every
 * complexity filter it should have failed.
 */
export function weightLabel(weight: number | null): string {
  if (weight === null) return "Complexity unrated"
  if (weight < 1.75) return `Light (${weight.toFixed(1)})`
  if (weight < 2.5)
    return `Medium-light (${weight.toFixed(1)})`
  if (weight < 3.25) return `Medium (${weight.toFixed(1)})`
  if (weight < 4)
    return `Medium-heavy (${weight.toFixed(1)})`
  return `Heavy (${weight.toFixed(1)})`
}

/** "2–5 players · best with 3–4". The box range first, then the community's verdict. */
export function playerCountLine(
  game: Pick<
    BoardGameCard,
    "bestWith" | "maxPlayers" | "minPlayers"
  >,
): string {
  const range =
    game.minPlayers === game.maxPlayers
      ? `${game.minPlayers} player${game.minPlayers === 1 ? "" : "s"}`
      : `${game.minPlayers}–${game.maxPlayers} players`

  if (game.bestWith.length === 0) return range

  const best = [...game.bestWith].sort((a, b) => a - b)
  const first = best[0]
  const last = best[best.length - 1]
  const bestText =
    first === last ||
    first === undefined ||
    last === undefined
      ? `${first ?? ""}`
      : best.length === last - first + 1
        ? `${first}–${last}`
        : best.join(", ")

  return `${range} · best with ${bestText}`
}

/** "30–60 min", or nothing when the box never said. */
export function playtimeLabel(
  game: Pick<BoardGameCard, "maxPlaytime" | "minPlaytime">,
): string | null {
  const min = game.minPlaytime ?? game.maxPlaytime
  const max = game.maxPlaytime ?? game.minPlaytime
  if (min === null || max === null) return null
  return min === max ? `${min} min` : `${min}–${max} min`
}

/**
 * The box art, off THIS app's origin.
 *
 * The stored path is the absorbed app's own (`/images/<file>`); the staging tool put the
 * files under `board-game-images/` beside the book of record, and the server serves them from
 * there. Anything already absolute is left alone — a link out to somebody else's CDN is not
 * ours to rewrite, and there are none today.
 */
export function boxArtUrl(
  imagePath: string | null | undefined,
): string | null {
  if (!imagePath) return null
  if (/^https?:\/\//.test(imagePath)) return imagePath

  const file = imagePath.split("/").filter(Boolean).pop()
  if (!file) return null

  return `/api/board-games/images/${encodeURIComponent(file)}`
}

/** "Never played", "Played once", "Played 12 times" — the log, in a sentence. */
export function playCountLabel(count: number): string {
  if (count <= 0) return "Never played"
  if (count === 1) return "Played once"
  return `Played ${count} times`
}

/**
 * Search the shelf the way somebody standing in front of it would: by name, by publisher, by
 * year.
 *
 * An EMPTY term answers with the whole collection here, which is the opposite of the queue
 * editor's search box and is right for both. That box is a lookup and the whole shelf
 * arriving on the first keystroke-less render is noise; this screen IS the shelf.
 */
export function filterCollection(
  games: readonly BoardGameCard[],
  {
    isExcludedShown = false,
    query = "",
  }: { isExcludedShown?: boolean; query?: string },
): BoardGameCard[] {
  const term = query.trim().toLowerCase()

  return games.filter((game) => {
    if (game.isExcluded && !isExcludedShown) return false
    if (term === "") return true
    return game.name.toLowerCase().includes(term)
  })
}

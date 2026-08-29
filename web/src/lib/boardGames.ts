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
  BoardGameInteractionType,
  KnownHowClaim,
  PickCriteriaWire,
} from "./types"

/** The Light complexity choice keeps the existing 2.4 ceiling. */
export const LIGHT_MAX_WEIGHT = 2.4

/**
 * Complexity choices are ceilings, using the boundaries from the absorbed Board Game Picker.
 * Any complexity above 3.9 requires the neutral `Any` choice.
 */
export const COMPLEXITY_MAX_WEIGHTS = {
  light: LIGHT_MAX_WEIGHT,
  medium: 3.2,
  heavy: 3.9,
} as const

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
 * The board-game filters map to the engine's criteria fields:
 *
 *   - **Player-count fit** — `Best` is the community's `best` list only; `OK` widens to the
 *     counts it also recommends. Neither is the box range, which is a manufacturing claim.
 *   - **Knows the rules** — `Any` / `Someone` / `All`. The engine's third value is spelled
 *     `everyone`, which is the word the decision that created the fact uses.
 *   - **Interaction type**, **categories** and **maximum playtime** pass through to the
 *     corresponding engine fields. Their `Any` values become the engine's null or empty
 *     values.
 *   - **Complexity** — `Any`, `Light`, `Medium` and `Heavy` are maximum-weight ceilings, not
 *     strict bands. Time is its own axis and remains separate from this control.
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
  const interactionTypes: readonly BoardGameInteractionType[] =
    [
      "competitive",
      "cooperative",
      "semiCooperative",
      "team",
      "traitor",
      "solo",
    ]
  const interactionType = interactionTypes.includes(
    filters.interactionType as BoardGameInteractionType,
  )
    ? (filters.interactionType as BoardGameInteractionType)
    : null
  const maxPlaytimeValue =
    filters.maxPlaytime && filters.maxPlaytime !== "any"
      ? Number(filters.maxPlaytime)
      : null
  const complexity = filters.complexity
  const maxWeight =
    complexity === "light" ||
    complexity === "medium" ||
    complexity === "heavy"
      ? COMPLEXITY_MAX_WEIGHTS[complexity]
      : filters.light === "on"
        ? LIGHT_MAX_WEIGHT
        : null

  return {
    categories: (filters.categories ?? "")
      .split(",")
      .map((category) => category.trim())
      .filter(Boolean),
    excludedGameIds: [],
    fitness:
      filters.fit === "ok"
        ? "bestOrRecommended"
        : "bestOnly",
    interactionType,
    maxWeight,
    maxPlaytime:
      maxPlaytimeValue !== null &&
      Number.isFinite(maxPlaytimeValue)
        ? maxPlaytimeValue
        : null,
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

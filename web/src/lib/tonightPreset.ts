import { WATCH_PLAY_PATH } from "./routePaths"
import {
  ACTIVITY_FILTERS,
  type ActivityId,
  defaultFilterValues,
  findActivity,
} from "./tonight"

/**
 * A PRESET CARD — the address form of "who's here, what we're doing, go".
 *
 * ## The rule this file exists to hold
 *
 * The absorb decision's NFC table (`2026-08-22-tonight-picker-merge…` §5) has four rows, and
 * three of them already worked before this file existed:
 *
 * | Card | Works how |
 * | --- | --- |
 * | A kids show rotation | Queue mode. `{"set": "<id>"}` over MQTT. No live parameters. |
 * | A solo reading queue | `/go/<setId>` — one address, one queue, no form. |
 * | A Pick PRESET — people and filters baked in | **This file.** |
 * | Bare "board games", needing live who's-here | ❌ **Use the app.** |
 *
 * The fourth row is the one people try to fix, and it is not a gap. A card is a fixed string
 * on a piece of plastic; it cannot ask who walked into the room. So a preset that names
 * NOBODY is REFUSED here rather than being helpfully treated as "everybody" or as "no filter"
 * — both of those would produce a pick for a table whose size nobody stated, and a board-game
 * pick is chosen BY table size. The refusal lands on the form with the activity already
 * chosen, which is the honest answer: this is the flow that needs glass.
 *
 * ## Why the answer is a result and never an empty form
 *
 * §5's last line: *"Pick-preset NFC → land on result card (or announce), not an empty form."*
 * A card that opens a form has spent the tap and asked the question again. So a valid preset
 * draws immediately and lands on `/result`.
 *
 * ## The grammar
 *
 *   /tonight/go?activity=board-games&people=ada,linus&guests=1&light=on
 *
 * `activity` names one of the six tiles. `people` is a comma-separated list of person ids —
 * the ids `GET /api/people` returns, not display names, because a name is not stable and an
 * id is. `guests` is a count of anonymous seats. Everything else is a FILTER, and a filter is
 * only accepted under the id and the value its own activity declares (`ACTIVITY_FILTERS`).
 *
 * ## Nothing here invents a value
 *
 * An unknown filter id is dropped; an unknown value for a known filter falls back to that
 * filter's own default rather than being passed through. A card is written once and read for
 * years, so the failure to design for is a typo'd card silently changing what gets picked —
 * `light=onn` must behave as the default, not as a third state nothing handles.
 *
 * No DOM and no React in this file, so a Node test calls it directly.
 */

export type TonightPreset = {
  activity: ActivityId
  personIds: string[]
  guestCount: number
  filters: Record<string, string>
}

/**
 * What a card's address parsed to.
 *
 * A refusal still carries a `preset`, and that is the point of the shape: the form it lands on
 * shows what the card DID say, so the one missing answer is the only thing left to give.
 */
export type PresetParse =
  | { isAccepted: true; preset: TonightPreset }
  | {
      isAccepted: false
      reason: string
      preset: TonightPreset | null
    }

/** The tile a card may not name. Surprise Me narrows on a second screen before it picks. */
const NARROWS_FIRST: ActivityId = "surprise"

const readList = (raw: string | null): string[] =>
  (raw ?? "")
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean)

const readCount = (raw: string | null): number => {
  const n = Number.parseInt(raw ?? "", 10)

  // A negative or unparseable count is nought seats, not an error: `guests` is the optional
  // half of "who's here" and a card that miscounts guests but names people still works.
  return Number.isFinite(n) && n > 0 ? Math.min(n, 99) : 0
}

/**
 * Read a card's query string.
 *
 * Takes the raw `location.search` (leading `?` optional) so the caller does not have to own a
 * `URLSearchParams`, and so a test is one string.
 */
export function parseTonightPreset(
  search: string,
): PresetParse {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  )

  const wanted = params.get("activity")
  const activity = findActivity(wanted as ActivityId)

  if (!activity) {
    return {
      isAccepted: false,
      preset: null,
      reason: wanted
        ? `This card asks for “${wanted}”, which is not one of the activities.`
        : "This card does not say what the evening is.",
    }
  }

  const personIds = readList(params.get("people"))
  const guestCount = readCount(params.get("guests"))

  // Only the filters this activity declares, and only the values they declare. Anything else
  // falls to the filter's own default rather than being carried through.
  const filters = defaultFilterValues(activity.id)
  for (const filter of ACTIVITY_FILTERS[activity.id]) {
    const raw = params.get(filter.id)
    if (raw == null) continue
    if (
      filter.options.some((option) => option.value === raw)
    ) {
      filters[filter.id] = raw
    }
  }

  const preset: TonightPreset = {
    activity: activity.id,
    filters,
    guestCount,
    personIds,
  }

  if (activity.id === NARROWS_FIRST) {
    return {
      isAccepted: false,
      preset,
      reason:
        "Surprise Me narrows down first, so it cannot be baked into a card.",
    }
  }

  // THE RULE. A card cannot see the room, so a card that names nobody has not asked a
  // question this app can answer — see the header.
  if (personIds.length === 0 && guestCount === 0) {
    return {
      isAccepted: false,
      preset,
      reason:
        "This card does not say who is here, and a card cannot tell. Tick who is playing.",
    }
  }

  return { isAccepted: true, preset }
}

/**
 * The address a preset card is written with — the inverse of the parse, so the two cannot
 * drift and so anything that wants to OFFER a card (a share button, a doc, a test) builds it
 * one way.
 *
 * A filter sitting at its own default is left OUT. A card is read by a person with a phone
 * held against it and by whoever has to debug it in two years; the short address says only
 * what was actually chosen.
 */
export function tonightPresetHref(
  preset: TonightPreset,
): string {
  const params = new URLSearchParams()
  params.set("activity", preset.activity)
  if (preset.personIds.length) {
    params.set("people", preset.personIds.join(","))
  }
  if (preset.guestCount > 0) {
    params.set("guests", String(preset.guestCount))
  }
  for (const filter of ACTIVITY_FILTERS[preset.activity]) {
    const value = preset.filters[filter.id]
    if (value != null && value !== filter.defaultValue) {
      params.set(filter.id, value)
    }
  }

  return `${WATCH_PLAY_PATH}/go?${params.toString()}`
}

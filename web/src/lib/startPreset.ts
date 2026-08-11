import type {
  NextEp,
  ShowEpisodes,
  StartPoint,
} from "./types"

/**
 * The default-selection maths behind the "Start from…" modal, split out from the
 * component so it can be tested without a DOM — and so the show path and every
 * collection member seed their Episode dropdown through ONE rule.
 */

/** Keep `want` when it is one of the values, else fall to the first — which is what a
 * `<select>` does on its own when the value is unknown. */
export const pickOptionValue = (
  values: string[],
  want: string | number | null | undefined,
): string => {
  const w = want == null ? null : String(want)

  return w && values.includes(w) ? w : (values[0] ?? "")
}

/**
 * The {season, episode} to preselect for one collection MEMBER's pickers: the stored
 * override when it names this member, else where this member would play NEXT anyway —
 * the SAME next-unwatched the tile shows, because `collectionNext` (server `plex.js`)
 * already carries the next-up member's {season, episode}. A member that is neither the
 * override target nor the next-up member has nothing to preselect (null → the season's
 * first episode, unchanged).
 *
 * This is the collection fix: without the `nextEp` fallback the modal seeded null for a
 * plain collection entry, so its Episode dropdown fell to index 0 (E1) instead of the
 * active series' next-unwatched (E24) that the tile already shows.
 */
export function memberPreset(
  stored: StartPoint | null,
  nextEp: NextEp | null,
  memberRatingKey: string,
): StartPoint | null {
  const rk = String(memberRatingKey)

  if (stored && String(stored.series) === rk) return stored

  if (
    nextEp &&
    String(nextEp.memberRatingKey ?? "") === rk
  ) {
    return {
      episode: nextEp.episode ?? undefined,
      season: nextEp.season ?? undefined,
    }
  }

  return null
}

/**
 * Which {season, episode} the modal's Season/Episode pickers land on for one series'
 * episode data and a preset — the single source of truth for the show path AND every
 * collection member. Mirrors a `<select>`: keep the preset value when it exists in the
 * data, else fall to the first option.
 */
export function defaultStartPoint(
  data: ShowEpisodes,
  preset: StartPoint | null,
): { season: string; episode: string } {
  const season = pickOptionValue(
    data.seasons.map((s) => String(s.season)),
    preset?.season ?? null,
  )
  const row =
    data.seasons.find((x) => x.season === Number(season)) ??
    data.seasons[0]
  const episode = pickOptionValue(
    (row?.episodes ?? []).map((e) => String(e.episode)),
    // The episode floor only applies when the preset is for THIS season — a preset
    // season that differs means its episode number belongs to another season.
    preset &&
      Number(preset.season ?? row?.season) === row?.season
      ? preset.episode
      : null,
  )

  return { episode, season }
}

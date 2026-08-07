import { SelectListbox } from "./SelectListbox"
import { useCallback, useEffect, useState } from "react"

import { api } from "../lib/api"
import {
  defaultStartPoint,
  memberPreset,
  pickOptionValue,
} from "../lib/startPreset"
import type {
  CollectionChild,
  NextEp,
  ShowEpisodes,
  StartPoint,
} from "../lib/types"
import { closeStartModal, useOverlays } from "../state/overlays"
import { Modal } from "./Modal"
import { commitStart } from "./startCommit"

/**
 * "Start from…" — the manual start point for a show / collection entry.
 *
 * Everything here is **PICKED, never typed**: the member series, the season, the
 * real episode title. A typed number can name an episode that doesn't exist, or the
 * wrong season; a list of real episode titles (with watched marks) can't.
 * (decisions `2026-07-31-start-episode-is-picked-in-a-modal` and
 * `2026-07-31-per-entry-start-episode-override`)
 *
 * The three rows appear per entry kind:
 *
 * | Entry                          | Rows                          |
 * | ------------------------------ | ----------------------------- |
 * | Show, one season (every anime) | Episode                       |
 * | Show, several seasons          | Season, then Episode          |
 * | Collection                     | Series, then Season/Episode — or nothing more when the member is a movie |
 *
 * Already-watched episodes say so **in words**, because an `<option>` cannot be
 * styled and a ✓ glyph is a tofu box in some fonts.
 */

type Option = { value: string; label: string }

/** `fillOptions`' rule: keep `want` if it is one of the options, else fall to the
 * first — delegating to the shared value-picker the default-selection maths uses. */
const pick = (options: Option[], want: string | number | null | undefined) =>
  pickOptionValue(
    options.map((o) => o.value),
    want,
  )

export function StartModal() {
  const { startModal: entry } = useOverlays()
  const item = entry?.item ?? null
  const isCollection = item?.type === "collection"

  const [note, setNote] = useState("")
  const [children, setChildren] = useState<CollectionChild[]>([])
  const [seriesValue, setSeriesValue] = useState("")
  const [episodeData, setEpisodeData] = useState<ShowEpisodes | null>(null)
  const [seasonValue, setSeasonValue] = useState("")
  const [episodeValue, setEpisodeValue] = useState("")
  const [isEpisodeShown, setIsEpisodeShown] = useState(false)
  const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(false)

  /** Load one series' seasons/episodes. `preset` is the {season, episode} to
   * preselect (the stored override, else where it would play next anyway). */
  const loadEpisodes = useCallback(
    async (ratingKey: string, preset: StartPoint | null) => {
      setIsLoadingEpisodes(true)
      setIsEpisodeShown(true)

      let data: ShowEpisodes | null = null

      try {
        data = await api<ShowEpisodes>("GET", `/api/show/${ratingKey}/episodes`)
      }
      catch {
        /* handled below */
      }

      setIsLoadingEpisodes(false)

      if (!data || !data.seasons.length) {
        setEpisodeData(null)
        setIsEpisodeShown(false)
        setNote("Could not read this series’ episodes from Plex.")

        return
      }

      setEpisodeData(data)

      // The Season/Episode defaults come from one shared rule (`defaultStartPoint`),
      // so a collection member seeds exactly like a show entry does.
      const { season, episode } = defaultStartPoint(data, preset)

      setSeasonValue(season)
      setEpisodeValue(episode)
    },
    [],
  )

  /** A collection member: a series opens its pickers, a movie member has nothing
   * more to pick inside it. */
  const paintMember = useCallback(
    async (
      rk: string,
      kids: CollectionChild[],
      stored: StartPoint | null,
      nextEp: NextEp | null,
    ) => {
      const child = kids.find((c) => String(c.ratingKey) === String(rk))

      if (!child || child.type !== "show") {
        setIsEpisodeShown(false)
        setEpisodeData(null)
        setNote(
          child
            ? `“${child.title}” is a single item — the collection simply starts there.`
            : "",
        )

        return
      }

      setNote("")

      // The stored override if it names this member, else where this member plays next
      // anyway — the same next-unwatched the tile shows. Without this fallback a plain
      // collection entry seeded null and the Episode dropdown fell to E1.
      const preset = memberPreset(stored, nextEp, rk)

      await loadEpisodes(child.ratingKey, preset)
    },
    [loadEpisodes],
  )

  // Open: reset, then fetch whatever this entry kind needs.
  useEffect(() => {
    if (!entry || !item) return

    let isStale = false

    setNote("")
    setChildren([])
    setSeriesValue("")
    setEpisodeData(null)
    setSeasonValue("")
    setEpisodeValue("")
    setIsEpisodeShown(false)

    const run = async () => {
      if (item.type !== "collection") {
        // A show entry: the start is {season, episode} of this series. Preselect
        // the override if there is one, else where it would play next anyway.
        await loadEpisodes(
          String(item.ratingKey),
          item.start ?? (item.nextEp as StartPoint | null),
        )

        return
      }

      // A collection entry: pick WHICH member to begin at first — members before it
      // are skipped.
      let kids: CollectionChild[] = []

      try {
        ;({ children: kids } = await api<{ children: CollectionChild[] }>(
          "GET",
          `/api/collection/${item.ratingKey}/children`,
        ))
      }
      catch {
        if (!isStale) {
          setNote("Could not read this collection’s members from Plex.")
        }

        return
      }

      if (isStale) return

      setChildren(kids)

      const want =
        item.start && item.start.series != null
          ? String(item.start.series)
          : item.nextEp?.memberRatingKey || null
      // A hand-written YAML entry may name the member by title rather than
      // ratingKey — the engine matches either, so the picker must too.
      const byRatingKey = kids.some((c) => String(c.ratingKey) === String(want))
        ? want
        : kids.find(
            (c) => c.title.toLowerCase() === String(want || "").toLowerCase(),
          )?.ratingKey
      const chosen = pick(
        kids.map((c) => ({ label: c.title, value: String(c.ratingKey) })),
        byRatingKey,
      )

      setSeriesValue(chosen)
      await paintMember(chosen, kids, item.start, item.nextEp)
    }

    void run()

    return () => {
      isStale = true
    }
    // `entry` identity changes exactly once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry])

  if (!entry || !item) {
    return (
      <Modal id="startmodal" isOpen={false} onClose={closeStartModal} title="Start from…" titleId="startmodal-title">
        <p className="subhint">
          Playback begins here and keeps going automatically. Earlier episodes are
          skipped — nothing is marked watched on Plex.
        </p>
      </Modal>
    )
  }

  const seasonRow =
    episodeData?.seasons.find((x) => String(x.season) === seasonValue) ??
    episodeData?.seasons[0]
  const isSeasonShown = Boolean(episodeData?.multiSeason) && isEpisodeShown

  /** Read the pickers back out as the value to persist (null = automatic). */
  const readForm = (): StartPoint | null => {
    const start: StartPoint = {}

    if (isCollection) {
      if (!seriesValue) return null

      start.series = seriesValue
    }

    if (isEpisodeShown) {
      const ep = parseInt(episodeValue, 10)

      if (!Number.isNaN(ep)) {
        start.episode = ep
        // The season is tracked even when its row is hidden — a single-season show
        // stores its sole season, which is what the engine's floor compares against.
        start.season = Number(seasonValue || 1)
      }
    }

    return start.series != null || start.episode != null ? start : null
  }

  return (
    <Modal
      footer={
        <>
          <button
            className="ghost"
            hidden={!item.start}
            id="start-clear"
            onClick={() => void commitStart(entry, null)}
            type="button"
          >
            Clear — start automatically
          </button>
          <span className="spacer" />
          <button
            className="ghost"
            id="start-cancel"
            onClick={closeStartModal}
            type="button"
          >
            Cancel
          </button>
          <button id="start-save" type="submit">
            Save
          </button>
        </>
      }
      id="startmodal"
      isOpen
      onClose={closeStartModal}
      onSubmit={() => void commitStart(entry, readForm())}
      title={`Start “${item.title}” from…`}
      titleId="startmodal-title"
    >
      <p className="subhint">
        Playback begins here and keeps going automatically. Earlier episodes are
        skipped — nothing is marked watched on Plex.
      </p>

      <label className="field" hidden={!isCollection} id="start-seriesbox">
        Series
        {/* The three pickers below are chained, and each key names the writer that
            is NOT the user.

            Series: the members arrive from Plex after the modal opens, so this
            renders once against `Loading members…` and once against the real list.
            `children.length` changes exactly then — and `setSeriesValue(chosen)`
            lands in the same tick — so the remount seeds the stored override.
            Picking a member does not change it. */}
        <SelectListbox
          id="start-series"
          key={children.length}
          label="Series"
          onChange={(v) => {
            setSeriesValue(v)
            void paintMember(v, children, item.start, item.nextEp)
          }}
          options={
            children.length
              ? children.map((c, i) => ({
                  // A series says how far through it you are; a single item just
                  // gets a word when seen.
                  label: `${i + 1}. ${c.title}${
                    c.type === "show"
                      ? c.leafCount
                        ? `  (${c.viewedLeafCount || 0}/${c.leafCount} watched)`
                        : ""
                      : c.watched
                        ? "  — watched"
                        : ""
                  }`,
                  value: String(c.ratingKey),
                }))
              : [{ label: "Loading members…", value: "" }]
          }
          value={seriesValue}
        />
      </label>

      <label className="field" hidden={!isSeasonShown} id="start-seasonbox">
        Season
        {/* Season: `loadEpisodes` writes the season list and `seasonValue`
            together, and it runs on open AND whenever a different member is picked
            above. The season numbers themselves are the key — they change exactly
            when that happens, and never when the user picks a season. */}
        <SelectListbox
          id="start-season"
          key={(episodeData?.seasons ?? []).map((s) => s.season).join(",")}
          label="Season"
          onChange={(v) => {
            setSeasonValue(v)

            const row = episodeData?.seasons.find((x) => String(x.season) === v)

            setEpisodeValue(
              row?.episodes[0] ? String(row.episodes[0].episode) : "",
            )
          }}
          options={(episodeData?.seasons ?? []).map((s) => ({
            label: `Season ${s.season}`,
            value: String(s.season),
          }))}
          value={seasonValue}
        />
      </label>

      <label className="field" hidden={!isEpisodeShown} id="start-episodebox">
        Episode
        {/* Episode: two writers other than the user, and both move the SEASON —
            `loadEpisodes` on open, and the season picker's own `onChange`, which
            resets this to that season's first episode. So the key is the season
            being shown plus whether its episodes have landed yet. Picking an
            episode changes neither. */}
        <SelectListbox
          id="start-episode"
          key={`${seasonRow?.season ?? ""}:${isLoadingEpisodes ? "loading" : "ready"}`}
          label="Episode"
          onChange={setEpisodeValue}
          options={
            isLoadingEpisodes || !seasonRow
              ? [{ label: "Loading episodes…", value: "" }]
              : seasonRow.episodes.map((e) => ({
                  label: `E${e.episode}${e.title ? ` · ${e.title}` : ""}${e.watched ? "  — watched" : ""}`,
                  value: String(e.episode),
                }))
          }
          value={episodeValue}
        />
      </label>

      <p className="idnote" id="start-note">
        {note}
      </p>
    </Modal>
  )
}

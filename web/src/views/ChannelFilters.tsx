import { useEffect, useMemo, useState } from "react"

import { CheckboxGroup } from "../components/CheckboxGroup"
import { SearchDropdown } from "../components/SearchDropdown"
import { api, thumbUrl } from "../lib/api"
import {
  activeBinding,
  cachedRatings,
  fetchRatings,
  libSelection,
} from "../lib/channels"
import type { RegistrySet, SearchHit } from "../lib/types"
import { fetchAll, setState, setStatus, useStore } from "../state/store"
import { patchActiveBinding } from "./ChannelPool"

/**
 * The channel filter panel. Libraries + audio are CHANNEL-level; the ratings and
 * the rewatch excludes live on the ACTIVE BINDING (per channel × profile), so
 * switching the Profile picker switches which values you are editing.
 *
 * The blocklist and the rewatch excludes are behavior-specific — `.showsonly` and
 * `.moviesonly` are toggled by a body class rather than by unmounting, because the
 * e2e suites read their computed `display`.
 *
 * A currently-checked rating always renders even if Plex stops listing it (the
 * options are a union): a Save must never silently drop a value just because the
 * facet list shrank.
 */
export function ChannelFilters({
  channel,
  currentProfile,
  isMovies,
  onChanged,
}: {
  channel: RegistrySet
  currentProfile: string | null
  isMovies: boolean
  onChanged: () => void
}) {
  const { reg } = useStore()
  const binding = activeBinding(channel, currentProfile)

  const stored = useMemo(
    () => (isMovies ? binding.movie_ratings : binding.allowed_ratings) || [],
    [binding, isMovies],
  )

  const profileKey = channel.has_explicit_profiles
    ? `${channel.id}::${binding.plex_user || ""}`
    : channel.id

  // Render the ratings checkboxes SYNCHRONOUSLY from the cache/fallback so they
  // exist immediately, then upgrade to the per-account list from Plex when it
  // arrives — the checked set is the same either way.
  const [known, setKnown] = useState<string[]>(() => cachedRatings(profileKey))
  const [ratings, setRatings] = useState<string[]>(stored)
  const [audio, setAudio] = useState(channel.audio_language || "")
  const [showSections, setShowSections] = useState<number[]>([])
  const [itemSections, setItemSections] = useState<number[]>([])

  useEffect(() => {
    setKnown(cachedRatings(profileKey))
    setRatings(stored)
    setAudio(channel.audio_language || "")

    const checked = libSelection(channel)

    setShowSections(checked.show)
    setItemSections(checked.item)

    let isStale = false

    void fetchRatings(channel, binding).then((found) => {
      if (!isStale) setKnown(found)
    })

    return () => {
      isStale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, profileKey])

  const ratingOptions = [...new Set([...known, ...stored])].map((r) => ({
    label: r,
    value: r,
  }))

  const showLibs = (reg?.libraries ?? []).filter(
    (l) => l.video && l.type === "show",
  )
  // Both groups are Plex movie-type sections feeding the same `item_sections` —
  // split in the UI the way Plex does: real Movie libraries vs "Other Videos".
  const movieLibs = (reg?.libraries ?? []).filter(
    (l) => l.video && l.type === "movie" && !l.other,
  )
  const otherLibs = (reg?.libraries ?? []).filter(
    (l) => l.video && l.type === "movie" && l.other,
  )

  const resync = async () => {
    const [data, nextReg] = await fetchAll()

    setState({ data, reg: nextReg })
    onChanged()
  }

  const onSave = async () => {
    if (!ratings.length) {
      setStatus("Pick at least one rating", "err")

      return
    }

    if (!showSections.length && !itemSections.length) {
      setStatus("Pick at least one library", "err")

      return
    }

    setStatus("Saving filters…")

    try {
      // Libraries drive BOTH behaviors now (a rewatch channel pools from the ones
      // it names), so only the rating key differs: a rewatch channel caps films, a
      // progress one shows.
      await patchActiveBinding(
        channel,
        currentProfile,
        isMovies ? { movie_ratings: ratings } : { allowed_ratings: ratings },
        {
          audio_language: audio.trim(),
          item_sections: itemSections,
          sections: showSections,
        },
      )
      await resync()
      setStatus("Filters saved", "ok")
    }
    catch (e) {
      setStatus("Save failed: " + (e as Error).message, "err")
    }
  }

  const excludes = binding.movie_excludes || []

  return (
    <aside id="chfilters">
      <h2>Channel filters</h2>

      {/* F5: the 7 fieldsets scroll inside here; `#ch-save` stays OUTSIDE as the aside's
          pinned footer, always on screen. Every fieldset id and `.showsonly` is untouched,
          so channels-test / verify-pr4-cutover keep passing. */}
      <div className="chfilters-scroll">
      <fieldset>
        <legend>Allowed ratings</legend>
        <CheckboxGroup
          checked={ratings}
          id="ch-ratings"
          onToggle={(v, isChecked) =>
            setRatings((prev) =>
              isChecked ? [...prev, v] : prev.filter((x) => x !== v),
            )}
          options={ratingOptions}
        />
      </fieldset>

      <fieldset>
        <legend>Show libraries</legend>
        <CheckboxGroup
          checked={showSections}
          id="ch-showlibs"
          onToggle={(v, isChecked) =>
            setShowSections((prev) =>
              isChecked ? [...prev, v] : prev.filter((x) => x !== v),
            )}
          options={showLibs.map((l) => ({ label: l.title, value: l.id }))}
        />
        {/* On a rewatch channel a show library means its FILMS: entries scanned as a
            single-episode series (that is how anime movies land in Plex).
            (decision 2026-07-29-rewatch-pool-follows-the-channels-own-libraries) */}
        <p className="moviesonly hint">
          Films only — one-episode entries (anime movies).
        </p>
      </fieldset>

      <fieldset>
        <legend>Movie libraries</legend>
        <CheckboxGroup
          checked={itemSections}
          id="ch-movielibs"
          onToggle={(v, isChecked) =>
            setItemSections((prev) =>
              isChecked ? [...prev, v] : prev.filter((x) => x !== v),
            )}
          options={movieLibs.map((l) => ({ label: l.title, value: l.id }))}
        />
      </fieldset>

      <fieldset hidden={!otherLibs.length} id="ch-otherbox">
        <legend>Other videos</legend>
        <CheckboxGroup
          checked={itemSections}
          id="ch-otherlibs"
          onToggle={(v, isChecked) =>
            setItemSections((prev) =>
              isChecked ? [...prev, v] : prev.filter((x) => x !== v),
            )}
          options={otherLibs.map((l) => ({ label: l.title, value: l.id }))}
        />
      </fieldset>

      <fieldset className="showsonly">
        <legend>Blocked</legend>
        <div className="add chmadd">
          <SearchDropdown<SearchHit>
            doSearch={async (q) => {
              // Scoped to THIS channel's libraries + collections — you exclude from
              // the channel's own pool, so there is no point offering titles it
              // never draws from.
              const { results } = await api<{ results: SearchHit[] }>(
                "GET",
                `/api/search?set=${channel.id}&q=${encodeURIComponent(q)}&collections=1`,
              )

              return results
            }}
            inputId="ch-blocksearch"
            listId="ch-blockresults"
            placeholder="Exclude a show or collection…"
            rowFor={(hit, _index, close) => {
              const isCollection = hit.type === "collection"

              return {
                content: (
                  <>
                    {!isCollection || hit.hasThumb
                      ? <img alt="" src={thumbUrl(hit.ratingKey)} />
                      : <span aria-hidden="true" className="noposter" />}
                    <span>
                      {hit.title}
                      {" "}
                      {isCollection
                        ? (
                            <>
                              <span className="collbadge">Collection</span>
                              {" "}
                              <span className="y">{`${hit.childCount || 0} items`}</span>
                            </>
                          )
                        : <span className="y">{hit.year || ""}</span>}
                    </span>
                  </>
                ),
                pick: async () => {
                  close()

                  // A collection blocks by NAME (expanded at scan time, so the whole
                  // collection goes); a show/item blocks by ratingKey.
                  const value = isCollection
                    ? `Collection: ${hit.title}`
                    : String(hit.ratingKey)

                  if ((channel.blocklist || []).includes(value)) {
                    setStatus(`Already excluded — “${hit.title}”`, "ok")

                    return
                  }

                  setStatus(`Excluding ${hit.title}…`)

                  try {
                    await api("PATCH", `/api/sets/${channel.id}`, {
                      blocklist: [...(channel.blocklist || []), value],
                    })
                    await resync()
                    setStatus(`Excluded “${hit.title}”`, "ok")
                  }
                  catch (e) {
                    setStatus("Exclude failed: " + (e as Error).message, "err")
                  }
                },
              }
            }}
          />
        </div>
        <ul id="ch-block">
          {channel.blocklist.length === 0
            ? <li className="empty">Nothing blocked.</li>
            : channel.blocklist.map((entry) => (
                <BlocklistRow
                  channel={channel}
                  entry={entry}
                  key={entry}
                  onChanged={resync}
                />
              ))}
        </ul>
      </fieldset>

      <fieldset className="moviesonly">
        <legend>Excluded from rewatch</legend>
        <ul id="ch-movieexcludes">
          {excludes.length === 0
            ? <li className="empty">Nothing excluded.</li>
            : excludes.map((rk) => (
                <ExcludeRow
                  channel={channel}
                  currentProfile={currentProfile}
                  excludes={excludes}
                  key={rk}
                  onChanged={resync}
                  ratingKey={rk}
                />
              ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>Audio language</legend>
        <input
          id="ch-audio"
          onChange={(e) => setAudio(e.target.value)}
          placeholder="e.g. jpn, eng — blank = default"
          type="text"
          value={audio}
        />
      </fieldset>
      </div>

      <button id="ch-save" onClick={() => void onSave()} type="button">
        Save filters
      </button>
    </aside>
  )
}

/** A blocklist entry is a ratingKey (one show/item) OR "Collection: <name>" (the
 * whole collection — the pool scan expands it to every member's ratingKey). */
function BlocklistRow({
  channel,
  entry,
  onChanged,
}: {
  channel: RegistrySet
  entry: string
  onChanged: () => Promise<void>
}) {
  const collection = /^\s*collection:\s*(.+)$/i.exec(String(entry))
  const [title, setTitle] = useState(collection ? collection[1]! : `#${entry}`)

  useEffect(() => {
    if (collection) return

    let isStale = false

    api<{ title: string }>("GET", `/api/item/${entry}`)
      .then((md) => {
        if (!isStale) setTitle(md.title)
      })
      .catch(() => {})

    return () => {
      isStale = true
    }
  }, [collection, entry])

  return (
    <li>
      <span>
        {title}
        {collection
          ? (
              <>
                {" "}
                <span className="collbadge">Collection</span>
              </>
            )
          : null}
      </span>
      <button
        onClick={async () => {
          setStatus("Unblocking…")

          try {
            await api("PATCH", `/api/sets/${channel.id}`, {
              blocklist: channel.blocklist.filter((b) => b !== entry),
            })
            await onChanged()
            setStatus("Unblocked", "ok")
          }
          catch (e) {
            setStatus("Unblock failed: " + (e as Error).message, "err")
          }
        }}
        type="button"
      >
        Unblock
      </button>
    </li>
  )
}

/** The movies-channel rewatch excludes — the movie analogue of the shows blocklist,
 * per binding since PR 4. */
function ExcludeRow({
  channel,
  currentProfile,
  excludes,
  onChanged,
  ratingKey,
}: {
  channel: RegistrySet
  currentProfile: string | null
  excludes: string[]
  ratingKey: string
  onChanged: () => Promise<void>
}) {
  const [title, setTitle] = useState(`#${ratingKey}`)

  useEffect(() => {
    let isStale = false

    api<{ title: string }>("GET", `/api/item/${ratingKey}`)
      .then((md) => {
        if (!isStale) setTitle(md.title)
      })
      .catch(() => {})

    return () => {
      isStale = true
    }
  }, [ratingKey])

  return (
    <li>
      <span>{title}</span>
      <button
        onClick={async () => {
          setStatus("Un-excluding…")

          try {
            await patchActiveBinding(channel, currentProfile, {
              movie_excludes: excludes.filter((x) => x !== ratingKey),
            })
            await onChanged()
            setStatus("Un-excluded", "ok")
          }
          catch (e) {
            setStatus("Un-exclude failed: " + (e as Error).message, "err")
          }
        }}
        type="button"
      >
        Un-exclude
      </button>
    </li>
  )
}

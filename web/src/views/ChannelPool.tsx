import { Badge } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import { WatchesBadge } from "../components/badges"
import { PosterTile } from "../components/PosterTile"
import { api } from "../lib/api"
import { activeBinding } from "../lib/channels"
import type { PreviewResponse, RegistrySet } from "../lib/types"
import { fetchAll, setState, setStatus } from "../state/store"

/**
 * The channel's ELIGIBLE POOL — a sample of what could play. The real rotation
 * shuffles fresh every scan, so this is a preview, not a lineup.
 *
 * Two tile shapes:
 *
 * - A **show** bucket is ONE tile, summarised by its next unwatched episode.
 * - A **library** bucket is a pile of standalone items, and shorts are little
 *   movies rather than episodes — so each gets its own tile with its own poster and
 *   its own Exclude. "462 unwatched" on a single tile never said what would
 *   actually play. `items` is absent on a pre-2026-07-29 service, which falls back
 *   to the single collapsed tile.
 *   (decision `2026-07-29-shorts-preview-lists-each-short`)
 *
 * A `behavior: rewatch` channel shows its weighted rewatch pool instead:
 * least-watched first, which is the order the 1/n² pick favours.
 */

function ExcludeButton({
  label,
  onExclude,
  title,
}: {
  label: string
  title: string
  onExclude: () => Promise<void>
}) {
  return (
    <button
      className="exclude"
      onClick={() => void onExclude()}
      title={title}
      type="button"
    >
      {label}
    </button>
  )
}

export function ChannelPool({
  channel,
  currentProfile,
  onChanged,
  resampleToken,
}: {
  channel: RegistrySet
  currentProfile: string | null
  /** Bumped by the Resample button to force a `fresh=1` reload. */
  resampleToken: number
  /** Re-read the registry after a blocklist / exclude write. */
  onChanged: () => void
}) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [heading, setHeading] = useState("Eligible pool")
  const reqRef = useRef(0)

  const isRewatch = channel.behavior === "rewatch"

  useEffect(() => {
    const req = ++reqRef.current
    const chId = channel.id

    setPreview(null)
    setHeading("Eligible pool — loading… (first load can take a minute)")

    const run = async () => {
      try {
        const qs = new URLSearchParams()

        if (resampleToken > 0) qs.set("fresh", "1")

        // A `profiles[]` channel's pool is per-binding — thread the selected
        // profile through so the Python side previews that binding (legacy sets
        // omit it → default binding).
        const profile = channel.has_explicit_profiles
          ? activeBinding(channel, currentProfile).plex_user || ""
          : ""

        if (profile) qs.set("profile", profile)

        const q = qs.toString()
        const data = await api<PreviewResponse>(
          "GET",
          `/api/generic/${chId}/preview${q ? `?${q}` : ""}`,
        )

        // Stale-response guard: two same-target loads in flight would both render.
        if (req !== reqRef.current) return
        if (data.error) throw new Error(data.error)

        setPreview(data)

        if (isRewatch) {
          const movies = data.movie_pool || []

          setHeading(
            movies.length
              ? `Eligible rewatch pool — ${movies.length} movies (least-watched first)`
              : "Eligible rewatch pool — empty (this tier has no watched movies in its ratings)",
          )

          return
        }

        const buckets = data.buckets || []
        const shows = buckets.filter(
          (b) => !String(b.ratingKey).startsWith("section-"),
        )
        const itemBuckets = buckets.filter((b) =>
          String(b.ratingKey).startsWith("section-"),
        )
        const itemCount = itemBuckets.reduce((n, b) => n + b.unwatched, 0)

        setHeading(
          `Eligible pool — ${shows.length} shows` +
            (itemBuckets.length ? ` + ${itemCount} shorts` : ""),
        )
      }
      catch (e) {
        if (req !== reqRef.current) return // a newer load owns the pool now

        setHeading("Eligible pool")
        setStatus("Preview failed: " + (e as Error).message, "err")
      }
    }

    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, currentProfile, resampleToken])

  const excludeFromBlocklist = async (ratingKey: string, label: string) => {
    setStatus(`Blocking ${label}…`)

    try {
      await api("PATCH", `/api/sets/${channel.id}`, {
        blocklist: [...channel.blocklist, String(ratingKey)],
      })

      const [data, reg] = await fetchAll()

      setState({ data, reg })
      setStatus(`${label} excluded`, "ok")
      onChanged()
    }
    catch (e) {
      setStatus("Exclude failed: " + (e as Error).message, "err")
    }
  }

  const excludeFromRewatch = async (ratingKey: string, label: string) => {
    const current = activeBinding(channel, currentProfile).movie_excludes || []

    setStatus(`Excluding ${label}…`)

    try {
      await patchActiveBinding(channel, currentProfile, {
        movie_excludes: [...current, String(ratingKey)],
      })

      const [data, reg] = await fetchAll()

      setState({ data, reg })
      setStatus(`${label} excluded`, "ok")
      onChanged()
    }
    catch (e) {
      setStatus("Exclude failed: " + (e as Error).message, "err")
    }
  }

  return (
    <section className="chpool">
      <h2 id="chpool-title">{heading}</h2>
      <ul className="grid" id="chpool">
        {isRewatch
          ? renderRewatchPool()
          : (preview?.buckets ?? []).flatMap((b) =>
              b.items
                ? b.items.map((it) => (
                    <PosterTile
                      badges={
                        <ExcludeButton
                          label="Exclude"
                          onExclude={() =>
                            excludeFromBlocklist(it.ratingKey, it.title)}
                          title={`Exclude ${it.title} from this channel`}
                        />
                      }
                      dataKey={String(it.ratingKey)}
                      key={`${b.ratingKey}:${it.ratingKey}`}
                      posterRatingKey={it.ratingKey}
                      title={it.title}
                    />
                  ))
                : [
                    <PosterTile
                      badges={
                        <>
                          <Badge
                            appearance="outline"
                            className="badge show"
                            intent="accent"
                            size="sm"
                          >
                            {`${b.unwatched} unwatched`}
                          </Badge>
                          {String(b.ratingKey).startsWith("section-")
                            ? null
                            : (
                                <ExcludeButton
                                  label="Exclude"
                                  onExclude={() =>
                                    excludeFromBlocklist(b.ratingKey, b.show)}
                                  title={`Exclude ${b.show} from this channel`}
                                />
                              )}
                        </>
                      }
                      dataKey={String(b.ratingKey)}
                      key={b.ratingKey}
                      next={
                        b.next && !String(b.ratingKey).startsWith("section-")
                          ? {
                              // `multiSeason` comes from the Python preview;
                              // single-season shows (all anime) drop the "S1",
                              // matching the queue-grid tiles.
                              text: `${
                                b.next.multiSeason
                                  ? `S${b.next.season ?? "?"} · E${b.next.episode ?? "?"}`
                                  : `E${b.next.episode ?? "?"}`
                              } · ${b.next.title}`,
                            }
                          : undefined
                      }
                      posterRatingKey={
                        String(b.ratingKey).startsWith("section-")
                          ? (b.next?.ratingKey ?? null)
                          : b.ratingKey
                      }
                      title={b.show}
                    />,
                  ],
            )}
      </ul>
    </section>
  )

  function renderRewatchPool() {
    if (!preview) return null

    const movies = preview.movie_pool || []
    const sample = preview.movie

    return [
      sample
        ? (
            <PosterTile
              badges={(
                <Badge
                  appearance="outline"
                  className="badge movie"
                  intent="info"
                  size="sm"
                >
                  Next-pick sample
                </Badge>
              )}
              dataKey={String(sample.ratingKey)}
              key={`sample:${sample.ratingKey}`}
              posterRatingKey={sample.ratingKey}
              title={sample.title}
            />
          )
        : null,
      ...movies
        .filter((m) => !sample || m.ratingKey !== sample.ratingKey)
        .map((m) => (
          <PosterTile
            badges={
              <>
                <WatchesBadge count={m.count} />
                <ExcludeButton
                  label="Exclude"
                  onExclude={() => excludeFromRewatch(m.ratingKey, m.title)}
                  title="Exclude from the rewatch pool"
                />
              </>
            }
            dataKey={String(m.ratingKey)}
            key={m.ratingKey}
            posterRatingKey={m.ratingKey}
            title={m.title}
          />
        )),
    ]
  }
}

/**
 * Write per-binding changes: a whole-array `profiles[]` replace on a function
 * channel (only the active binding changes), a plain top-level PATCH on a legacy
 * set — writing the top level on a `profiles[]` channel would be silently ignored
 * by the Python reader.
 */
export function patchActiveBinding(
  ch: RegistrySet,
  currentProfile: string | null,
  changes: Record<string, unknown>,
  channelChanges: Record<string, unknown> = {},
) {
  if (!ch.has_explicit_profiles) {
    return api("PATCH", `/api/sets/${ch.id}`, { ...changes, ...channelChanges })
  }

  const active = activeBinding(ch, currentProfile)
  const profiles = (ch.profiles || []).map((p) =>
    p === active ? { ...p, ...changes } : p,
  )

  return api("PATCH", `/api/sets/${ch.id}`, { profiles, ...channelChanges })
}

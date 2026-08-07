import { Badge, Skeleton, Spinner } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import { WatchesBadge } from "../components/badges"
import { PosterTile } from "../components/PosterTile"
import { Tip } from "../components/Tip"
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
    <Tip label={title}>
      <button
        className="exclude"
        onClick={() => void onExclude()}
        type="button"
      >
        {label}
      </button>
    </Tip>
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
  // The load state drives the indicator. `#chpool-title` text stays STABLE at "Eligible
  // pool" while loading — `live-smoke.mjs` and `verify-shorts-pool.mjs` read its
  // textContent and match on the LOADED counts, and a heading that changes mid-load is
  // both a CLS source and a screen-reader nuisance. The load is announced by the
  // Spinner's `role="status"` region and the grid's `aria-busy`, not by the heading.
  const [isLoading, setIsLoading] = useState(true)
  // "first load can take a minute" moves OUT of the heading into a hint that appears only
  // after 3 s — so a fast load never shows it, and a slow one explains itself.
  const [showSlowHint, setShowSlowHint] = useState(false)
  const reqRef = useRef(0)

  const isRewatch = channel.behavior === "rewatch"

  useEffect(() => {
    const req = ++reqRef.current
    const chId = channel.id

    setPreview(null)
    setIsLoading(true)
    setShowSlowHint(false)
    setHeading("Eligible pool")
    const slowTimer = setTimeout(() => {
      if (req === reqRef.current) setShowSlowHint(true)
    }, 3000)

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
        setIsLoading(false)

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
        setIsLoading(false)
        setStatus("Preview failed: " + (e as Error).message, "err")
      }
    }

    void run()

    return () => clearTimeout(slowTimer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, currentProfile, resampleToken])

  // The skeleton count: enough to fill the visible pool row so nothing shifts when the real
  // tiles land. A fixed dozen at tile geometry (`--tile` wide, aspect-ratio 2/3 via `.tile`).
  const SKELETON_COUNT = 12

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
      <div className="chpool-head">
        <h2 id="chpool-title">{heading}</h2>
        {/* The load's ACTUAL announcement — a `role="status"` live region. The heading
            stays stable, so this is what a screen reader hears. */}
        {isLoading ? <Spinner label="Loading the eligible pool…" size="sm" /> : null}
      </div>
      {/* Out of the heading (a heading that changes is a CLS + a11y nuisance), and only
          after 3 s, so a fast load never shows it. */}
      {isLoading && showSlowHint
        ? <p className="chpool-hint">First load can take a minute.</p>
        : null}
      {/* `aria-busy` pairs with the `aria-hidden` Skeletons: the container announces the
          load, the placeholders stay invisible to AT (Skeleton's own contract). */}
      <ul aria-busy={isLoading || undefined} className="grid" id="chpool">
        {isLoading
          ? Array.from({ length: SKELETON_COUNT }, (_, i) => (
              // NOT `li.tile`: the e2e suites `waitForSelector('#chpool li.tile')` to detect a
              // LOADED pool, so a skeleton wearing that class would resolve the wait early on
              // empty placeholders. `.skeltile` carries the same geometry, different name.
              <li className="skeltile" key={`skeleton-${i}`}>
                <div className="thumb">
                  <Skeleton blockSize="100%" inlineSize="100%" shape="block" />
                </div>
              </li>
            ))
          : isRewatch
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

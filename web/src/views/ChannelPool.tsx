import { Badge, Skeleton, Spinner } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import { WatchesBadge } from "../components/badges"
import { CountPicker } from "../components/CountPicker"
import { WEIGHT_MAX } from "../components/EntrySettings"
import { PosterTile } from "../components/PosterTile"
import { Tip } from "../components/Tip"
import { api } from "../lib/api"
import { activeBinding } from "../lib/channels"
import {
  isSelfTitled,
  seLabel,
  startLabel,
} from "../lib/tileFace"
import type {
  ChannelMember,
  PreviewBucket,
  PreviewResponse,
  RegistrySet,
  StartPoint,
} from "../lib/types"
import {
  type EntryActions,
  openStartModal,
} from "../state/overlays"
import {
  fetchAll,
  setState,
  setStatus,
} from "../state/store"

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
  reloadToken,
  resampleToken,
}: {
  channel: RegistrySet
  currentProfile: string | null
  /** Bumped by the Resample button to force a `fresh=1` reload. */
  resampleToken: number
  /**
   * Bumped after a blocklist / exclude write to re-read the preview WITHOUT a
   * `fresh=1` reshuffle — the excluded show is already gone server-side (the
   * `PATCH /api/sets/:id` busted the preview cache), so the pool just needs a
   * cheap re-read, not a full rescan that would scramble every other tile.
   */
  reloadToken: number
  /** Notify the parent to bump `reloadToken` after a blocklist / exclude write. */
  onChanged: () => void
}) {
  const [preview, setPreview] =
    useState<PreviewResponse | null>(null)
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
  // `fresh=1` is a full reshuffle/rescan and must fire ONLY when the Resample
  // button actually bumped `resampleToken` — not on a `reloadToken` re-read, a
  // channel switch, or the initial load. Comparing against the previous value is
  // robust to those; the old `resampleToken > 0` test wrongly forced fresh on
  // every load once you'd resampled once.
  const prevResampleRef = useRef(resampleToken)

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

        const isResample =
          resampleToken !== prevResampleRef.current

        prevResampleRef.current = resampleToken

        if (isResample) qs.set("fresh", "1")

        // A `profiles[]` channel's pool is per-binding — thread the selected
        // profile through so the Python side previews that binding (legacy sets
        // omit it → default binding).
        const profile = channel.has_explicit_profiles
          ? activeBinding(channel, currentProfile)
              .plex_user || ""
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
          (b) =>
            !String(b.ratingKey).startsWith("section-"),
        )
        const itemBuckets = buckets.filter((b) =>
          String(b.ratingKey).startsWith("section-"),
        )
        const itemCount = itemBuckets.reduce(
          (n, b) => n + b.unwatched,
          0,
        )

        setHeading(
          `Eligible pool — ${shows.length} shows` +
            (itemBuckets.length
              ? ` + ${itemCount} shorts`
              : ""),
        )
      } catch (e) {
        if (req !== reqRef.current) return // a newer load owns the pool now

        setHeading("Eligible pool")
        setIsLoading(false)
        setStatus(
          `Preview failed: ${(e as Error).message}`,
          "err",
        )
      }
    }

    void run()

    return () => clearTimeout(slowTimer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    channel.id,
    currentProfile,
    resampleToken,
    reloadToken,
  ])

  // The skeleton count: enough to fill the visible pool row so nothing shifts when the real
  // tiles land. A fixed dozen at tile geometry (`--tile` wide, aspect-ratio 2/3 via `.tile`).
  const SKELETON_COUNT = 12

  const excludeFromBlocklist = async (
    ratingKey: string,
    label: string,
  ) => {
    setStatus(`Blocking ${label}…`)

    try {
      await api("PATCH", `/api/sets/${channel.id}`, {
        blocklist: [
          ...channel.blocklist,
          String(ratingKey),
        ],
      })

      const [data, reg] = await fetchAll()

      setState({ data, reg })
      setStatus(`${label} excluded`, "ok")
      onChanged()
    } catch (e) {
      setStatus(
        `Exclude failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  const excludeFromRewatch = async (
    ratingKey: string,
    label: string,
  ) => {
    const current =
      activeBinding(channel, currentProfile)
        .movie_excludes || []

    setStatus(`Excluding ${label}…`)

    try {
      await patchActiveBinding(channel, currentProfile, {
        movie_excludes: [...current, String(ratingKey)],
      })

      const [data, reg] = await fetchAll()

      setState({ data, reg })
      setStatus(`${label} excluded`, "ok")
      onChanged()
    } catch (e) {
      setStatus(
        `Exclude failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  // Persist (or clear) a manual start floor for one rule-pool show. Same whole-map
  // replace + registry refresh as the blocklist write above; `PATCH /api/sets/:id` busts
  // the server preview cache, so the following onChanged() re-read shows the new "next".
  const saveStart = async (
    ratingKey: string,
    start: StartPoint | null,
  ) => {
    const next: Record<string, StartPoint> = {
      ...(channel.starts ?? {}),
    }

    if (start) next[String(ratingKey)] = start
    else delete next[String(ratingKey)]

    await api("PATCH", `/api/sets/${channel.id}`, {
      starts: next,
    })

    const [data, reg] = await fetchAll()

    setState({ data, reg })
  }

  // A rule-pool show's WEIGHT lives in the channel's `weights` map, keyed by ratingKey — the
  // exact mirror of `starts` above, because a rule-derived show has no stored entry of its own
  // to carry the field. Same whole-map replace + registry refresh.
  const saveWeight = async (
    ratingKey: string,
    weight: number,
  ) => {
    const next: Record<string, number> = {
      ...(channel.weights ?? {}),
    }

    if (weight > 1) next[String(ratingKey)] = weight
    else delete next[String(ratingKey)]

    setStatus("Saving…")
    await api("PATCH", `/api/sets/${channel.id}`, {
      weights: next,
    })

    const [data, reg] = await fetchAll()

    setState({ data, reg })
    setStatus("Saved", "ok")
    onChanged()
  }

  // A rule-pool show reuses the queue/member "Start from…" flow: build the same
  // EntryActions the modal reads, with an item shaped like a resolved show. The pool is
  // rule-derived (no stored entry), so `save` writes the set's `starts` map keyed by
  // ratingKey rather than an array slot, and `index` is unused here (-1).
  const poolEntry = (b: PreviewBucket): EntryActions => {
    const start =
      channel.starts?.[String(b.ratingKey)] ?? null
    const item: ChannelMember = {
      childCount: null,
      index: -1,
      nextEp: b.next
        ? {
            episode: b.next.episode,
            multiSeason: b.next.multiSeason,
            season: b.next.season,
            title: b.next.title,
          }
        : null,
      ratingKey: String(b.ratingKey),
      resolved: true,
      start,
      title: b.show,
      type: "show",
      year: null,
    }

    return {
      // The active binding's Plex Home uuid scopes the picker's "watched" marks to THIS
      // channel's profile (e.g. Older Kids), matching the engine's per-account pool — the
      // editor otherwise reads the admin account's history.
      accountUuid: activeBinding(channel, currentProfile)
        .user_uuid,
      item,
      refresh: () => onChanged(),
      save: (s) => saveStart(b.ratingKey, s),
      setId: channel.id,
    }
  }

  // One eligible-pool SHOW tile: the unwatched badge + Exclude, PLUS the shared start
  // affordances (a clickable "next" line and, once set, a "Start …" chip). A Shorts
  // ("section-") bucket is not a series, so it carries neither. (The `items` split — one
  // tile per short — is handled by the caller before this runs.)
  const renderShowBucket = (b: PreviewBucket) => {
    const isSection = String(b.ratingKey).startsWith(
      "section-",
    )
    const entry = isSection ? null : poolEntry(b)
    const start = entry?.item.start ?? null

    return (
      <PosterTile
        badges={
          <>
            <Badge
              appearance="outline"
              className="badge show"
              intent="neutral"
              size="sm"
            >
              {`${b.unwatched} unwatched`}
            </Badge>
            {/* Weight applies to a Shorts bucket too — "sprinkle twice as many shorts" is
                the same question as "play this show twice as often", and the bucket is
                keyed `section-<id>` in the map exactly as the engine keys it. */}
            <Tip label="How often this comes up — a 3x show takes about three slots for every one a normal show takes in the rotation.">
              <span className="eps">
                <CountPicker
                  label={`Weight for ${b.show}`}
                  max={WEIGHT_MAX}
                  onChange={(n) =>
                    void saveWeight(String(b.ratingKey), n)
                  }
                  unit="x"
                  value={
                    channel.weights?.[
                      String(b.ratingKey)
                    ] ??
                    b.weight ??
                    1
                  }
                />
              </span>
            </Tip>
            {isSection ? null : (
              <ExcludeButton
                label="Exclude"
                onExclude={() =>
                  excludeFromBlocklist(b.ratingKey, b.show)
                }
                title={`Exclude ${b.show} from this pool`}
              />
            )}
            {start && entry ? (
              <Tip label="Manual start point. Click to change it or go back to automatic.">
                <button
                  className="badge startbadge"
                  onClick={() => openStartModal(entry)}
                  type="button"
                >
                  {startLabel(start)}
                </button>
              </Tip>
            ) : null}
          </>
        }
        dataKey={String(b.ratingKey)}
        key={b.ratingKey}
        next={
          b.next && !isSection
            ? {
                // Clicking opens the same picker the queue tiles use; the label matches
                // the queue-grid tiles (single-season anime drops the "S1").
                onStart: entry
                  ? () => openStartModal(entry)
                  : undefined,
                // The SAME label the queue/member tiles wear, from the same helper —
                // including "Ch 113" on a reading pool, where the number is a chapter.
                text: [
                  seLabel(b.next, b.unit),
                  isSelfTitled(b.next)
                    ? null
                    : b.next.title,
                ]
                  .filter(Boolean)
                  .join(" · "),
                tooltip:
                  "Tap to choose where this show starts",
              }
            : undefined
        }
        // A reading pool's artwork is its provider's, re-served by the app (see `Poster`);
        // a section bucket borrows the next-up leaf's Plex poster, which has no cover URL.
        posterCover={isSection ? null : b.cover}
        posterRatingKey={
          isSection
            ? (b.next?.ratingKey ?? null)
            : b.ratingKey
        }
        title={b.show}
      />
    )
  }

  return (
    <section className="chpool">
      <div className="chpool-head">
        <h2 id="chpool-title">{heading}</h2>
        {/* The load's ACTUAL announcement — a `role="status"` live region. The heading
            stays stable, so this is what a screen reader hears. */}
        {isLoading ? (
          <Spinner
            label="Loading the eligible pool…"
            size="sm"
          />
        ) : null}
      </div>
      {/* Out of the heading (a heading that changes is a CLS + a11y nuisance), and only
          after 3 s, so a fast load never shows it. */}
      {isLoading && showSlowHint ? (
        <p className="chpool-hint">
          First load can take a minute.
        </p>
      ) : null}
      {/* `aria-busy` pairs with the `aria-hidden` Skeletons: the container announces the
          load, the placeholders stay invisible to AT (Skeleton's own contract). */}
      <ul
        aria-busy={isLoading || undefined}
        className="grid"
        id="chpool"
      >
        {isLoading
          ? Array.from(
              { length: SKELETON_COUNT },
              (_, i) => (
                // NOT `li.tile`: the e2e suites `waitForSelector('#chpool li.tile')` to detect a
                // LOADED pool, so a skeleton wearing that class would resolve the wait early on
                // empty placeholders. `.skeltile` carries the same geometry, different name.
                <li
                  className="skeltile"
                  // A fixed-length run of identical placeholders: no identity to key
                  // on, and all of them are replaced at once when the real tiles arrive.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  key={`skeleton-${i}`}
                >
                  <div className="thumb">
                    <Skeleton
                      blockSize="100%"
                      inlineSize="100%"
                      shape="block"
                    />
                  </div>
                </li>
              ),
            )
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
                              excludeFromBlocklist(
                                it.ratingKey,
                                it.title,
                              )
                            }
                            title={`Exclude ${it.title} from this pool`}
                          />
                        }
                        dataKey={String(it.ratingKey)}
                        key={`${b.ratingKey}:${it.ratingKey}`}
                        posterRatingKey={it.ratingKey}
                        title={it.title}
                      />
                    ))
                  : [renderShowBucket(b)],
              )}
      </ul>
    </section>
  )

  function renderRewatchPool() {
    if (!preview) return null

    const movies = preview.movie_pool || []
    const sample = preview.movie

    return [
      sample ? (
        <PosterTile
          badges={
            <Badge
              appearance="outline"
              className="badge movie"
              intent="info"
              size="sm"
            >
              Next-pick sample
            </Badge>
          }
          dataKey={String(sample.ratingKey)}
          key={`sample:${sample.ratingKey}`}
          posterRatingKey={sample.ratingKey}
          title={sample.title}
        />
      ) : null,
      ...movies
        .filter(
          (m) =>
            !sample || m.ratingKey !== sample.ratingKey,
        )
        .map((m) => (
          <PosterTile
            badges={
              <>
                <WatchesBadge count={m.count} />
                <ExcludeButton
                  label="Exclude"
                  onExclude={() =>
                    excludeFromRewatch(m.ratingKey, m.title)
                  }
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
    return api("PATCH", `/api/sets/${ch.id}`, {
      ...changes,
      ...channelChanges,
    })
  }

  const active = activeBinding(ch, currentProfile)
  const profiles = (ch.profiles || []).map((p) =>
    p === active ? { ...p, ...changes } : p,
  )

  return api("PATCH", `/api/sets/${ch.id}`, {
    profiles,
    ...channelChanges,
  })
}

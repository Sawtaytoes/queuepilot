import { type ReactNode, useState } from "react"
import { Link } from "react-router"
import {
  isPullSet,
  OpenQueueButton,
} from "../components/OpenQueueButton"

import { SelectListbox } from "../components/SelectListbox"
import type { RegistrySet } from "../lib/types"
import { openPlayMenu } from "../state/overlays"
import {
  channelSetIds,
  queueIds,
  rotationChannels,
  useStore,
} from "../state/store"

/**
 * PLAY — the landing. Every channel and queue as a plain, posterless row: pick one
 * and play it. The configurators (posters, drag, filters) live behind the three
 * "Configure ›" links.
 * (decision `2026-07-21-queues-vs-channels-taxonomy-play-first-ia`)
 *
 * The dynamic group is DATA-DRIVEN, one row per rotation channel — Shows & Shorts,
 * Shows, Shorts, Movies, and any future rotation. It used to hardcode two function
 * buckets and fold every `progress` channel into the first, which listed
 * "Younger Kids / Older Kids" three times each once the kid channels were split.
 * Each row's tier picker lists only THAT channel's own bindings, so a tier can
 * never appear twice. (decision `2026-07-29-dynamic-channels-first-class-and-deletable`)
 */

/** A tier-select value → `{set, profile?}` (JSON for a binding option, a bare id
 * otherwise). */
function parseTierValue(v: string): {
  set: string
  profile?: string
} {
  if (v?.startsWith("{")) {
    try {
      return JSON.parse(v)
    } catch {
      /* fall through */
    }
  }

  return { set: v }
}

function PlayRow({
  label,
  meta,
  onPlay,
  set,
  tier,
  to,
}: {
  /**
   * Where this row GOES — a real link target, not an `onClick` that calls `navigate()`.
   * Middle-click, ⌘/Ctrl-click, "Open in new tab", "Copy link address" and the status-bar
   * preview all come from the ELEMENT being an anchor; none of them can be added to a
   * `<button>` by styling it like a link.
   * (decision `2026-08-15-navigation-is-an-anchor-not-a-button`)
   *
   * It is a react-router `<Link>` rather than a bare `<a>` as of 2026-08-16. Under the
   * hash router a plain `<a href="#/q/1">` needed no handler — setting the hash WAS the
   * navigation. A path `<a href="/q/1">` is not the same thing: the browser would leave
   * the page and refetch the whole app. `<Link>` still RENDERS an `<a href>`, so every
   * affordance above survives; it just intercepts the plain left-click.
   */
  to: string
  label: string
  meta: string
  onPlay: (anchor: DOMRect) => void
  /** The registry entry, for `delivery` + the accent. Absent = push (pre-provider callers). */
  set?: Pick<
    RegistrySet,
    "id" | "delivery" | "provider_kind"
  >
  tier?: ReactNode
}) {
  return (
    // Each row wears its own queue's colour, so the landing page says at a glance which
    // service each button will talk to — the Kavita row's Open button is Kavita-green beside
    // the Plex rows' amber. (decision `2026-08-15-a-queue-wears-its-providers-colour`)
    <li
      className="playrow"
      data-provider={set?.provider_kind || undefined}
    >
      <div className="rowmain">
        <Link className="rowname" to={to}>
          {label}
        </Link>
        <span className="rowmeta">{meta}</span>
      </div>
      {tier}
      {isPullSet(set) ? (
        // Nothing to cast to — the launcher URL is the whole affordance.
        <OpenQueueButton set={set!} />
      ) : (
        <button
          className="playbtn"
          onClick={(e) =>
            onPlay(e.currentTarget.getBoundingClientRect())
          }
          type="button"
        >
          ▶ Play on ▾
        </button>
      )}
    </li>
  )
}

/** One channel's tier picker: an option per BINDING (value carries set + profile),
 * or the bare id for a legacy single-binding set. */
function ChannelRow({ channel }: { channel: RegistrySet }) {
  const isRewatch = channel.behavior === "rewatch"
  const options = channel.has_explicit_profiles
    ? (channel.profiles || []).map((b) => ({
        label: b.plex_user || channel.label,
        value: JSON.stringify({
          profile: b.plex_user,
          set: channel.id,
        }),
      }))
    : [{ label: channel.label, value: channel.id }]

  // Seed to the channel's saved default profile when it names a real binding, so Play
  // reaches for the right tier without the user re-picking; else the first binding.
  // (decision `2026-08-07-default-profile-per-channel`)
  const defaultValue =
    channel.has_explicit_profiles && channel.default_profile
      ? (channel.profiles || [])
          .filter(
            (b) => b.plex_user === channel.default_profile,
          )
          .map((b) =>
            JSON.stringify({
              profile: b.plex_user,
              set: channel.id,
            }),
          )[0]
      : undefined

  const [tierValue, setTierValue] = useState(
    defaultValue ?? options[0]?.value ?? channel.id,
  )

  return (
    <PlayRow
      label={channel.label}
      set={channel}
      meta={
        isRewatch
          ? "weighted rewatch"
          : "rotation · ratings-filtered"
      }
      to={`/channels/${encodeURIComponent(channel.id)}`}
      onPlay={(anchor) => {
        const t = parseTierValue(tierValue)

        openPlayMenu({
          anchor,
          kind: isRewatch ? "movie" : undefined,
          profile: t.profile,
          setId: t.set,
        })
      }}
      tier={
        <SelectListbox
          className="rowtier"
          label={`Profile for ${channel.label}`}
          onChange={setTierValue}
          options={options}
          size="sm"
          value={tierValue}
        />
      }
    />
  )
}

export function PlayView({
  isHidden,
}: {
  isHidden: boolean
}) {
  const { data, reg } = useStore()

  return (
    <main className="view" hidden={isHidden} id="play">
      <section className="playgroup">
        <h2>
          Filtered Pools
          <Link
            className="ghost"
            id="gochannels"
            to="/channels"
          >
            Configure ›
          </Link>
        </h2>
        <ul className="playlist" id="playdynamic">
          {isHidden
            ? null
            : rotationChannels(reg).map((s) => (
                <ChannelRow channel={s} key={s.id} />
              ))}
        </ul>
      </section>

      <section className="playgroup">
        <h2>
          Curated Pools
          <Link
            className="ghost"
            id="gocurated"
            to="/channels"
          >
            Configure ›
          </Link>
        </h2>
        <ul className="playlist" id="playcurated">
          {isHidden
            ? null
            : channelSetIds(data).map((id) => {
                const s = data!.sets[id]!

                return (
                  <PlayRow
                    key={id}
                    label={s.label}
                    set={reg?.sets.find((x) => x.id === id)}
                    meta={`${s.items.length} shows · rotation`}
                    to={`/q/${id}`}
                    onPlay={(anchor) =>
                      openPlayMenu({ anchor, setId: id })
                    }
                  />
                )
              })}
        </ul>
      </section>

      <section className="playgroup">
        <h2>
          Ordered Queues
          <Link
            className="ghost"
            id="goqueues"
            to="/queues"
          >
            Configure ›
          </Link>
        </h2>
        <ul className="playlist" id="playqueues">
          {isHidden
            ? null
            : queueIds(data).map((id) => {
                const s = data!.sets[id]!

                return (
                  <PlayRow
                    key={id}
                    label={s.label}
                    // The registry entry, same as the Curated rows above. Without it a
                    // Plex QUEUE renders in the neutral accent while a Plex CHANNEL two
                    // columns over renders amber — one page, two colours, same provider.
                    set={reg?.sets.find((x) => x.id === id)}
                    meta={`${s.items.length} titles · top plays next`}
                    to={`/q/${id}`}
                    onPlay={(anchor) =>
                      openPlayMenu({ anchor, setId: id })
                    }
                  />
                )
              })}
        </ul>
      </section>
    </main>
  )
}

import { Select } from "@charcuterie/ui"
import { type ReactNode, useState } from "react"

import type { RegistrySet } from "../lib/types"
import { openPlayMenu } from "../state/overlays"
import { navigate } from "../state/route"
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
function parseTierValue(v: string): { set: string; profile?: string } {
  if (v && v.startsWith("{")) {
    try {
      return JSON.parse(v)
    }
    catch {
      /* fall through */
    }
  }

  return { set: v }
}

function PlayRow({
  label,
  meta,
  onOpen,
  onPlay,
  tier,
}: {
  label: string
  meta: string
  onOpen: () => void
  onPlay: (anchor: DOMRect) => void
  tier?: ReactNode
}) {
  return (
    <li className="playrow">
      <div className="rowmain">
        <button className="rowname" onClick={onOpen} type="button">
          {label}
        </button>
        <span className="rowmeta">{meta}</span>
      </div>
      {tier}
      <button
        className="playbtn"
        onClick={(e) => onPlay(e.currentTarget.getBoundingClientRect())}
        type="button"
      >
        ▶ Play on ▾
      </button>
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
        value: JSON.stringify({ profile: b.plex_user, set: channel.id }),
      }))
    : [{ label: channel.label, value: channel.id }]

  const [tierValue, setTierValue] = useState(options[0]?.value ?? channel.id)

  return (
    <PlayRow
      label={channel.label}
      meta={isRewatch ? "weighted rewatch" : "rotation · ratings-filtered"}
      onOpen={() => navigate(`#/channels/${encodeURIComponent(channel.id)}`)}
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
        /* No `key` here, and that is the deliberate half of the rule: `tierValue`
           is `useState` local to this row and nothing else ever writes it, so the
           DOM and React have one owner between them. A key would remount the
           control on the user's own pick and take their focus with it. */
        <Select
          className="rowtier"
          label={`Profile for ${channel.label}`}
          onChange={setTierValue}
          onClick={(e) => e.stopPropagation()}
          options={options}
          value={tierValue}
        />
      }
    />
  )
}

export function PlayView({ isHidden }: { isHidden: boolean }) {
  const { data, reg } = useStore()

  return (
    <main className="view" hidden={isHidden} id="play">
      <section className="playgroup">
        <h2>
          Dynamic Channels
          <button
            className="ghost"
            id="gochannels"
            onClick={() => navigate("#/channels")}
            type="button"
          >
            Configure ›
          </button>
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
          Curated Channels
          <button
            className="ghost"
            id="gocurated"
            onClick={() => navigate("#/channels")}
            type="button"
          >
            Configure ›
          </button>
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
                    meta={`${s.items.length} shows · random rotation`}
                    onOpen={() => navigate(`#/q/${id}`)}
                    onPlay={(anchor) => openPlayMenu({ anchor, setId: id })}
                  />
                )
              })}
        </ul>
      </section>

      <section className="playgroup">
        <h2>
          Queues
          <button
            className="ghost"
            id="goqueues"
            onClick={() => navigate("#/queues")}
            type="button"
          >
            Configure ›
          </button>
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
                    meta={`${s.items.length} titles · top plays next`}
                    onOpen={() => navigate(`#/q/${id}`)}
                    onPlay={(anchor) => openPlayMenu({ anchor, setId: id })}
                  />
                )
              })}
        </ul>
      </section>
    </main>
  )
}

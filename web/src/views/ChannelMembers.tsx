import { useEffect, useRef, useState } from "react"

import { TypeBadge } from "../components/badges"
import { PosterTile } from "../components/PosterTile"
import { SearchDropdown } from "../components/SearchDropdown"
import { Tip } from "../components/Tip"
import { useFlipList } from "../hooks/useFlipList"
import { api, thumbUrl } from "../lib/api"
import { activeBinding } from "../lib/channels"
import {
  byTitle,
  isStartable,
  startLabel,
  tileFace,
} from "../lib/tileFace"
import type {
  ChannelMember,
  RegistrySet,
  SearchHit,
} from "../lib/types"
import {
  type EntryActions,
  openStartModal,
  openTileMenu,
} from "../state/overlays"
import {
  getState,
  setState,
  setStatus,
} from "../state/store"

/**
 * Explicit CURATED MEMBERS of a rotation channel.
 *
 * A member is a manual **include**: the mirror image of the blocklist's exclude, and
 * it plays ON TOP of the rule pool rather than replacing it — so one channel can be
 * "the whole Shows library, PLUS these hand-picked Anime shows".
 * (decision `2026-07-31-curated-members-are-additive-includes`)
 *
 * Consequences visible here:
 *
 * - The picker searches **every** library (`scope=all`), because a manual include is
 *   not bound to the channel's pool libraries.
 * - An empty list means the channel plays purely by its rule, so the grid hides
 *   entirely and a slim one-liner takes its place rather than a poster-sized empty
 *   tile.
 * - Tiles are listed ALPHABETICALLY for lookup — random playback means the stored
 *   order is lookup-only. Display-only: each tile's `index` still points at the
 *   stored (unsorted) array, so removes stay exact.
 *
 * Both writes are OPTIMISTIC. The PATCH + members re-resolve round-trip is seconds
 * when Plex is cold, and this grid was the last place an add still froze the page.
 */

export function ChannelMembers({
  channel,
  currentProfile,
  isShown,
}: {
  channel: RegistrySet
  /** The selected tier, so member tiles' next-up "watched" state is scoped to THAT
   * profile's account (matching the pool below), not the admin's. */
  currentProfile: string | null
  /** Only a `progress` channel has a member grid. */
  isShown: boolean
}) {
  // The active binding's Plex Home uuid — threaded to the members fetch (so tile next-up is
  // per-account) and onto each entry (so the start picker's watched marks match). Null on a
  // legacy single-binding channel => admin view, unchanged.
  const accountUuid = activeBinding(
    channel,
    currentProfile,
  ).user_uuid
  const [members, setMembers] = useState<ChannelMember[]>(
    [],
  )
  const gridRef = useRef<HTMLUListElement>(null)
  const reqRef = useRef(0)
  const paintedRef = useRef<string | null>(null)

  const isSamePaint = paintedRef.current === channel.id

  useFlipList(
    gridRef,
    `${channel.id}:${members.map((m) => m.ratingKey ?? m.title).join("|")}`,
    isShown && isSamePaint,
  )

  const rawMembers = () =>
    (getState().reg?.sets.find((s) => s.id === channel.id)
      ?.members ?? []) as unknown[]

  const reload = async (chId: string) => {
    const req = ++reqRef.current

    try {
      const { members: found } = await api<{
        members: ChannelMember[]
      }>(
        "GET",
        `/api/sets/${chId}/members${
          accountUuid
            ? `?uuid=${encodeURIComponent(accountUuid)}`
            : ""
        }`,
      )

      if (req !== reqRef.current) return // switched away

      found.sort(byTitle)
      setMembers(found)
      paintedRef.current = chId
    } catch (e) {
      if (req === reqRef.current) {
        setMembers([])
        setStatus(
          `Members failed: ${(e as Error).message}`,
          "err",
        )
      }
    }
  }

  const memberCount = (channel.members || []).length

  useEffect(() => {
    if (!isShown) return

    if (!memberCount) {
      reqRef.current += 1
      setMembers([])
      paintedRef.current = channel.id

      return
    }

    void reload(channel.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, isShown, memberCount, accountUuid])

  /**
   * OPTIMISTIC write: put the new array into the local registry FIRST (so the grid
   * and the very next edit both see it) and PATCH in the background. A failure
   * re-syncs from the server and repaints, so the optimistic tile can't linger.
   */
  const saveMembersLive = async (
    chId: string,
    next: unknown[],
  ) => {
    const local = getState().reg?.sets.find(
      (x) => x.id === chId,
    )

    if (local) local.members = next

    try {
      await api("PATCH", `/api/sets/${chId}`, {
        members: next,
      })

      const reg = await api<{
        sets: RegistrySet[]
        libraries: never[]
      }>("GET", "/api/sets")

      setState({ reg: reg as never })
    } catch (e) {
      setStatus(
        `Save failed: ${(e as Error).message}`,
        "err",
      )

      try {
        const reg = await api("GET", "/api/sets")

        setState({ reg: reg as never })
      } catch {
        /* offline: leave the local view */
      }

      await reload(chId)
    }
  }

  const removeMember = (m: ChannelMember) => {
    const gone = m.index

    // Tile closures hold these objects, so removals fix up the surviving `index`
    // values IN PLACE — a stale index would edit the wrong array slot.
    setMembers((prev) => {
      const next = prev.filter((x) => x !== m)

      for (const x of next) if (x.index > gone) x.index -= 1

      return next
    })
    setStatus(`Removed “${m.title}”`, "ok")
    void saveMembersLive(
      channel.id,
      rawMembers().filter((_, i) => i !== gone),
    )
  }

  const entryFor = (m: ChannelMember): EntryActions => ({
    // Scope the start picker's watched marks to this channel's profile (matches the tile
    // next-up above), not the admin account.
    accountUuid,
    item: m,
    refresh: () => void reload(channel.id),
    remove: () => removeMember(m),
    removeLabel: "Remove this member",
    // A member's start is written by replacing the whole members array (the raw
    // entry becomes a mapping that carries it).
    save: async (start) => {
      const current = rawMembers().slice()
      const value = current[m.index]
      const base: Record<string, unknown> =
        value && typeof value === "object"
          ? { ...(value as Record<string, unknown>) }
          : /^\d+$/.test(String(value))
            ? { ratingKey: String(value) }
            : { title: String(value) }

      if (start) base.start = start
      else delete base.start

      current[m.index] = base
      await api("PATCH", `/api/sets/${channel.id}`, {
        members: current,
      })

      const reg = await api("GET", "/api/sets")

      setState({ reg: reg as never })
    },
  })

  return (
    <section
      className={`chmembers${members.length ? "" : " no-members"}`}
      hidden={!isShown}
      id="chmembers-box"
    >
      <h2 id="chmembers-title">
        {members.length
          ? `Members — curated (${members.length})`
          : "Members"}
      </h2>
      <div className="add chmadd">
        <SearchDropdown<SearchHit>
          doSearch={async (q) => {
            // scope=all: a curated member is a manual include, not bound to the
            // channel's pool libraries — so search every library (e.g. add an Anime
            // show to a Shows-only channel).
            const { results } = await api<{
              results: SearchHit[]
            }>(
              "GET",
              `/api/search?scope=all&q=${encodeURIComponent(q)}&collections=1`,
            )

            return results
          }}
          inputId="chmsearch"
          listId="chmresults"
          placeholder="Add a member — search this channel's libraries…"
          rowFor={(hit, _index, close) => {
            const isCollection = hit.type === "collection"
            const label = isCollection
              ? hit.title
              : `${hit.title}${hit.year ? ` (${hit.year})` : ""}`

            return {
              content: (
                <>
                  {!isCollection || hit.hasThumb ? (
                    <img
                      alt=""
                      src={thumbUrl(hit.ratingKey)}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="noposter"
                    />
                  )}
                  <span>
                    {hit.title}{" "}
                    {isCollection ? (
                      <>
                        <span className="collbadge">
                          Collection
                        </span>{" "}
                        <span className="y">{`${hit.childCount || 0} items`}</span>
                      </>
                    ) : (
                      <span className="y">
                        {hit.year || ""}
                      </span>
                    )}
                  </span>
                </>
              ),
              pick: () => {
                close()

                const current = rawMembers()
                // Members store by ratingKey (a Collection stays the literal string
                // the Python resolver expands) — the same write shapes as the queue
                // add flow.
                const value = isCollection
                  ? `Collection: ${hit.title}`
                  : {
                      ratingKey: hit.ratingKey,
                      title: label,
                    }
                const isDuplicate = current.some((v) =>
                  isCollection
                    ? String(v).trim().toLowerCase() ===
                      `collection: ${hit.title}`.toLowerCase()
                    : String(
                        v && typeof v === "object"
                          ? (v as { ratingKey?: string })
                              .ratingKey
                          : v,
                      ) === String(hit.ratingKey),
                )

                if (isDuplicate) {
                  setStatus(
                    `Already a member — “${hit.title}”`,
                    "ok",
                  )

                  return
                }

                const optimistic: ChannelMember = {
                  childCount: isCollection
                    ? (hit.childCount ?? null)
                    : null,
                  index: current.length,
                  nextEp: null,
                  ratingKey: hit.ratingKey,
                  resolved: true,
                  start: null,
                  title: hit.title,
                  type: isCollection
                    ? "collection"
                    : hit.type,
                  year: isCollection
                    ? null
                    : hit.year || null,
                }

                setMembers((prev) => {
                  const at = prev.findIndex(
                    (x) => byTitle(x, optimistic) > 0,
                  )
                  const next = [...prev]

                  next.splice(
                    at < 0 ? next.length : at,
                    0,
                    optimistic,
                  )

                  return next
                })
                setStatus(`Added “${hit.title}”`, "ok")

                void saveMembersLive(channel.id, [
                  ...current,
                  value,
                ]).then(() => {
                  // Reconcile: fills in what only the server knows (a collection's
                  // next-up member, a show's next episode).
                  void reload(channel.id)
                })
              },
            }
          }}
        />
      </div>
      {/* Shown only when the channel has no curated members: a slim one-liner
          instead of a poster-sized empty tile. */}
      <p className="chmhint muted">
        Optional manual includes — a show, Plex Collection,
        movie, or short played ON TOP of the rule pool below
        (the opposite of Blocked). Members can come from any
        library, not just this channel&apos;s. Leave empty
        to play purely by the rule.
      </p>
      <ul
        className="grid editable"
        hidden={!members.length}
        id="chmembers"
        ref={gridRef}
      >
        {members.map((m) => {
          const face = tileFace(m)
          const entry = entryFor(m)

          return (
            <PosterTile
              badges={
                <>
                  <TypeBadge face={face} item={m} />
                  {m.start ? (
                    <Tip
                      label={`Manual start point${
                        m.nextEp?.startMember
                          ? ` — begins at “${m.nextEp.startMember}”`
                          : ""
                      }. Click to change it or go back to automatic.`}
                    >
                      <button
                        className="badge startbadge"
                        onClick={() =>
                          openStartModal(entry)
                        }
                        type="button"
                      >
                        {startLabel(m.start)}
                      </button>
                    </Tip>
                  ) : null}
                </>
              }
              className={
                m.resolved ? undefined : "unresolved"
              }
              dataKey={String(m.ratingKey || m.title)}
              key={String(m.ratingKey || m.title)}
              next={{
                isDone: face.nextDone,
                onStart: isStartable(m)
                  ? () => openStartModal(entry)
                  : undefined,
                text: face.next,
                tooltip: `${
                  face.from && m.childCount != null
                    ? `${face.next} — ${m.childCount} in order`
                    : face.next
                }${
                  isStartable(m)
                    ? `\nTap to choose where this ${
                        m.type === "collection"
                          ? "collection"
                          : "show"
                      } starts`
                    : ""
                }`,
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openTileMenu(e.clientX, e.clientY, entry)
              }}
              onRemove={() => removeMember(m)}
              posterRatingKey={
                m.resolved ? face.ratingKey : null
              }
              title={
                face.title +
                (face.year ? ` (${face.year})` : "")
              }
              titleTooltip={
                face.from
                  ? `${face.fullTitle || face.title} — from the “${face.from}” collection`
                  : face.title +
                    (face.year ? ` (${face.year})` : "")
              }
            />
          )
        })}
      </ul>
    </section>
  )
}

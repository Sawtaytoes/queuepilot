import { Badge, BadgeButton } from "@charcuterie/ui"

import { api } from "../lib/api"
import { isCountOverride } from "../lib/countPicker"
import {
  sectionOf,
  sectionTagLabel,
  sectionTagTip,
} from "../lib/section"
import { startLabel } from "../lib/tileFace"
import type {
  BatchStop,
  ProviderVocabulary,
  QueueItem,
} from "../lib/types"
import { applyVocab, PLEX_WORDS } from "../lib/vocab"
import { refreshData } from "../state/live"
import {
  bumpRevision,
  getState,
  setStatus,
} from "../state/store"
import { Tip } from "./Tip"

/**
 * An entry's four settings — episodes per play, WEIGHT, where a batch may stop, and the manual
 * start point — as read-only TAGS on the tile plus one panel that edits them.
 *
 * Tags rather than four controls on every tile (decision
 * `2026-08-14-entry-settings-are-tags-plus-a-panel`): the overwhelming majority of entries are
 * "play the next one, once", and rendering four dropdowns each to say so buried the two things
 * a tile is actually for — which show it is and what plays next — under chrome. So a default
 * shows NOTHING, and every tag you do see is a deviation worth reading. The same tags carry
 * across all three densities, which is what lets the poster wall keep the information at all.
 */

export const WEIGHT_MAX = 20
export const EPISODES_MAX = 40

export { PLEX_WORDS } from "../lib/vocab"

/**
 * "3 eps" / "3 ch" / "3 plays" — the tag has to fit on a poster tile, so the unit is
 * abbreviated.
 *
 * This USED to be `vocab.unit === "episode" ? "eps" : "ch"`, which quietly tagged a board
 * game "3 ch": a binary over a map that already had three entries. The abbreviation is the
 * provider's own word now (`ProviderVocabulary.unitShort`), so a fourth medium adds one map
 * entry and no component edit — which is what the vocabulary ADR promised.
 */
const shortUnits = (
  vocab: ProviderVocabulary,
  count: number,
) => {
  const short =
    vocab.unitShort || PLEX_WORDS.unitShort || "eps"

  // "1 plays" is what a plural abbreviation reads as on a queue of one, and a board game
  // with one play owed is the COMMON case (a game you already know). Only a short form
  // that is actually plural is trimmed, so "ch" is untouched and "eps" becomes "ep".
  return count === 1 && short.endsWith("s")
    ? short.slice(0, -1)
    : short
}

/** The tags for one entry: only what differs from the defaults, in a stable order. */
export function SettingTags({
  hasSections = false,
  item,
  onEdit,
  vocab = PLEX_WORDS,
}: {
  /**
   * Can this queue's provider play a SECTION of an item? Plex alone today.
   *
   * A section tag is not rendered without it, for the same reason the editor offers no
   * control: a stored window a backend cannot serve would name a behaviour the entry does
   * not have. Defaults to false so a caller that has not joined the queue to its provider
   * shows nothing rather than a claim it cannot back
   * (`state/capabilities.usePlaysSections`).
   */
  hasSections?: boolean
  item: QueueItem
  onEdit?: () => void
  /** The queue's provider vocabulary — a reading tile must not say "3 eps". */
  vocab?: ProviderVocabulary
}) {
  const isVolume = item.unit === "volume"
  const section = hasSections ? sectionOf(item) : null
  const weight = item.weight ?? 1
  const tag = (
    label: string,
    tip: string,
    className: string,
    intent: "accent" | "neutral" | "success" | "warning",
    // Truncate by default, which is right for every tag whose text is a WORD — "3 eps",
    // "Leads", "Skipped" — because the first few characters already identify it. A section
    // tag is the exception: its meaning is entirely in two timecodes, and in the Narrow View
    // "Section 01:01:00–01:…" says which end was cut off and nothing about where it stops.
    overflow: "truncate" | "wrap" = "truncate",
  ) => (
    // The two branches are the SAME pill now: `BadgeButton` and `Badge` build it through
    // one shared hook in the library, so a tag you can press and a tag you cannot are
    // indistinguishable until you reach for it. That is what `.badge.tagbtn` was spelling
    // by hand, one `intent` at a time, in `app.css`.
    <Tip key={className} label={tip}>
      {onEdit ? (
        <BadgeButton
          appearance="outline"
          className={`badge ${className}`}
          intent={intent}
          onClick={onEdit}
          overflow={overflow}
          size="sm"
        >
          {label}
        </BadgeButton>
      ) : (
        <Badge
          appearance="outline"
          className={`badge ${className}`}
          intent={intent}
          overflow={overflow}
          size="sm"
        >
          {label}
        </Badge>
      )}
    </Tip>
  )

  return (
    <>
      {isVolume && isCountOverride(item.volumes)
        ? tag(
            `${item.volumes} vol`,
            `Queues ${item.volumes} volumes each time this entry comes up`,
            "epstag",
            "neutral",
          )
        : !isVolume && isCountOverride(item.episodes)
          ? tag(
              `${item.episodes} ${shortUnits(vocab, item.episodes)}`,
              `Queues ${item.episodes} ${vocab.units} each time this entry comes up`,
              "epstag",
              "neutral",
            )
          : null}
      {item.item_order === "shuffle"
        ? tag(
            "Shuffle",
            "Chooses any playable item inside this show or Collection, including watched items",
            "shuffletag",
            "accent",
          )
        : null}
      {item.placement === "priority"
        ? tag(
            item.lead === "once"
              ? "Priority · once"
              : "Priority",
            item.lead === "once"
              ? "Leads the sitting, then yields until its window is up"
              : "Leads the sitting, ahead of anything in the random pool",
            "prioritytag",
            "accent",
          )
        : null}
      {weight > 1
        ? tag(
            `${weight}x as often`,
            `Takes about ${weight} slots for every one a normal entry takes when this queue is randomized`,
            "weighttag",
            "success",
          )
        : null}
      {item.batch_stops_at && item.item_order !== "shuffle"
        ? tag(
            item.batch_stops_at === "season"
              ? "Ends at season"
              : "Ends at show",
            item.batch_stops_at === "season"
              ? "This batch never crosses a season finale"
              : "This batch never leaves the current show inside the collection",
            "stoptag",
            "neutral",
          )
        : null}
      {/* A skip is otherwise INVISIBLE on the tile: the caption simply names a different
          episode, and nothing says why. Same rule as every tag here — a default shows
          nothing, and what you do see is a deviation worth reading. */}
      {item.skippedCount
        ? tag(
            `${item.skippedCount} skipped`,
            applyVocab(
              `${item.skippedCount} ${item.skippedCount === 1 ? "item" : "items"} inside this entry never play. Open it to change what does.`,
              vocab,
            ),
            "skiptag",
            "neutral",
          )
        : null}
      {/* The start tag reads the UNIT the start names, and a film section names none — its
          `start` carries a position and nothing else. `startLabel` answers "" for that, so
          the tag is skipped and the section tag below is what reads the offset. */}
      {startLabel(item.start, item.unit)
        ? tag(
            startLabel(item.start, item.unit),
            applyVocab(
              "Manual start point — playback begins here, and earlier episodes are left unwatched",
              vocab,
            ),
            "startbadge",
            "warning",
          )
        : null}
      {/* A SECTION is otherwise invisible: the tile names the same item it always did, and
          nothing says only two minutes of it will play. Three readings, one per state that
          is worth showing, and nothing at all when there is no section — the same rule every
          tag here follows. Beside the start tag rather than instead of it: they answer two
          different questions, WHICH unit plays and WHERE IN IT, and an episode entry can
          carry both. */}
      {section
        ? tag(
            sectionTagLabel(section),
            applyVocab(sectionTagTip(section), vocab),
            "sectiontag",
            "warning",
            "wrap",
          )
        : null}
    </>
  )
}

/** PATCH one field of one entry, updating the store optimistically. */
async function patchEntry(
  setId: string,
  item: QueueItem,
  path: string,
  body: Record<string, unknown>,
  apply: (hit: QueueItem) => void,
) {
  setStatus("Saving…")
  try {
    await api(
      "PATCH",
      `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/${path}`,
      body,
    )
    const hit = getState().data?.sets[setId]?.items.find(
      (it) => it.key === item.key,
    )
    if (hit) {
      apply(hit)
      bumpRevision()
    }
    setStatus("Saved", "ok")
  } catch (error) {
    setStatus(
      `Save failed: ${(error as Error).message}`,
      "err",
    )
    refreshData()
  }
}

export const setEntryVolumes = (
  setId: string,
  item: QueueItem,
  volumes: number,
) =>
  patchEntry(setId, item, "volumes", { volumes }, (hit) => {
    const setDefault =
      getState().reg?.sets.find((set) => set.id === setId)
        ?.volumes ?? 1
    hit.volumes = volumes === setDefault ? null : volumes
  })

export const setEntryEpisodes = (
  setId: string,
  item: QueueItem,
  episodes: number,
) =>
  patchEntry(
    setId,
    item,
    "episodes",
    { episodes },
    (hit) => {
      const setDefault =
        getState().reg?.sets.find((set) => set.id === setId)
          ?.episodes ?? 1
      hit.episodes =
        episodes === setDefault ? null : episodes
    },
  )

export const setEntryItemOrder = (
  setId: string,
  item: QueueItem,
  itemOrder: string,
) =>
  patchEntry(
    setId,
    item,
    "item-order",
    { item_order: itemOrder },
    (hit) => {
      hit.item_order =
        itemOrder === "shuffle" ? "shuffle" : null
    },
  )

export const setEntryWeight = (
  setId: string,
  item: QueueItem,
  weight: number,
) =>
  patchEntry(setId, item, "weight", { weight }, (hit) => {
    hit.weight = weight
  })

/**
 * PROMOTE / DEMOTE — move this entry between the Priority queue and the Random pool.
 *
 * `""` clears the override, so the entry follows the set's own default lane again. That is
 * a third state, not a synonym for either value: a queue where nothing has been promoted
 * stores no `placement` at all, and the panel has to be able to go back to saying so.
 */
export const setEntryPlacement = (
  setId: string,
  item: QueueItem,
  value: string,
) =>
  patchEntry(
    setId,
    item,
    "placement",
    { placement: value },
    (hit) => {
      hit.placement =
        value === "priority" || value === "random"
          ? value
          : null
      // The server drops both when an entry leaves the Priority lane — they mean nothing
      // in the pool — so the optimistic copy has to drop them too, or the panel keeps
      // rendering a lead mode for an entry that no longer has one.
      if (value !== "priority") {
        hit.lead = null
        hit.promote_window = null
      }
    },
  )

/** How often a Priority entry leads: every sitting, or once per window. */
export const setEntryLead = (
  setId: string,
  item: QueueItem,
  lead: string,
  promoteWindow: string,
) =>
  patchEntry(
    setId,
    item,
    "lead",
    { lead, promote_window: promoteWindow },
    (hit) => {
      hit.lead =
        lead === "once" || lead === "always" ? lead : null
      hit.promote_window =
        lead === "once" && promoteWindow
          ? promoteWindow
          : null
    },
  )

export const setEntryBatchStop = (
  setId: string,
  item: QueueItem,
  value: string,
) =>
  patchEntry(
    setId,
    item,
    "batch-stop",
    { batch_stops_at: value },
    (hit) => {
      hit.batch_stops_at =
        value === "member" || value === "season"
          ? (value as BatchStop)
          : null
    },
  )

export const setEntryWatchHistory = (
  setId: string,
  item: QueueItem,
  value: string,
) =>
  patchEntry(
    setId,
    item,
    "watch-history",
    { watch_history: value },
    (hit) => {
      hit.watch_history =
        value === "provider" || value === "queue"
          ? value
          : null
      const queueDefault =
        getState().reg?.sets.find((set) => set.id === setId)
          ?.watch_history ?? "provider"
      hit.effective_watch_history =
        hit.watch_history ?? queueDefault
    },
  )

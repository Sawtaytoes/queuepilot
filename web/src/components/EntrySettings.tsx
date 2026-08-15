import { Badge } from "@charcuterie/ui"

import { api } from "../lib/api"
import { startLabel } from "../lib/tileFace"
import type {
  BatchStop,
  ProviderVocabulary,
  QueueItem,
} from "../lib/types"
import { refreshData } from "../state/live"
import {
  type EntryActions,
  openStartModal,
} from "../state/overlays"
import {
  bumpRevision,
  getState,
  setStatus,
  useStore,
} from "../state/store"
import { CountPicker } from "./CountPicker"
import { Modal } from "./Modal"
import { SelectListbox } from "./SelectListbox"
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

/**
 * Plex's words, used wherever a caller has no set in hand.
 *
 * The fallback rather than a hardcoded string, so a component that forgets to pass the
 * vocabulary renders exactly what it rendered before providers had one — a visible-but-wrong
 * noun on a reading tile, never `undefined`.
 */
export const PLEX_WORDS: ProviderVocabulary = {
  done: "watched",
  member: "show",
  unit: "episode",
  units: "episodes",
  verb: "Play",
}

/** "3 eps" / "3 ch" — the tag has to fit on a poster tile, so the unit is abbreviated. */
const shortUnits = (vocab: ProviderVocabulary) =>
  vocab.unit === "episode" ? "eps" : "ch"

/** The tags for one entry: only what differs from the defaults, in a stable order. */
export function SettingTags({
  item,
  onEdit,
  vocab = PLEX_WORDS,
}: {
  item: QueueItem
  onEdit?: () => void
  /** The queue's provider vocabulary — a reading tile must not say "3 eps". */
  vocab?: ProviderVocabulary
}) {
  const episodes = item.episodes ?? 1
  const weight = item.weight ?? 1
  const tag = (
    label: string,
    tip: string,
    className: string,
    intent: "accent" | "neutral" | "success" | "warning",
  ) => (
    <Tip key={className} label={tip}>
      {onEdit ? (
        <button
          className={`badge tagbtn ${className}`}
          onClick={onEdit}
          type="button"
        >
          {label}
        </button>
      ) : (
        <Badge
          appearance="outline"
          className={`badge ${className}`}
          intent={intent}
          size="sm"
        >
          {label}
        </Badge>
      )}
    </Tip>
  )

  return (
    <>
      {episodes > 1
        ? tag(
            `${episodes} ${shortUnits(vocab)}`,
            `Queues ${episodes} ${vocab.units} each time this entry comes up`,
            "epstag",
            "neutral",
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
      {item.batch_stops_at
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
      {item.start
        ? tag(
            startLabel(item.start),
            "Manual start point — playback begins here, and earlier episodes are left unwatched",
            "startbadge",
            "warning",
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
  } catch (e) {
    setStatus(`Save failed: ${(e as Error).message}`, "err")
    refreshData()
  }
}

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
      hit.episodes = episodes
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

/**
 * The settings panel for ONE entry.
 *
 * Every control writes on change rather than on a Save button: each field is its own PATCH
 * server-side, the grid already updates optimistically, and a Save button would have to invent
 * a transaction the API does not have. The footer button therefore says Done, not Save.
 */
export function EntryEditor({
  entryFor,
  isOpen,
  itemKey,
  onClose,
  setId,
}: {
  entryFor: (item: QueueItem) => EntryActions
  isOpen: boolean
  itemKey: string | null
  onClose: () => void
  setId: string | null
}) {
  // Re-read from the store every render: the panel stays correct while an SSE update, another
  // device, or the bulk bar changes this entry underneath it.
  const { data, reg } = useStore()
  const item = setId
    ? data?.sets[setId]?.items.find(
        (it) => it.key === itemKey,
      )
    : undefined
  // The queue's own words, so this panel does not ask a reading queue about episodes.
  const vocab =
    (setId
      ? reg?.sets.find((s) => s.id === setId)?.vocabulary
      : null) ?? PLEX_WORDS

  if (!isOpen || !setId || !item) return null

  const episodes = item.episodes ?? 1
  const isSeries =
    item.type === "show" || item.type === "collection"

  return (
    <Modal
      footer={
        <button
          className="primary"
          onClick={onClose}
          type="button"
        >
          Done
        </button>
      }
      id="entrymodal"
      isOpen={isOpen}
      onClose={onClose}
      title={item.title}
      titleId="entrymodal-title"
    >
      <div className="entryfields">
        {isSeries ? (
          <div className="field">
            {/* In the QUEUE's words: this panel used to ask a manga entry how many
                "episodes queued per play" it wanted. */}
            <span className="fieldlabel">
              {`${vocab.units[0]?.toUpperCase()}${vocab.units.slice(1)} queued per turn`}
            </span>
            <CountPicker
              label={`${vocab.units} queued per turn`}
              max={EPISODES_MAX}
              onChange={(n) =>
                void setEntryEpisodes(setId, item, n)
              }
              value={episodes}
            />
            <span className="fieldhint">
              {`How long this entry’s turn is when the queue reaches it. Overrides
                the queue’s own default.`}
            </span>
          </div>
        ) : null}

        <div className="field">
          <span className="fieldlabel">
            Weight — how often it comes up
          </span>
          <CountPicker
            label="Weight"
            max={WEIGHT_MAX}
            onChange={(n) =>
              void setEntryWeight(setId, item, n)
            }
            unit="x"
            value={item.weight ?? 1}
          />
          <span className="fieldhint">
            A 3x entry takes about three slots for every one
            a normal entry takes — spread through the queue,
            not three in a row. Only applies while this set
            plays in a random order.
          </span>
        </div>

        {isSeries && episodes > 1 ? (
          <div className="field">
            <span className="fieldlabel">
              Where the batch may stop
            </span>
            <SelectListbox
              label="Where this batch may stop"
              onChange={(v) =>
                void setEntryBatchStop(setId, item, v)
              }
              options={[
                { label: "Follow the set", value: "" },
                { label: "End at season", value: "season" },
                ...(item.type === "collection"
                  ? [
                      {
                        label: "End at show",
                        value: "member",
                      },
                    ]
                  : []),
              ]}
              value={item.batch_stops_at || ""}
            />
            <span className="fieldhint">
              Keeps a season finale from being followed by
              the next season (or, in a collection, another
              show&rsquo;s episode 1).
            </span>
          </div>
        ) : null}

        <div className="field">
          <span className="fieldlabel">Start point</span>
          <div className="fieldrow">
            <span>
              {item.start
                ? startLabel(item.start)
                : "Automatic — the next unwatched"}
            </span>
            <button
              onClick={() => {
                // The picker is its own modal with its own season/episode loads; stacking it
                // on top of this one would put two dialogs in the overlay stack for one entry.
                onClose()
                openStartModal(entryFor(item))
              }}
              type="button"
            >
              {item.start ? "Change…" : "Choose…"}
            </button>
            {item.start ? (
              <button
                onClick={() =>
                  void entryFor(item)
                    .save(null)
                    .then(() => refreshData())
                }
                type="button"
              >
                Back to automatic
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  )
}

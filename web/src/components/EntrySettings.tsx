import {
  Badge,
  BadgeButton,
  Button,
  ButtonLink,
} from "@charcuterie/ui"

import { api } from "../lib/api"
import {
  effectiveCount,
  isCountOverride,
} from "../lib/countPicker"
import { startLabel, tileFace } from "../lib/tileFace"
import type {
  BatchStop,
  ProviderVocabulary,
  QueueItem,
} from "../lib/types"
import { applyVocab, PLEX_WORDS } from "../lib/vocab"
import { refreshData } from "../state/live"
import {
  type EntryActions,
  openPlayMenu,
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
import { isPullSet } from "./OpenQueueButton"
import { Poster } from "./Poster"
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
  item,
  onEdit,
  vocab = PLEX_WORDS,
}: {
  item: QueueItem
  onEdit?: () => void
  /** The queue's provider vocabulary — a reading tile must not say "3 eps". */
  vocab?: ProviderVocabulary
}) {
  const isVolume = item.unit === "volume"
  const weight = item.weight ?? 1
  const tag = (
    label: string,
    tip: string,
    className: string,
    intent: "accent" | "neutral" | "success" | "warning",
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
          size="sm"
        >
          {label}
        </BadgeButton>
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
            startLabel(item.start, item.unit),
            applyVocab(
              "Manual start point — playback begins here, and earlier episodes are left unwatched",
              vocab,
            ),
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

export const setEntryVolumes = (
  setId: string,
  item: QueueItem,
  volumes: number,
) =>
  patchEntry(setId, item, "volumes", { volumes }, (hit) => {
    const setDefault =
      getState().reg?.sets.find((s) => s.id === setId)
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
        getState().reg?.sets.find((s) => s.id === setId)
          ?.episodes ?? 1
      hit.episodes =
        episodes === setDefault ? null : episodes
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
  const setInfo = setId
    ? reg?.sets.find((s) => s.id === setId)
    : undefined
  const vocab = setInfo?.vocabulary ?? PLEX_WORDS

  if (!isOpen || !setId || !item) return null

  const chapterDefault = setInfo?.episodes ?? 1
  const volumeDefault = setInfo?.volumes ?? 1
  const episodes = effectiveCount(
    item.episodes,
    chapterDefault,
  )
  const volumes = effectiveCount(
    item.volumes,
    volumeDefault,
  )
  const isVolume = item.unit === "volume"
  const isSeries =
    item.type === "show" || item.type === "collection"
  const face = tileFace(item)
  const entry = entryFor(item)
  // Pushed at a device, or opened by a link — the same split the tile's ▶ makes. A pull
  // queue has no device to name, so offering one here would repeat the bug the tile
  // already fixed: a Shield, a Plex Dash and a phone for a manga chapter.
  const isPull = isPullSet(setInfo)
  const verb = vocab.verb

  return (
    <Modal
      footer={
        // A Charcuterie `Button`, configured by props. `.primary` had to be restated at
        // `#entrymodal .modalbtns button.primary` because this panel's confirm is a click
        // handler and the shared rule only painted `[type="submit"]` — two spellings of one
        // accent, which is the duplication `intent` removes.
        // (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`)
        <Button intent="accent" onClick={onClose}>
          Done
        </Button>
      }
      // The sheet wears the queue's provider colour, like every other surface under
      // `#queue` — it is portalled to `document.body`, so it cannot inherit the
      // `data-provider` the view sets and has to be told.
      // (decision `2026-08-15-a-queue-wears-its-providers-colour`)
      dataProvider={setInfo?.provider_kind || undefined}
      id="entrymodal"
      isOpen={isOpen}
      onClose={onClose}
      title={item.title}
      titleId="entrymodal-title"
    >
      {/* The head of the sheet: the artwork, what plays next, and the two actions that
          do something to the WORLD rather than to this entry's settings.

          It exists because the poster is now the way in. A tap on a tile opens this
          panel (decision `2026-08-17-a-poster-tap-opens-the-entry-sheet`), which means
          the panel has to answer "which one is this, and can I just play it?" before it
          asks about weights and batch stops — and at a size a finger can hit, which the
          26px ▶ on the tile never was. */}
      <div className="entryhead">
        <Poster
          className="entryart"
          cover={item.cover}
          ratingKey={item.resolved ? face.ratingKey : null}
        />
        {/* What plays next, beside the artwork. Empty for a one-off movie — `:empty`
            collapses it rather than reserving a blank column. */}
        <p
          className={`entrynext${face.nextDone ? " done" : ""}`}
        >
          {face.next}
        </p>
      </div>

      {/* Its OWN full-width row, not a column beside the poster. A 96px poster leaves
          203px of a 313px sheet, and "Remove from this queue" wrapped to two lines in
          it while ▶ sat at 110px — two cramped buttons in the panel whose entire reason
          for existing is that the control on the tile was too small. */}
      <div className="entryactions">
        {/* Only a RESOLVED entry can play: an unresolved one has no library item
            behind it, so the server would reject the start after the device menu had
            already asked which TV. Same rule as the tile's ▶. */}
        {item.resolved && !isPull ? (
          // A Charcuterie `Button`, `intent="accent"` — what `#entrymodal .entryactions >
          // .primary` painted by hand.
          //
          // ⚠️ `className="playbtn"` FIXES A BUG, it does not just carry a look. This button
          // opens the device menu, and `PlayMenu`'s outside-click handler only spares
          // `.playmenu`, `.playbtn` and `.shelfplay` — `.primary` is in none of them, so the
          // document handler closed the menu on the very click that opened it. Measured
          // before the change: `after clicking the panel ▶, .playmenu present: false`. The
          // class is the same DOM handle the other three play buttons carry.
          <Button
            className="playbtn"
            intent="accent"
            onClick={(clickEvent) =>
              openPlayMenu({
                anchor:
                  clickEvent.currentTarget.getBoundingClientRect(),
                kind: undefined,
                only: item.key,
                onlyLabel: face.title,
                setId,
              })
            }
          >
            ▶ {verb} on ▾
          </Button>
        ) : null}
        {item.resolved && isPull ? (
          // An anchor because it NAVIGATES — middle-clickable and bookmarkable like
          // every other link here (decision
          // `2026-08-15-navigation-is-an-anchor-not-a-button`). New tab, so the queue
          // you launched from is still there when you come back from the reader.
          <ButtonLink
            href={`/go/${encodeURIComponent(setId)}?only=${encodeURIComponent(item.key)}`}
            intent="accent"
            // Replaces `target="_blank"` + `rel="noreferrer"`, and ANNOUNCES the new tab
            // rather than leaving that to a glyph a screen reader does not read as one.
            isExternal
          >
            ▶ {verb} now
          </ButtonLink>
        ) : null}
        {entry.remove ? (
          // `appearance="outline"`, not solid: the rule it replaces was a TRANSPARENT
          // background with a neutral border and danger-coloured text, which is what
          // `outline` means. A solid danger button here would shout louder than the
          // panel's own primary action.
          <Button
            appearance="outline"
            intent="danger"
            onClick={() => {
              // The entry this panel is about is about to stop existing, so the
              // panel goes with it rather than sitting there describing nothing.
              onClose()
              entry.remove?.()
            }}
          >
            {entry.removeLabel || "Remove"}
          </Button>
        ) : null}
      </div>

      <div className="entryfields">
        {isSeries ? (
          <div className="field">
            {/* A volume is a collection of chapters, not a chapter — the chapter
                count must not apply. The control (and the field it writes) follow
                the ITEM's unit. */}
            <span className="fieldlabel">
              {isVolume
                ? "Volumes queued per turn"
                : `${vocab.units[0]?.toUpperCase()}${vocab.units.slice(1)} queued per turn`}
            </span>
            <CountPicker
              defaultValue={
                isVolume ? volumeDefault : chapterDefault
              }
              label={
                isVolume
                  ? "Volumes queued per turn"
                  : `${vocab.units} queued per turn`
              }
              max={EPISODES_MAX}
              onChange={(n) =>
                void (isVolume
                  ? setEntryVolumes(setId, item, n)
                  : setEntryEpisodes(setId, item, n))
              }
              value={isVolume ? volumes : episodes}
            />
            <span className="fieldhint">
              {isVolume
                ? "A volume is a collection of chapters. This is how many volumes this series contributes per visit — independent of the queue’s chapter count."
                : `How long this entry’s turn is when the queue reaches it. Overrides
                the queue’s own default.`}
            </span>
          </div>
        ) : null}

        <div className="field">
          <span className="fieldlabel">
            Weight — how often it comes up
          </span>
          <CountPicker
            defaultValue={1}
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

        {isSeries && !isVolume && episodes > 1 ? (
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
                ? startLabel(item.start, item.unit)
                : applyVocab(
                    "Automatic — the next unwatched",
                    vocab,
                  )}
            </span>
            {/* `#entrymodal .fieldrow button` painted a small outline control — surface
                base, a border, 6px/12px — which is `appearance="outline"` at `size="sm"`.
                An ELEMENT selector, so it is deleted rather than left to outrank the
                component. */}
            <Button
              appearance="outline"
              intent="neutral"
              onClick={() => {
                // The picker is its own modal with its own season/episode loads; stacking it
                // on top of this one would put two dialogs in the overlay stack for one entry.
                onClose()
                openStartModal(entryFor(item))
              }}
              size="sm"
            >
              {item.start ? "Change…" : "Choose…"}
            </Button>
            {item.start ? (
              <Button
                appearance="outline"
                intent="neutral"
                onClick={() =>
                  void entryFor(item)
                    .save(null)
                    .then(() => refreshData())
                }
                size="sm"
              >
                Back to automatic
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  )
}

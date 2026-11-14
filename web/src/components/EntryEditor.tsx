import { Button, ButtonLink } from "@charcuterie/ui"
import { api } from "../lib/api"
import { effectiveCount } from "../lib/countPicker"
import {
  DEFAULT_LEAD_WINDOW,
  leadWindowLabel,
  normalizeAddAs,
} from "../lib/kind"
import { isPlayingItem } from "../lib/nowPlaying"
import {
  runtimeMs,
  sectionOf,
  sectionSummary,
  withUnit,
} from "../lib/section"
import {
  hasMemberList,
  startLabel,
  tileFace,
} from "../lib/tileFace"
import type { QueueItem } from "../lib/types"
import { applyVocab, PLEX_WORDS } from "../lib/vocab"
import { usePlaysSections } from "../state/capabilities"
import { refreshData } from "../state/live"
import {
  type EntryActions,
  openMembersModal,
  openPlayMenu,
  openSectionModal,
  openStartModal,
} from "../state/overlays"
import { setStatus, useStore } from "../state/store"
import { CountPicker } from "./CountPicker"
import {
  EPISODES_MAX,
  setEntryBatchStop,
  setEntryEpisodes,
  setEntryItemOrder,
  setEntryLead,
  setEntryPlacement,
  setEntryVolumes,
  setEntryWatchHistory,
  setEntryWeight,
  WEIGHT_MAX,
} from "./EntrySettings"
import { Modal } from "./Modal"
import { isPullSet } from "./OpenQueueButton"
import { Poster } from "./Poster"
import { SelectListbox } from "./SelectListbox"
import { commitSection } from "./sectionCommit"

async function changeQueueHistory(
  method: "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) {
  setStatus("Saving watch history…")
  try {
    await api(method, path, body)
    setStatus("Watch history updated", "ok")
    refreshData()
  } catch (error) {
    setStatus(
      `Watch history failed: ${(error as Error).message}`,
      "err",
    )
  }
}

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
  const { data, now, reg } = useStore()
  const item = setId
    ? data?.sets[setId]?.items.find(
        (it) => it.key === itemKey,
      )
    : undefined
  // The queue's own words, so this panel does not ask a reading queue about episodes.
  const setInfo = setId
    ? reg?.sets.find((set) => set.id === setId)
    : undefined
  const vocab = setInfo?.vocabulary ?? PLEX_WORDS
  // Can this queue's backend play PART of an item? A reading queue and a board-game queue
  // get no section row at all — not a disabled one — the same rule the watch-history field
  // follows a few rows up.
  const hasSections = usePlaysSections(setInfo)

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
  const isShufflable =
    isSeries &&
    (item.unit == null || item.unit === "episode")

  // ── THE LANE, resolved ────────────────────────────────────────────────────────────────
  // Three values collapse into two here, and the panel has to keep them apart: what the
  // ENTRY stores (`item.placement`, often null), what the QUEUE defaults to (`add_as`), and
  // what the two together MEAN for this sitting. The picker is bound to the stored value so
  // "Follow the queue" stays reachable; every label around it names the effective one.
  // `normalizeAddAs`, not a read of `add_as` — the registry row may carry only a LEGACY kind
  // (`anime` = random, `movies` = priority), and a bare read would call every one of those
  // sets a Priority queue and lie to the picker below.
  const setLane = normalizeAddAs(setInfo?.add_as, {
    kind: setInfo?.kind,
    source: setInfo?.source,
  })
  const setLaneLabel =
    setLane === "random" ? "Random pool" : "Priority queue"
  const effectiveLane = item.placement ?? setLane
  // THE WINDOW THIS ENTRY ACTUALLY FOLLOWS — entry, then queue, then the 16h product
  // default, which is `leadWindowMs()`'s precedence read from the other end. Nothing here
  // may hardcode a duration: the queue's own window is a setting now, so a panel that says
  // "once a day" over a queue set to 20h is describing a rule the engine is not running
  // (decision `2026-08-26-the-promote-window-is-a-queue-setting`).
  const setWindow =
    setInfo?.promote_window?.trim() || DEFAULT_LEAD_WINDOW
  // `lead` defaults by HOW the entry got into the lane: inherited from an ordered queue is
  // sticky, promoted by hand is once-per-window. A MOVIE is sticky either way, because it
  // cannot deliver part of itself and still owe the rest — it leaves the lane by being
  // watched, not by a clock. Mirrors `kind.normalizeLead` on the server
  // (decisions `2026-08-26-the-lead-window-belongs-to-a-promote-not-to-an-ordered-queue`
  // and `2026-09-23-a-ranked-movie-leads-until-it-is-watched`).
  const leadDefaultLabel =
    item.placement === "priority" && item.type !== "movie"
      ? `once every ${leadWindowLabel(setWindow)}`
      : "every sitting"
  const leadValue = item.lead
    ? item.lead === "once"
      ? `once:${item.promote_window || setWindow}`
      : "always"
    : ""
  // The queue's window first, so the common choice is the one the queue is already set to.
  // De-duplicated: with the queue on 7d, "a week" must not appear twice, and two options
  // carrying the same value would leave the picker unable to say which one is selected.
  const leadWindows = [...new Set([setWindow, "7d"])]
  const face = tileFace(item)
  const entry = entryFor(item)
  // Pushed at a device, or opened by a link — the same split the tile's ▶ makes. A pull
  // queue has no device to name, so offering one here would repeat the bug the tile
  // already fixed: a Shield, a Plex Dash and a phone for a manga chapter.
  const isPull = isPullSet(setInfo)
  const verb = vocab.verb
  const queueHistoryDefault =
    setInfo?.watch_history ?? "provider"
  const effectiveHistory =
    item.effective_watch_history ??
    item.watch_history ??
    queueHistoryDefault
  const historyItemKey =
    item.type === "movie"
      ? item.ratingKey
      : item.nextEp?.ratingKey
  const isCurrentPlexItem = isPlayingItem(now, item)

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
              onChange={(perTurn) =>
                void (isVolume
                  ? setEntryVolumes(setId, item, perTurn)
                  : setEntryEpisodes(setId, item, perTurn))
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

        {isShufflable ? (
          <div className="field">
            <span className="fieldlabel">
              {item.type === "show"
                ? "Episode order"
                : "Item order"}
            </span>
            <SelectListbox
              label={
                item.type === "show"
                  ? "Episode order"
                  : "Collection item order"
              }
              onChange={(value) =>
                void setEntryItemOrder(setId, item, value)
              }
              options={[
                {
                  label: "In order — next unwatched",
                  value: "",
                },
                {
                  label: "Shuffle — any item",
                  value: "shuffle",
                },
              ]}
              value={item.item_order || ""}
            />
            <span className="fieldhint">
              Shuffle includes watched items and chooses
              without replacement for this sitting. Skipped
              items stay out, and a manual start still
              limits the pool.
            </span>
          </div>
        ) : null}

        {/* THE LANE. It sits above Weight deliberately: weight only biases the Random
            pool, so "which lane is this in" is the question that decides whether the
            control below it means anything at all
            (decision `2026-08-23-kind-is-picks-or-rules` §2). */}
        <div className="field">
          <span className="fieldlabel">
            Lane — Priority queue or Random pool
          </span>
          <SelectListbox
            label="Which lane this entry is in"
            onChange={(placement) =>
              void setEntryPlacement(setId, item, placement)
            }
            options={[
              {
                label: `Follow the queue (${setLaneLabel})`,
                value: "",
              },
              {
                label: "Priority queue — plays first",
                value: "priority",
              },
              { label: "Random pool", value: "random" },
            ]}
            value={item.placement || ""}
          />
          <span className="fieldhint">
            The Priority queue plays before anything in the
            Random pool, in the order the entries sit in.
            Everything else is drawn from the pool to fill
            the rest of the sitting.
          </span>
        </div>

        {effectiveLane === "priority" ? (
          <div className="field">
            <span className="fieldlabel">
              How often it leads
            </span>
            <SelectListbox
              label="How often this entry leads"
              onChange={(leadRatio) => {
                const [lead = "", win = ""] =
                  leadRatio.split(":")
                void setEntryLead(setId, item, lead, win)
              }}
              options={[
                {
                  label: `Default (${leadDefaultLabel})`,
                  value: "",
                },
                {
                  label: "Every sitting",
                  value: "always",
                },
                ...leadWindows.map((leadWindow) => ({
                  label: `Once every ${leadWindowLabel(leadWindow)}, then yield`,
                  value: `once:${leadWindow}`,
                })),
              ]}
              value={leadValue}
            />
            <span className="fieldhint">
              {item.type === "movie" ? (
                <>
                  A ranked film leads every sitting until it
                  is watched, and then it leaves the lane by
                  being finished — so it is never held back
                  by a window. A window is for something
                  that can hand over part of what it owes
                  and still owe the rest, which a film
                  cannot. Choose one here to override that.
                </>
              ) : (
                <>
                  “Every sitting” is what an ordered queue
                  does — the top entry stays the top entry
                  until it is finished. A window is what a
                  promote is for: guaranteed first tonight,
                  then back in the pool until the window
                  runs out. The window is a rolling timer
                  from the moment playback started, and this
                  queue’s own is {setWindow} — the queue
                  editor changes it.
                </>
              )}
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
            onChange={(weight) =>
              void setEntryWeight(setId, item, weight)
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

        {isSeries &&
        !isVolume &&
        episodes > 1 &&
        item.item_order !== "shuffle" ? (
          <div className="field">
            <span className="fieldlabel">
              Where the batch may stop
            </span>
            <SelectListbox
              label="Where this batch may stop"
              onChange={(batchStop) =>
                void setEntryBatchStop(
                  setId,
                  item,
                  batchStop,
                )
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

        {/* WHAT PLAYS — the entry's members / episodes, and which of them this queue skips.
            Here and not only on the right-click menu, because a control nobody can see is a
            control nobody has: the owner looked for this feature, and the skip that already
            existed was reachable only by right-clicking a tile
            (reported 2026-08-26, "I don't see the skips/ignore feature"). A poster tap opens
            this sheet, so this is the surface every device can reach. */}
        {hasMemberList(item) ? (
          <div className="field">
            <span className="fieldlabel">What plays</span>
            <div className="fieldrow">
              <span>
                {item.skippedCount
                  ? `${item.skippedCount} skipped`
                  : item.type === "show"
                    ? "Normal episodes; specials by choice"
                    : applyVocab(
                        "Everything inside this entry",
                        vocab,
                      )}
              </span>
              <Button
                appearance="outline"
                intent="neutral"
                onClick={() => {
                  // Its own modal with its own list load — stacking it on this one would put
                  // two dialogs in the overlay stack for one entry, the same rule the start
                  // picker follows.
                  onClose()
                  openMembersModal(entryFor(item))
                }}
                size="sm"
              >
                Choose…
              </Button>
            </div>
            <span className="fieldhint">
              {applyVocab(
                item.type === "show"
                  ? "Normal episodes are selected. Specials start unselected, and you can include them one at a time."
                  : "Untick anything this queue must never play — one film inside a collection. A skipped item counts as dealt with, so the entry can still finish.",
                vocab,
              )}
            </span>
          </div>
        ) : null}

        {vocab.name === "Plex" ? (
          <div className="field">
            <span className="fieldlabel">
              Watch history
            </span>
            <SelectListbox
              label="Watch history for this entry"
              onChange={(value) =>
                void setEntryWatchHistory(
                  setId,
                  item,
                  value,
                )
              }
              options={[
                {
                  label: `Follow the queue (${queueHistoryDefault === "queue" ? "QueuePilot" : "Plex"})`,
                  value: "",
                },
                {
                  label: "Use Plex watch history",
                  value: "provider",
                },
                {
                  label: "Keep separate QueuePilot history",
                  value: "queue",
                },
              ]}
              value={item.watch_history || ""}
            />
            <span className="fieldhint">
              Plex history notices a play from any Plex
              client. Separate history advances only for
              this entry in this queue and does not change
              the Plex profile.
            </span>
            {effectiveHistory === "queue" ? (
              <div className="fieldrow">
                {isCurrentPlexItem ? (
                  <Button
                    appearance="outline"
                    intent="accent"
                    onClick={() =>
                      void changeQueueHistory(
                        "POST",
                        `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/watch-history/track-current`,
                      )
                    }
                    size="sm"
                  >
                    Track the current Plex play here
                  </Button>
                ) : null}
                {historyItemKey ? (
                  <Button
                    appearance="outline"
                    intent="neutral"
                    onClick={() =>
                      void changeQueueHistory(
                        "POST",
                        `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/watch-history/completions`,
                        { item_key: historyItemKey },
                      )
                    }
                    size="sm"
                  >
                    Mark next item completed
                  </Button>
                ) : null}
                {(item.queue_history_completed_count ?? 0) >
                0 ? (
                  <Button
                    appearance="outline"
                    intent="neutral"
                    onClick={() =>
                      void changeQueueHistory(
                        "DELETE",
                        `/api/queues/${setId}/items/${encodeURIComponent(item.key)}/watch-history/completions/latest`,
                      )
                    }
                    size="sm"
                  >
                    Undo latest completion
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="field">
          <span className="fieldlabel">Start point</span>
          <div className="fieldrow">
            <span>
              {startLabel(item.start, item.unit) ||
                applyVocab(
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
              {startLabel(item.start, item.unit)
                ? "Change…"
                : "Choose…"}
            </Button>
            {startLabel(item.start, item.unit) ? (
              <Button
                appearance="outline"
                intent="neutral"
                onClick={() =>
                  void entryFor(item)
                    // `withUnit(…, null)` and NOT `null`: this row owns WHICH unit plays, and
                    // a section's offset lives on the same `start` mapping. `PATCH …/start`
                    // replaces that mapping whole, so clearing it outright would drop a
                    // section this row never drew — invisibly.
                    .save(withUnit(item.start, null))
                    .then(() => refreshData())
                }
                size="sm"
              >
                Back to automatic
              </Button>
            ) : null}
          </div>
        </div>

        {/* THE SECTION — where inside the first played unit playback begins and stops.
            Its own row beside the start point rather than inside it, because they answer two
            different questions: that one picks WHICH unit plays, this one picks WHERE IN IT.
            An episode entry can carry both, and a film section carries only this.

            Rendered only when the queue's provider can actually play a section (Plex today)
            and only when the entry has an `end` writer — a rules channel's members store a
            whole-map `starts` on the set and have no line to hang an `end` on. A backend that
            cannot serve a section offers no control rather than one it would ignore
            (decision `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`). */}
        {hasSections && entry.saveEnd ? (
          <div className="field" id="entry-sectionfield">
            <span className="fieldlabel">Section</span>
            <div className="fieldrow">
              <span id="entry-sectionsummary">
                {`Plays ${sectionSummary(
                  sectionOf(item),
                  runtimeMs(item),
                )}`}
              </span>
              <Button
                appearance="outline"
                id="entry-sectionopen"
                intent="neutral"
                onClick={() => {
                  // Its own modal, like the start picker: it holds a DRAFT that is saved or
                  // cancelled as one answer, where every control on this sheet writes on
                  // change. Stacking it here would put two dialogs over one entry.
                  onClose()
                  openSectionModal(entryFor(item))
                }}
                size="sm"
              >
                {sectionOf(item) ? "Change…" : "Choose…"}
              </Button>
              {sectionOf(item) ? (
                <Button
                  appearance="outline"
                  id="entry-sectionclear"
                  intent="neutral"
                  onClick={() =>
                    void commitSection(entryFor(item), null)
                  }
                  size="sm"
                >
                  Play the whole item
                </Button>
              ) : null}
            </div>
            <span className="fieldhint">
              {applyVocab(
                "Plays only part of the first item this entry contributes, then moves on to the next entry. A later episode in the same batch still plays in full.",
                vocab,
              )}
            </span>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

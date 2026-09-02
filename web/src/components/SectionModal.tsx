import {
  Button,
  formatTimecode,
  RangeSlider,
  type RangeSliderValue,
  TimecodeInput,
  type TimecodeRange,
} from "@charcuterie/ui"
import { useEffect, useState } from "react"

import {
  isNowLive,
  isPlayingItem,
  nowPlayingPositionMs,
} from "../lib/nowPlaying"
import {
  runtimeMs,
  type Section,
  sectionOf,
  sectionSummary,
  timecode,
} from "../lib/section"
import type { QueueItem } from "../lib/types"
import { applyVocab, vocabForSet } from "../lib/vocab"
import {
  closeSectionModal,
  useOverlays,
} from "../state/overlays"
import { useStore } from "../state/store"
import { Modal } from "./Modal"
import { commitSection } from "./sectionCommit"

/**
 * "Section…" — where inside this entry's first played unit playback begins, and where it
 * stops.
 *
 * ONE value, three ways in, because the three answer different questions and the owner asked
 * for all of them:
 *
 * 1. **Type it** — a `TimecodeInput` in `isRange` mode. The only way to name a frame you have
 *    written down somewhere, and the only one that works with nothing playing.
 * 2. **Drag it** — a `RangeSlider` over the item's runtime. The only way to see the section
 *    as a proportion of the whole, which is the question "is this too long for a reel" is.
 * 3. **Capture it** — two buttons that read the live playback position. The only way to mark
 *    a point you are looking at, which is how a demo reel actually gets built.
 *
 * They are three views of one pair of numbers, so a drag moves the fields and a typed value
 * moves the thumbs.
 *
 * ⚠️ **BOTH ENDS ARE INDEPENDENTLY OPTIONAL, and `null` is not `0`.** Four states, all of
 * them real and all of them reachable here: no window, from a mark to the end, from the start
 * to a mark, and the window between two marks
 * (decision `2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`). An open end
 * is the ABSENCE of a choice — emptying either field clears just that end, and the footer's
 * Clear drops both. Everything below that has to distinguish them says so where it sits.
 */

/** How wide a step the fields and the bar move on an arrow key: one second. */
const STEP_MS = 1_000

const HINT =
  "Playback begins at the start mark and stops at the end mark, then the queue moves on to its next entry. Leave either one empty to use the beginning or the end of the item."

export function SectionModal() {
  const { sectionModal: entry } = useOverlays()
  const { now, reg } = useStore()
  const vocab = vocabForSet(reg?.sets, entry?.setId)
  const item = (entry?.item ?? null) as QueueItem | null
  const stored = sectionOf(item)

  const [startMs, setStartMs] = useState<number | null>(
    null,
  )
  const [endMs, setEndMs] = useState<number | null>(null)
  /**
   * Bumped whenever the value changes from something that is NOT the fields themselves — a
   * drag, a capture, a clear.
   *
   * `TimecodeInput`'s `valueMs` **seeds**, it does not control, exactly like every other
   * value prop in Charcuterie. So the only way to move the text after a drag is to remount
   * the field, and the only safe key is one that changes on the OTHER writers and never on
   * this one — keying on the value itself would remount the control under the user's own
   * caret mid-word
   * (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`).
   */
  const [seed, setSeed] = useState(0)
  // Re-renders the live position readout beside the capture buttons. Local, like the
  // Now-playing bar's own tick — nothing else on this page needs a clock.
  const [, setTick] = useState(0)

  // Open: seed the draft from what the entry stores. `entry` identity changes exactly once
  // per open, which is what makes this the open hook rather than a value watcher.
  useEffect(() => {
    setStartMs(stored?.startMs ?? null)
    setEndMs(stored?.endMs ?? null)
    setSeed((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry])

  const isPlayingThis =
    isNowLive(now) && isPlayingItem(now, item)

  useEffect(() => {
    if (!entry || !isPlayingThis) return

    const id = window.setInterval(() => {
      setTick((n) => n + 1)
    }, 1_000)

    return () => {
      window.clearInterval(id)
    }
  }, [entry, isPlayingThis])

  if (!entry || !item) {
    return (
      <Modal
        id="sectionmodal"
        isOpen={false}
        onClose={closeSectionModal}
        title="Section…"
        titleId="sectionmodal-title"
      >
        <p className="subhint">{HINT}</p>
      </Modal>
    )
  }

  const setInfo = reg?.sets.find(
    (s) => s.id === entry.setId,
  )
  /**
   * The item's runtime, or null when nothing knows it.
   *
   * ⚠️ **`durationMs={0}` would clamp every offset to zero.** The wire sends `0` for "not
   * known" — a Plex item whose next-up lookup came back empty — and a `TimecodeInput` reads
   * `durationMs` as its default maximum. So an unknown runtime becomes `undefined` here and
   * the field takes no upper bound at all, which is the honest answer: nothing knows where
   * the end of this item is, so nothing may refuse a value for being past it.
   */
  const duration = runtimeMs(item)
  const isChanged =
    (stored?.startMs ?? null) !== startMs ||
    (stored?.endMs ?? null) !== endMs

  const livePositionMs = isPlayingThis
    ? nowPlayingPositionMs(now)
    : null

  /**
   * Adopt a dragged pair WITHOUT converting an open end into a chosen one.
   *
   * A `RangeSlider` reports two numbers on every movement, and an open end has to be drawn
   * SOMEWHERE — the start thumb at 0, the end thumb at the runtime. So dragging the end thumb
   * of a start-open section reports `start: 0`, and adopting it verbatim would silently turn
   * "from the beginning" into "from 00:00:00.000" — a state the four-state table says is a
   * different answer. Each end is adopted only when it actually left where it was drawn.
   */
  const applyDrag = (value: RangeSliderValue) => {
    setStartMs((previous) =>
      value.start === (previous ?? 0)
        ? previous
        : value.start,
    )
    setEndMs((previous) =>
      value.end === (previous ?? duration ?? 0)
        ? previous
        : value.end,
    )
  }

  const capture = (endpoint: "end" | "start") => {
    if (livePositionMs == null) return

    if (endpoint === "start") setStartMs(livePositionMs)
    else setEndMs(livePositionMs)

    setSeed((n) => n + 1)
  }

  /** Read the draft back as the value to persist. Null = no section at all. */
  const readForm = (): Section | null =>
    startMs == null && endMs == null
      ? null
      : { endMs, startMs }

  // Why the capture buttons are off, in the user's words rather than as a disabled control
  // with no explanation. Three states and each one names its own way out.
  const captureNote = isPlayingThis
    ? livePositionMs == null
      ? "The player has not reported a position yet."
      : `Playing now — ${timecode(livePositionMs)}.`
    : isNowLive(now)
      ? applyVocab(
          "Something else is playing, so there is no position for THIS item to capture. Play this entry to mark a point in it.",
          vocab,
        )
      : applyVocab(
          "Nothing is playing, so there is no position to capture. Type the marks, or play this entry and come back.",
          vocab,
        )

  /**
   * The consequence a reader hits first, named where it can be acted on.
   *
   * A windowed entry on `watch_history: provider` NEVER completes: the queue asked Plex to be
   * the judge, and Plex judges a 40% play as unwatched — so the entry stays in the queue and
   * plays its section again next sitting. That is the queue's own setting speaking and is
   * deliberate, but it is a surprise, and the entry sheet one step behind this modal is where
   * it is changed
   * (decision `2026-09-02-a-stop-the-section-asked-for-is-not-a-stop-the-viewer-made`).
   */
  const effectiveHistory =
    item.effective_watch_history ??
    item.watch_history ??
    setInfo?.watch_history ??
    "provider"
  const isReplayedEverySitting =
    effectiveHistory === "provider" &&
    (startMs != null || endMs != null)

  return (
    <Modal
      dataProvider={setInfo?.provider_kind || undefined}
      footer={
        <>
          <Button
            appearance="outline"
            hidden={!stored}
            id="section-clear"
            intent="neutral"
            onClick={() => void commitSection(entry, null)}
          >
            Clear — play the whole item
          </Button>
          <span className="spacer" />
          <Button
            appearance="outline"
            id="section-cancel"
            intent="neutral"
            onClick={closeSectionModal}
          >
            Cancel
          </Button>
          <Button
            id="section-save"
            intent="accent"
            type="submit"
          >
            Save
          </Button>
        </>
      }
      id="sectionmodal"
      isOpen
      onClose={closeSectionModal}
      onSubmit={() => void commitSection(entry, readForm())}
      title={`Section of “${item.title}”`}
      titleId="sectionmodal-title"
    >
      <p className="subhint">{applyVocab(HINT, vocab)}</p>

      <div className="field" id="section-typebox">
        <span className="fieldlabel">
          Start and end marks
        </span>
        {/* No `error` prop, deliberately — `Field`/`FieldGroup` own the semantic error and
            this component owns only its echo, which it renders under the fields in a live
            region. A refused value stays exactly as typed and says why, so nothing here
            re-states it. */}
        <TimecodeInput
          durationMs={duration ?? undefined}
          isRange
          key={seed}
          label="Section"
          onChange={(value) => {
            if (value === null) {
              setStartMs(null)
              setEndMs(null)

              return
            }

            // `number` is single mode's shape and cannot arrive here. Handled anyway, so the
            // branch is total rather than cast away.
            if (typeof value === "number") {
              setStartMs(value)

              return
            }

            const range = value as TimecodeRange

            setStartMs(range.start)
            setEndMs(range.end)
          }}
          stepMs={STEP_MS}
          valueMs={{ end: endMs, start: startMs }}
        />
      </div>

      {duration == null ? (
        // No runtime, no bar. A slider needs a scale, and inventing one — a fixed two hours,
        // or the largest mark typed so far — would draw a proportion that is not true of this
        // item. The two input routes that need no scale are still here, so the modal works.
        <p className="idnote" id="section-noduration">
          {applyVocab(
            "The runtime of this item is not known, so there is no bar to drag and no upper limit on either mark. Type the marks, or capture them from the player.",
            vocab,
          )}
        </p>
      ) : (
        <div className="field" id="section-dragbox">
          <span className="fieldlabel">
            Drag the section
          </span>
          {/* `onChange` PAINTS and `onChangeEnd` COMMITS the seed — the split the component
              states. Re-keying the fields on every pointer sample would remount them dozens
              of times per drag; once on release is what "typing moves the thumbs, dragging
              moves the fields" costs. */}
          <RangeSlider
            intent="accent"
            label="Section"
            max={duration}
            min={0}
            onChange={applyDrag}
            onChangeEnd={(value) => {
              applyDrag(value)
              setSeed((n) => n + 1)
            }}
            step={STEP_MS}
            value={{
              end: endMs ?? duration,
              start: startMs ?? 0,
            }}
            valueFormat={(ms) =>
              formatTimecode(ms, {
                isHoursShown: duration >= 3_600_000,
                millisecondDigits: 0,
              })
            }
          />
        </div>
      )}

      <div className="field" id="section-capturebox">
        <span className="fieldlabel">
          Capture from the player
        </span>
        <div className="fieldrow">
          {/* Disabled rather than absent: this is a TRANSIENT state, not a missing
              capability. The buttons come alive the moment this entry is on screen, and the
              line underneath says which of the three reasons is in force — a control that is
              simply gone teaches nobody that playing the item would bring it back. */}
          <Button
            appearance="outline"
            id="section-capture-start"
            intent="neutral"
            isDisabled={livePositionMs == null}
            onClick={() => {
              capture("start")
            }}
            size="sm"
          >
            Start here
          </Button>
          <Button
            appearance="outline"
            id="section-capture-end"
            intent="neutral"
            isDisabled={livePositionMs == null}
            onClick={() => {
              capture("end")
            }}
            size="sm"
          >
            End here
          </Button>
        </div>
        <span
          className="fieldhint"
          id="section-capturenote"
        >
          {captureNote}
        </span>
      </div>

      <p className="idnote" id="section-summary">
        {isChanged
          ? `Will play ${sectionSummary(readForm(), duration)}.`
          : `Plays ${sectionSummary(stored, duration)}.`}
      </p>

      {isReplayedEverySitting ? (
        <p className="idnote" id="section-historynote">
          This queue keeps its watch history in Plex, and
          Plex judges a part-played item as unwatched — so
          this entry never completes and plays its section
          again every sitting. Change it to a separate
          QueuePilot history in this entry’s settings to
          have the section count as finished.
        </p>
      ) : null}
    </Modal>
  )
}

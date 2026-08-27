import {
  Board,
  type BoardItem,
  type BoardLane,
  type BoardMove,
  EmptyState,
} from "@charcuterie/ui"
import { useMemo } from "react"
import {
  byTray,
  type Candidate,
  candidates,
  moveToTray,
  TRAYS,
  type TrayKey,
} from "../lib/people"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "../lib/types"
import { PersonFace } from "./PersonFace"

/**
 * THE QUEUE EDITOR — Option B, Two trays.
 *
 * Every person in the house is a card, in one of three places: **Must be here**, **Nice to
 * have**, **Everyone else**. Moving somebody is one action and nothing about a queue's
 * membership is hidden behind a tap
 * (decision `2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster`).
 *
 * ### The shape is Charcuterie's, not this app's
 *
 * This is a `Board` — three lanes, cards, and a move handle. The house rule is that a shared
 * shape is built in the library first, and this one already was, for Docket. Adopting it buys
 * three things this screen would otherwise have had to get right by hand, and the third is the
 * one the decision insists on:
 *
 *  1. **Container queries, not media queries.** A lane in a three-up board is ~500px on a 4K
 *     display, so window width says nothing about the room a card has. The Narrow View falls
 *     out of the same rule rather than being a second layout.
 *  2. **No horizontal scroll at any width.** Below `cq-lg` the board becomes one lane plus a
 *     segmented control naming the others, never a pan surface.
 *  3. **EVERY DRAG HAS A TAP FALLBACK, and it is the primary path.** *"Drag is poor on a touch
 *     display, so every drag needs a tap fallback."* `BoardCard`'s handle is a button first:
 *     pressing it opens a `Menu` of the other lanes, which is the only path that works from
 *     the keyboard, from a screen reader, and in the Narrow View where the other trays are not
 *     on screen to drop onto. Dragging is layered on the same handle and commits through the
 *     same callback, so there is one code path and neither is a fallback for the other.
 *
 * What this file owns is the DATA: which cards exist, what a group's rule says, and what a
 * move means. It paints no lane and implements no drag.
 *
 * ### There is no name control here, on purpose
 *
 * The mockup drew a "Name it for me" / "I will name it" switch, a written-name preview and a
 * revert control, in all three options. None of them ship — the name is the activity and the
 * people are the badges
 * (decision `2026-08-25-a-queue-is-people-plus-an-activity` §4). Do not add one back.
 */
export function PeopleTrays({
  groups,
  isBusy = false,
  members,
  onChange,
  people,
}: {
  people: readonly Person[]
  groups: readonly GroupWithRoster[]
  members: readonly QueueMember[]
  /** The WHOLE new member list. The write is all-or-nothing — that is the only way the editor
   *  can say "everybody back to Everyone else". */
  onChange: (members: QueueMember[]) => void
  isBusy?: boolean
}) {
  const all = useMemo(
    () => candidates(people, groups),
    [people, groups],
  )
  const lanes = useMemo(
    () => byTray(all, members),
    [all, members],
  )

  if (all.length === 0) {
    // Not a failure state. The people table is empty until the owner confirms the mapping
    // file in `/config`, and saying so beats three empty lanes that look broken.
    return (
      <EmptyState
        description="Confirm the people mapping file in the config directory and restart, and the whole house appears here as cards."
        heading="Nobody is in the roster yet"
        headingLevel={4}
        size="sm"
      />
    )
  }

  const toItem = (candidate: Candidate): BoardItem => ({
    key: `${candidate.kind}:${candidate.id}`,
    // The circle rides in `marks`, which is the slot `BoardCard` renders immediately before
    // the title — and it is `aria-hidden`, so the title beside it is the accessible name.
    marks: (
      <PersonFace
        id={candidate.id}
        label={candidate.label}
      />
    ),
    // A group's rule in words, under the title. "At least one of Ada, Grace. Linus may join."
    // The count is the whole reason a group is one card instead of three, so it is never
    // hidden behind a hover.
    ...(candidate.rule
      ? {
          footer: (
            <span className="trayrule">
              {candidate.rule}
            </span>
          ),
        }
      : {}),
    title: candidate.label,
  })

  const laneFor = (key: TrayKey): BoardLane => {
    const tray = TRAYS.find((t) => t.key === key)

    return {
      emptyState: (
        <EmptyState
          description={tray?.help ?? ""}
          heading="Nobody here"
          headingLevel={5}
          size="sm"
        />
      ),
      items: lanes[key].map(toItem),
      key,
      label: tray?.label ?? key,
    }
  }

  const onMove = (move: BoardMove): void => {
    if (isBusy) return
    const [kind, ...rest] = move.itemKey.split(":")
    const id = rest.join(":")
    if (kind !== "person" && kind !== "group") return

    onChange(
      moveToTray(
        members,
        { id, kind },
        move.toLaneKey as TrayKey,
        move.toIndex,
      ),
    )
  }

  return (
    <Board
      headingLevel={4}
      label="Who is this queue for"
      lanes={[
        laneFor("required"),
        laneFor("optional"),
        laneFor("roster"),
      ]}
      // `≡` — this app's grip glyph, the same one `QueuesView` and `PlayView` use — and the
      // library now shows it ONLY while the three trays are side by side. Under the board's
      // `cq-lg` it swaps itself for the word "Move" on its own.
      //
      // That split is the whole history of this line, and it took two reports to find. The
      // handle wore `≡` at every width and the modal was too narrow for three lanes, so the
      // glyph promised a drag with nowhere to land: *"I can't seem to drag 'n drop the names
      // from Everyone Else anywhere else. There's no right-click or anything. How do I move
      // these?"* The first fix dropped the glyph at every width, which broke the wide board
      // instead: *"I think the drag handles were fine, but now you have it in a 3-column mode,
      // so dragging would work, but it has this 'move' button instead."*
      //
      // So the rule is not "glyph" or "word" — it is that the handle wears the gesture that
      // can succeed, and only the BOARD knows which that is. It moved into `@charcuterie/ui`
      // for that reason (`2026-08-27-the-move-handle-wears-the-gesture-that-can-succeed`), and
      // this app is back to passing the glyph it owns
      // (decision `2026-08-27-the-tray-move-handle-wears-the-gesture-that-can-succeed`).
      //
      // ⚠️ This needs `#dynmodal` to stay wide enough for three lanes — see `app.css`. Narrow
      // that modal again and the trays go back to one lane, where the word is what shows.
      moveIcon="≡"
      narrowLaneKey="required"
      onMove={onMove}
    />
  )
}

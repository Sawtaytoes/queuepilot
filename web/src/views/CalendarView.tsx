import { Button, EmptyState } from "@charcuterie/ui"
import { useMemo, useState } from "react"

import { SelectListbox } from "../components/SelectListbox"
import {
  queueNumbers,
  queuePeopleLabel,
  queueTitle,
} from "../lib/people"
import { parseSeasonDay } from "../lib/season"
import type { RegistrySet } from "../lib/types"
import { usePeople } from "../state/people"
import { useStore } from "../state/store"
import { CalendarRow } from "./CalendarRow"
import styles from "./CalendarView.module.css"

/**
 * THE CALENDAR — every queue that has a date, and the dates it keeps.
 *
 * It is the SECOND editor for two settings that already exist, and it is a first-class one:
 * changing a date here writes exactly what the Set editor writes
 * (decision `2026-09-08-a-calendar-view-is-a-second-editor-for-date-based-queue-settings`).
 * Five rules come from that record, and four of them are cheap to get wrong:
 *
 *   1. **IT EDITS.** A read-only summary was rejected — a screen that shows a wrong date and
 *      cannot fix it sends the reader somewhere else to fix it.
 *   2. **NEITHER SURFACE OWNS THE VALUE.** The set is the single source of truth and both
 *      editors PATCH it. There is no calendar-only field and no second store; this file holds
 *      draft state for a row being edited and nothing else.
 *   3. **A QUEUE WITH NO DATES DOES NOT APPEAR.** This is a list of scheduled queues, not a
 *      roster of every queue with two empty columns. The picker at the top is what puts a
 *      queue ON the calendar, since otherwise a queue could only get its first date from the
 *      Set editor.
 *   4. **ONE COLUMN AT EVERY WIDTH.** A row is a queue's name, its dates and what happens on
 *      them — prose, and prose is scanned down a column. That is the narrowed grid rule, not
 *      an exception to it, and it is why there is no month-grid wall calendar here either.
 *   5. **A REAL ROUTE.** `/calendar`, in `routePaths.ts` and in `App.tsx`'s table.
 *
 * ⚠️ **NOTHING HERE RE-DERIVES A CALENDAR RULE.** `is_in_season` is the SERVER's answer,
 * computed on the read that produced the row, and `SeasonMark` is the one component that
 * prints it. This file compares no date to today, and there is no timer, no `setInterval` and
 * no poll: both features are evaluated on a read and that is the decision, in both records.
 */
export function CalendarView() {
  const { reg } = useStore()
  const people = usePeople()

  /**
   * Queues being GIVEN their first date right now.
   *
   * A queue with no dates does not appear (rule 3), which is also true the instant a row is
   * cleared — so a row would vanish under the hand that cleared it, and a queue picked from
   * the Add control would never appear at all. Both stay listed until the page is left. It is
   * session state and never a stored field: the set is the source of truth, and "I am editing
   * this" is not a fact about the set.
   */
  const [openIds, setOpenIds] = useState<readonly string[]>(
    [],
  )
  const [addId, setAddId] = useState("")
  /** The Add picker's SECOND WRITER — it is cleared by the Add itself, never by its own value
   *  (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`). */
  const [addCount, setAddCount] = useState(0)

  const sets = useMemo(() => reg?.sets ?? [], [reg])

  /** Numbered over the sets THIS PAGE draws, in the order it draws them — the same rule the
   *  shelves use. A number is how you tell two cards apart, so it only means anything among
   *  the cards somebody can see at once. */
  const numbers = useMemo(
    () => queueNumbers(sets, people.byQueue),
    [people.byQueue, sets],
  )

  const scheduled = useMemo(
    () =>
      sets
        .filter(
          (set) =>
            hasDates(set) || openIds.includes(set.id),
        )
        .sort(byFirstDate),
    [openIds, sets],
  )

  const unscheduled = useMemo(
    () =>
      sets.filter(
        (set) =>
          !hasDates(set) && !openIds.includes(set.id),
      ),
    [openIds, sets],
  )

  const addOptions = useMemo(
    () => [
      {
        label: "Choose a queue…",
        value: "",
      },
      ...unscheduled.map((set) => ({
        // A list of queues NAMES ITS PEOPLE: every displayed name is an activity now, so four
        // rows would read "Movies & Shows" four times. A picker option cannot hold faces, so
        // it takes the text form (decision `2026-08-25-a-queue-is-people-plus-an-activity`).
        badge: queuePeopleLabel(
          people.byQueue[set.id] ?? [],
          people.people,
          people.groups,
        ),
        label: queueTitle(set, numbers.get(set.id) ?? null),
        value: set.id,
      })),
    ],
    [numbers, people, unscheduled],
  )

  return (
    <div className="view" id="calendar">
      <section
        aria-labelledby="calendar-add-heading"
        className={styles.addSection}
      >
        <h2 className="tlabel" id="calendar-add-heading">
          Put a queue on the calendar
        </h2>
        <p className={styles.hint}>
          A queue appears here once it has a date. Choose
          one to give it its first — the setting is the
          queue&rsquo;s own, so this and the queue&rsquo;s
          own editor write the same value.
        </p>
        <div className={styles.addRow}>
          <SelectListbox
            id="calendar-add"
            key={`calendar-add-${addCount}`}
            label="Queue to schedule"
            onChange={setAddId}
            options={addOptions}
            value={addId}
          />
          <Button
            id="calendar-add-go"
            isDisabled={!addId}
            onClick={() => {
              if (!addId) return
              setOpenIds((prev) =>
                prev.includes(addId)
                  ? prev
                  : [...prev, addId],
              )
              setAddId("")
              setAddCount((count) => count + 1)
            }}
          >
            Add to the calendar
          </Button>
        </div>
      </section>

      {scheduled.length === 0 ? (
        <EmptyState
          description="Nothing is scheduled yet. Put a queue on the calendar above, or give one a date in its own editor, and it appears here."
          heading="No queue has a date"
          headingLevel={2}
        />
      ) : (
        <ul className={styles.rows} id="calendar-rows">
          {scheduled.map((set) => (
            <CalendarRow
              groups={people.groups}
              /* KEYED ON ITS SECOND WRITER — the stored dates, which only the SERVER changes
                 (this row's own save, an undo, a live update, a hand edit over SMB). The row's
                 pickers are seeded controls, so a value replaced underneath them has to
                 remount to keep the panel's checkmark true; keying on the value the user is
                 editing would remount the control under their own focus
                 (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`). */
              key={`${set.id}:${set.season_start ?? ""}:${set.season_end ?? ""}:${set.reset_watched_on ?? ""}`}
              members={people.byQueue[set.id] ?? []}
              people={people.people}
              set={set}
              title={queueTitle(
                set,
                numbers.get(set.id) ?? null,
              )}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** A set is ON the calendar when it carries either date. A half-written season window cannot
 *  reach the browser — the writer refuses one by name — so the pair is read as a pair. */
function hasDates(set: RegistrySet): boolean {
  return Boolean(
    set.reset_watched_on ||
      (set.season_start && set.season_end),
  )
}

/** `MM-DD` as one comparable integer: 1001 for 1 October. Month-major, so it sorts the
 *  calendar without a year to hang the dates on. */
function ordinalOf(
  value: string | null | undefined,
): number {
  const parsed = parseSeasonDay(value)

  return parsed ? parsed.month * 100 + parsed.day : 9999
}

/**
 * Calendar order, January to December, on the earliest date a row carries.
 *
 * It is a SORT and not the availability rule: it asks nothing about today, so the page reads
 * the same at every hour and a screenshot of it is reproducible. Ordering by "which comes
 * round next" would re-order the list every midnight and tell the reader less — the question
 * this page answers is "what is scheduled this year".
 *
 * A row with no date yet is one somebody is filling in right now, so it sorts to the top where
 * they are looking.
 */
function byFirstDate(
  left: RegistrySet,
  right: RegistrySet,
): number {
  const first = (set: RegistrySet) =>
    Math.min(
      ordinalOf(set.season_start),
      ordinalOf(set.reset_watched_on),
    )

  return first(left) - first(right)
}

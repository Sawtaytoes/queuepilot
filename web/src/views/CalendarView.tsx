import {
  Alert,
  Button,
  ButtonLink,
  Card,
  EmptyState,
} from "@charcuterie/ui"
import { useMemo, useState } from "react"

import { QueuePeopleBadge } from "../components/QueuePeopleBadge"
import { SeasonMark } from "../components/SeasonMark"
import { SelectListbox } from "../components/SelectListbox"
import { api } from "../lib/api"
import {
  clampDay,
  dayOptions,
  monthOptions,
} from "../lib/monthDay"
import {
  queueNumbers,
  queuePeopleLabel,
  queueTitle,
} from "../lib/people"
import {
  parseSeasonDay,
  seasonDayLabel,
  seasonDayValue,
} from "../lib/season"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
  RegistrySet,
} from "../lib/types"
import { usePeople } from "../state/people"
import { load, setStatus, useStore } from "../state/store"
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
  a: RegistrySet,
  b: RegistrySet,
): number {
  const first = (set: RegistrySet) =>
    Math.min(
      ordinalOf(set.season_start),
      ordinalOf(set.reset_watched_on),
    )

  return first(a) - first(b)
}

type Draft = {
  seasonStartMonth: string
  seasonStartDay: string
  seasonEndMonth: string
  seasonEndDay: string
  resetMonth: string
  resetDay: string
}

/** Every field of a draft, so "has this row been edited" is a comparison rather than a
 *  hand-maintained list that a seventh control would silently fall out of. */
const KEYS = [
  "resetDay",
  "resetMonth",
  "seasonEndDay",
  "seasonEndMonth",
  "seasonStartDay",
  "seasonStartMonth",
] as const satisfies readonly (keyof Draft)[]

const draftOf = (set: RegistrySet): Draft => {
  const start = parseSeasonDay(set.season_start)
  const end = parseSeasonDay(set.season_end)
  const reset = parseSeasonDay(set.reset_watched_on)

  return {
    resetDay: reset ? String(reset.day) : "1",
    resetMonth: reset ? String(reset.month) : "",
    seasonEndDay: end ? String(end.day) : "",
    seasonEndMonth: end ? String(end.month) : "",
    seasonStartDay: start ? String(start.day) : "",
    seasonStartMonth: start ? String(start.month) : "",
  }
}

const SEASON_MONTH_OPTIONS = monthOptions({
  emptyLabel: "—",
})

const RESET_MONTH_OPTIONS = monthOptions({
  emptyLabel: "Never",
  isLongName: true,
})

/**
 * ONE QUEUE'S ROW: what it is called, who it is for, what its dates are, and both editors.
 *
 * `Card` and not a box painted here — the library owns the shape, the module stylesheet owns
 * only where things sit inside it
 * (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`).
 */
function CalendarRow({
  groups,
  members,
  people,
  set,
  title,
}: {
  groups: readonly GroupWithRoster[]
  members: readonly QueueMember[]
  people: readonly Person[]
  set: RegistrySet
  title: string
}) {
  // The row REMOUNTS when the server's answer changes (see its key), so this seed is read once
  // and `stored` cannot drift from it while the row is alive.
  const stored = useMemo(() => draftOf(set), [set])
  const [draft, setDraft] = useState<Draft>(stored)
  const [isSaving, setIsSaving] = useState(false)

  const isDirty = KEYS.some(
    (field) => draft[field] !== stored[field],
  )

  // `reset_watched_on` is CURATED-ONLY on the server: a rotation pool owns no done flags, no
  // queue_entry_history and no lead cooldowns, which is all three of the things a reset
  // clears. Offering the control here would be offering a value the API refuses.
  const isResettable = set.source === "queue"

  const patch = (change: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...change }))
  }

  const onSave = async () => {
    const error = pairError(draft)
    if (error) {
      setStatus(error, "err")

      return
    }

    setIsSaving(true)
    try {
      const body: Record<string, string> = {
        // Sent as a PAIR, always both, because the pair rule lives on the writer: it refuses a
        // half-written window by name rather than guessing an open end. Two blanks clear it.
        season_end: seasonDayValue(
          draft.seasonEndMonth,
          draft.seasonEndDay,
        ),
        season_start: seasonDayValue(
          draft.seasonStartMonth,
          draft.seasonStartDay,
        ),
      }
      if (isResettable) {
        // An empty string drops the key server-side, so a queue that never carried a reset
        // date stays byte-identical on disk.
        body.reset_watched_on = draft.resetMonth
          ? seasonDayValue(draft.resetMonth, draft.resetDay)
          : ""
      }
      await api("PATCH", `/api/sets/${set.id}`, body)
      // The store re-read FIRST, and the toast after it. `load()` opens with its own
      // "Loading…" status and closes with "Ready", so a message set before it is overwritten
      // before anybody reads it — which is why this row says "saved" only once the store
      // agrees that it is.
      await load()
      setStatus(`${title} — dates saved`, "ok")
    } catch (e) {
      setStatus(String(e), "err")
    } finally {
      setIsSaving(false)
    }
  }

  const seasonWords =
    set.season_start && set.season_end
      ? `In season ${seasonDayLabel(set.season_start)} to ${seasonDayLabel(set.season_end)}, every year.`
      : "Available all year."
  const resetWords = set.reset_watched_on
    ? `Clears its own watched state each year on ${seasonDayLabel(set.reset_watched_on)}, on the first play after that date.`
    : "Never clears its watched state."
  const isTtlDefeatingReset = Boolean(
    set.reset_watched_on &&
      set.remove_completed_after &&
      !RESET_OFF_WORDS.includes(
        set.remove_completed_after.trim().toLowerCase(),
      ),
  )

  return (
    <li className={styles.row}>
      <Card
        actions={
          <ButtonLink
            appearance="outline"
            href={
              set.source === "queue"
                ? `/q/${set.id}`
                : `/channels/${set.id}`
            }
            size="sm"
          >
            Open queue
          </ButtonLink>
        }
        heading={title}
        headingLevel={3}
        padding="md"
        surface="raised"
      >
        <div
          className={styles.body}
          data-set={set.id}
          id={`calendar-row-${set.id}`}
        >
          <div className={styles.meta}>
            <QueuePeopleBadge
              groups={groups}
              members={members}
              people={people}
            />
            <SeasonMark set={set} />
          </div>

          <p className={styles.summary}>
            {seasonWords} {isResettable ? resetWords : null}
          </p>

          {/* `remove_completed_after` DEFEATS a reset date, silently: it DELETES a finished
              entry rather than tagging one, so a seasonal queue with a TTL has nothing left to
              reset when the date arrives. The Set editor says so where the two sit, and this
              screen is the other place somebody reads a reset date. An `Alert`, because it is
              one, and because a paragraph painted warning-coloured by this file would be a
              control drawn by an app class. */}
          {isTtlDefeatingReset ? (
            <Alert
              className={styles.warning}
              description="It deletes a finished entry instead of tagging it, so there is nothing left here to reset. Clear that field in the queue's own editor."
              heading={`Finished entries are removed after ${set.remove_completed_after}, which defeats the reset date.`}
              intent="warning"
              size="sm"
            />
          ) : null}

          <div className={styles.dates}>
            <div className={styles.dateGroup}>
              <span className={styles.dateLabel}>
                In season from
              </span>
              <span className={styles.datePair}>
                <SelectListbox
                  id={`calendar-${set.id}-season-start-month`}
                  label="Season start month"
                  onChange={(value) =>
                    patch({
                      seasonStartDay: onMonthChange(
                        value,
                        draft.seasonStartDay,
                      ),
                      seasonStartMonth: value,
                    })
                  }
                  options={SEASON_MONTH_OPTIONS}
                  size="sm"
                  value={draft.seasonStartMonth}
                />
                <SelectListbox
                  id={`calendar-${set.id}-season-start-day`}
                  isDisabled={!draft.seasonStartMonth}
                  /* Keyed on the MONTH: the day list narrows with it, so a stored 31 has to be
                   re-seeded when the window moves to a 30-day month. */
                  key={`ssd-${draft.seasonStartMonth}`}
                  label="Season start day"
                  onChange={(value) =>
                    patch({ seasonStartDay: value })
                  }
                  options={dayOptions(
                    draft.seasonStartMonth,
                  )}
                  /* An unchosen day reads "—", not the first option's "1". `Picker` falls back
                   to the first label when a value matches nothing, and a control that says
                   "1" while holding nothing is a control that has answered a question nobody
                   asked. */
                  placeholder="—"
                  size="sm"
                  value={draft.seasonStartDay}
                />
              </span>
              {/* "to" travels with the END of the window rather than the start, so a wrap
                  reads "Jun 1 / to Aug 31" instead of leaving the word stranded. */}
              <span className={styles.datePair}>
                <span className={styles.dateTo}>to</span>
                <SelectListbox
                  id={`calendar-${set.id}-season-end-month`}
                  label="Season end month"
                  onChange={(value) =>
                    patch({
                      seasonEndDay: onMonthChange(
                        value,
                        draft.seasonEndDay,
                      ),
                      seasonEndMonth: value,
                    })
                  }
                  options={SEASON_MONTH_OPTIONS}
                  size="sm"
                  value={draft.seasonEndMonth}
                />
                <SelectListbox
                  id={`calendar-${set.id}-season-end-day`}
                  isDisabled={!draft.seasonEndMonth}
                  key={`sed-${draft.seasonEndMonth}`}
                  label="Season end day"
                  onChange={(value) =>
                    patch({ seasonEndDay: value })
                  }
                  options={dayOptions(draft.seasonEndMonth)}
                  placeholder="—"
                  size="sm"
                  value={draft.seasonEndDay}
                />
              </span>
            </div>

            {isResettable ? (
              <div className={styles.dateGroup}>
                <span className={styles.dateLabel}>
                  Clear watched state each year on
                </span>
                <span className={styles.datePair}>
                  <SelectListbox
                    id={`calendar-${set.id}-reset-month`}
                    label="Reset month"
                    onChange={(value) =>
                      patch({
                        resetDay: clampDay(
                          value,
                          draft.resetDay,
                        ),
                        resetMonth: value,
                      })
                    }
                    options={RESET_MONTH_OPTIONS}
                    size="sm"
                    value={draft.resetMonth}
                  />
                  <SelectListbox
                    id={`calendar-${set.id}-reset-day`}
                    isDisabled={!draft.resetMonth}
                    key={`rd-${draft.resetMonth}`}
                    label="Reset day"
                    onChange={(value) =>
                      patch({ resetDay: value })
                    }
                    options={dayOptions(draft.resetMonth)}
                    size="sm"
                    value={draft.resetDay}
                  />
                </span>
              </div>
            ) : null}
          </div>

          <div className={styles.actions}>
            <Button
              id={`calendar-${set.id}-save`}
              isDisabled={!isDirty}
              isLoading={isSaving}
              loadingLabel="Saving the dates"
              onClick={() => {
                void onSave()
              }}
              size="sm"
            >
              Save dates
            </Button>
            <Button
              appearance="ghost"
              isDisabled={!isDirty || isSaving}
              onClick={() => setDraft(stored)}
              size="sm"
            >
              Revert
            </Button>
          </div>
        </div>
      </Card>
    </li>
  )
}

/** The words the server accepts for "no reset", mirrored so a hand-edited TTL of `never` does
 *  not raise the warning the real one deserves. */
const RESET_OFF_WORDS = [
  "0",
  "disabled",
  "never",
  "none",
  "off",
]

/** Choosing a month is the DAY's second writer. A month chosen where none was seeds day 1
 *  rather than leaving a half-written date that the writer would refuse; a month cleared takes
 *  its day with it; a narrower month clamps. */
function onMonthChange(month: string, day: string): string {
  if (!month) return ""
  if (!day) return "1"

  return clampDay(month, day)
}

/**
 * The one thing this editor refuses before it asks the server: HALF a season window.
 *
 * The server refuses it too, by name, and that is where the rule lives. Catching it here is
 * about what `seasonDayValue` would otherwise do on the way — it answers `""` for a month with
 * no day, so a half-filled pair would reach the API as two blanks and CLEAR the window
 * silently, which is the one outcome nobody asked for.
 */
function pairError(draft: Draft): string | null {
  const start = seasonDayValue(
    draft.seasonStartMonth,
    draft.seasonStartDay,
  )
  const end = seasonDayValue(
    draft.seasonEndMonth,
    draft.seasonEndDay,
  )
  const isStartTyped = Boolean(
    draft.seasonStartMonth || draft.seasonStartDay,
  )
  const isEndTyped = Boolean(
    draft.seasonEndMonth || draft.seasonEndDay,
  )
  if (!isStartTyped && !isEndTyped) return null
  if (start && end) return null

  return "A season window needs BOTH a start and an end date. Choose the missing one, or clear both months to make the queue available all year."
}

import {
  EmptyState,
  RadioGroup,
  SegmentedControl,
} from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"

import { CheckboxGroup } from "../components/CheckboxGroup"
import { GuestStepper } from "../components/GuestStepper"
import { PersonFace } from "../components/PersonFace"
import { SelectListbox } from "../components/SelectListbox"
import { api } from "../lib/api"
import { writePickSession } from "../lib/pickSession"
import { WATCH_PLAY_PATH } from "../lib/routePaths"
import {
  ACTIVITIES,
  ACTIVITY_FILTERS,
  type ActivityId,
  defaultFilterValues,
  defaultModeFor,
  findActivity,
  queuesForTonight,
  rosterOrder,
  type SessionMode,
  type TonightQueue,
  tonightQueues,
} from "../lib/tonight"
import { drawTonight } from "../lib/tonightDraw"
import { parseTonightPreset } from "../lib/tonightPreset"
import type {
  BoardGameCategoriesResponse,
  GroupWithRoster,
  PeopleResponse,
  Person,
} from "../lib/types"
import { usePeople } from "../state/people"
import { useStore } from "../state/store"
import { CategoryFilter } from "./CategoryFilter"
import { GoButton } from "./GoButton"
import { SurpriseStep } from "./SurpriseStep"
import { WhichQueue } from "./WhichQueue"

/**
 * TONIGHT — who's here, what you are doing, and Go.
 *
 * A NEW route beside the existing landing rather than a replacement for it, so the app stays
 * usable while the absorb is built out.
 *
 * ## The order of the form is FIXED, and it is not a design choice
 *
 * (`2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick` §5 and §8.)
 *
 *   1. **Who's here** — the known-people checklist, plus a guests stepper for anonymous
 *      seats. Guests get no roster rows.
 *   2. **Activity** — six tiles, **Surprise Me last**, and no provider brand on any of them.
 *   3. **Filters** — ONLY on Pick. There is never a second "Mode" row.
 *   4. **Pick | Queues** — the segment, above Go, defaulted by the activity.
 *   5. **Which queue?** — only on Queues, right after the activity. One match is implied
 *      rather than asked; two or more force a choice; zero shows an empty state.
 *   6. **Go.**
 *
 * Step 5 lands "right after the activity" without moving in the DOM, and that is why the
 * order above reads as a contradiction and is not one: filters are Pick-only, so on Queues
 * step 3 renders nothing and the queue chooser is the next thing under the tiles.
 *
 * ## Choosing people is a FILTER. Nothing here detects presence
 *
 * Ticking a name narrows the queue list the way a search field does. It is not a claim that
 * anybody is in the room, and no part of this screen may imply that it is
 * (`2026-08-25-a-queue-is-people-plus-an-activity` §5). Two consequences that look like
 * bugs and are not: an empty selection filters nothing, and **NFC bypasses this screen
 * entirely** — a card goes straight to its queue and always did.
 *
 * ## Pick and Queues answer the same question, and they answer it the same way
 *
 * Pick has been people-aware server-side since WP-7. The Which queue? list was not: it
 * showed EVERY queue for an activity, so ticking two people narrowed the draw and left the
 * list beside it untouched. Both halves now read the same rule over the same data — a
 * queue's trays from `GET /api/queue-people`, and every group's own count from
 * `GET /api/people` — so a queue offered here is a queue Pick would draw.
 *
 * Three consequences that look like bugs and are not:
 *
 *   1. **Nobody ticked shows everything.** A filter with nothing in it matches everything.
 *   2. **A queue with NOBODY on it is always offered.** Several queues legitimately have no
 *      people filed, and hiding them would make them unreachable.
 *   3. **NFC bypasses this screen entirely** — a card goes straight to its queue.
 *
 * Surprise Me has its own second screen. Its three approved scopes choose an activity first,
 * then delegate to that activity's existing picker.
 */
export function TonightView({
  step,
}: {
  step: "go" | "surprise" | null
}) {
  const navigate = useNavigate()
  const { reg } = useStore()
  const { byQueue } = usePeople()

  const [people, setPeople] = useState<Person[]>([])
  /**
   * Every group's roster and its own count, off the SAME response as the roster.
   *
   * A group on a queue is NOT flattened to its people — "at least one of the kids" is a
   * set, a number and a spare — so the filter needs the rule as well as the names.
   */
  const [groups, setGroups] = useState<GroupWithRoster[]>(
    [],
  )
  const [peopleError, setPeopleError] = useState<
    string | null
  >(null)
  const [boardGameCategories, setBoardGameCategories] =
    useState<string[] | null>(null)
  const [
    boardGameCategoriesError,
    setBoardGameCategoriesError,
  ] = useState<string | null>(null)
  const [selectedPeople, setSelectedPeople] = useState<
    string[]
  >([])
  const [guestCount, setGuestCount] = useState(0)

  /**
   * The activity, the mode and the filters move TOGETHER, in one handler.
   *
   * ⚠️ Not three `useState`s updated from three places. `SegmentedControl` seeds its value
   * on mount and a keyed remount does NOT call back, so a mode set in an effect after the
   * activity changed would repaint the segment on the new default while this component
   * still believed the old one. Setting all three in the same handler is the fix, and it is
   * WP-0's finding rather than a preference.
   *
   * The first tile is selected from the start because `RadioGroup` selects its first option
   * when it is given none — the paint and the state have to agree on the first frame, and
   * the control wins that argument.
   */
  const [session, setSession] = useState<{
    activity: ActivityId
    mode: SessionMode
    filters: Record<string, string>
  }>(() => {
    const first = ACTIVITIES[0]?.id ?? "video-games"

    return {
      activity: first,
      filters: defaultFilterValues(first),
      mode: defaultModeFor(first),
    }
  })

  const [queueId, setQueueId] = useState<string | null>(
    null,
  )

  /**
   * What a PRESET CARD could not do, held on the screen rather than in a toast.
   *
   * A toast is the wrong surface for this: the refusal is the answer to a tap that has
   * already happened, the form under it is mid-load and publishes its own status, and the
   * last writer wins. So the sentence lives in the view, beside the control that can fix it,
   * until the person changes something.
   */
  const [presetNote, setPresetNote] = useState<
    string | null
  >(null)

  const chooseActivity = (id: ActivityId) => {
    // Touching the form answers whatever a preset card could not.
    setPresetNote(null)
    setSession({
      activity: id,
      filters: defaultFilterValues(id),
      mode: defaultModeFor(id),
    })
    setQueueId(null)

    // Surprise Me is a SECOND SCREEN, not a one-tap random pick: you narrow down first and
    // only then does it choose. Every other tile leaves that step.
    navigate(
      id === "surprise"
        ? `${WATCH_PLAY_PATH}/surprise`
        : WATCH_PLAY_PATH,
    )
  }

  // Loaded on mount, which is when this page is opened: the route table mounts a view only
  // on its own route, so no other page pays for a screen nobody asked for.
  useEffect(() => {
    let isCancelled = false

    void api<PeopleResponse>("GET", "/api/people")
      .then((peopleResponse) => {
        if (isCancelled) return
        setPeople(rosterOrder(peopleResponse.people ?? []))
        setGroups(peopleResponse.groups ?? [])
        setPeopleError(null)
      })
      .catch((error: unknown) => {
        if (isCancelled) return
        setPeople([])
        setGroups([])
        // Said out loud rather than rendered as an empty roster: "nobody is in the people
        // table yet" and "the request failed" look identical otherwise, and only one of
        // them is something to go and fix.
        setPeopleError(
          error instanceof Error
            ? error.message
            : String(error),
        )
      })

    return () => {
      isCancelled = true
    }
  }, [])

  // The category vocabulary is owner data, so it is loaded from the board-game store rather
  // than copied into the activity definition. A failed request leaves the control present and
  // reports the failure inside its own panel; it never turns a missing list into a guessed
  // category.
  useEffect(() => {
    let isCancelled = false

    void api<BoardGameCategoriesResponse>(
      "GET",
      "/api/board-games/categories",
    )
      .then((categoriesResponse) => {
        if (isCancelled) return
        setBoardGameCategories(
          categoriesResponse.categories ?? [],
        )
        setBoardGameCategoriesError(null)
      })
      .catch((error: unknown) => {
        if (isCancelled) return
        setBoardGameCategories([])
        setBoardGameCategoriesError(
          error instanceof Error
            ? error.message
            : String(error),
        )
      })

    return () => {
      isCancelled = true
    }
  }, [])

  // The provider's PRODUCT name, off the registry's own vocabulary — no second request, and
  // no table of brand names in this app's source.
  const providerLabels = new Map(
    (reg?.sets ?? []).map((set) => [
      set.provider_kind,
      set.vocabulary?.name ?? "",
    ]),
  )
  // WHO EACH QUEUE IS FOR. One statement for the whole shelf, loaded at boot beside the
  // registry — not one request per queue, and not a second copy of the roster.
  const queues = tonightQueues(
    reg?.sets ?? [],
    providerLabels,
    byQueue,
    people,
    groups,
  )
  const matches = queuesForTonight(
    queues,
    session.activity,
    selectedPeople,
  )

  /**
   * ONE match is implied, not asked. Two or more force a choice, and the first is the
   * standing answer until somebody picks another — again because `RadioGroup` paints its
   * first option as chosen and this component has to agree with it.
   */
  const chosenQueue: TonightQueue | null =
    matches.find((match) => match.id === queueId) ??
    matches[0] ??
    null

  const activity = findActivity(session.activity)
  const filters = ACTIVITY_FILTERS[session.activity]
  const isSurpriseStep = step === "surprise"
  const isQueues = session.mode === "queues"

  /**
   * A PRESET CARD ARRIVING (`/tonight/go?…`).
   *
   * The absorb decision's NFC table says a Pick preset — people and filters baked in — is a
   * card the household may have, and that it must *"land on result card, not an empty
   * form"*. A card is a fixed string on plastic and cannot ask who walked in, so the address
   * carries the answers the form would have collected and this runs the SAME draw the Go
   * button runs (`lib/tonightDraw.ts`).
   *
   * Two things it never does:
   *
   *   * **It never lands on an empty form.** A valid preset draws and replaces itself with
   *     `/result`. A refused one lands on `/tonight` with what the card DID say already
   *     filled in, plus the one sentence saying what is missing.
   *   * **It never guesses who is here.** A card that names nobody is refused by
   *     `parseTonightPreset`, which is brief §5's fourth row — *"bare board games needing
   *     live who's-here: use the app"* — made machine-enforced rather than written down.
   *     Defaulting to "everybody" would pick for a table whose size nobody stated.
   *
   * `replace: true` on both exits: a card's address is a one-shot instruction, and leaving it
   * in the history means Back re-draws it.
   *
   * Keyed on the search string through a ref rather than on the effect's own deps. The view
   * is permanently mounted and toggles `hidden`, StrictMode double-invokes effects in
   * development, and a draw is a POST — running it twice for one tap would burn a reroll's
   * worth of exclusions before the card was ever on screen.
   */
  const presetSearch = useLocation().search
  const drawnPreset = useRef<string | null>(null)

  useEffect(() => {
    if (step !== "go") return
    if (drawnPreset.current === presetSearch) return
    drawnPreset.current = presetSearch

    const parsed = parseTonightPreset(presetSearch)

    // Whatever the card DID say is applied either way, so a refusal is one answer short
    // rather than a blank screen.
    if (parsed.preset) {
      setSelectedPeople([...parsed.preset.personIds])
      setGuestCount(parsed.preset.guestCount)
      setSession({
        activity: parsed.preset.activity,
        filters: parsed.preset.filters,
        mode: defaultModeFor(parsed.preset.activity),
      })
      setQueueId(null)
    }

    if (!parsed.isAccepted) {
      setPresetNote(parsed.reason)
      navigate(
        parsed.preset?.activity === "surprise"
          ? `${WATCH_PLAY_PATH}/surprise`
          : WATCH_PLAY_PATH,
        { replace: true },
      )
      return
    }

    const preset = parsed.preset

    void drawTonight(preset)
      .then((outcome) => {
        if (!outcome.isDrawn) {
          setPresetNote(outcome.reason)
          navigate(WATCH_PLAY_PATH, { replace: true })
          return
        }
        writePickSession(outcome.session)
        navigate("/result", { replace: true })
      })
      .catch((error: unknown) => {
        setPresetNote(
          `Could not pick: ${error instanceof Error ? error.message : String(error)}`,
        )
        navigate(WATCH_PLAY_PATH, { replace: true })
      })
  }, [navigate, presetSearch, step])

  // A PRESET CARD IS NOT A FORM. While the draw is in flight the screen says what it is
  // doing rather than painting the form the card exists to skip — a flash of Who's here
  // under a finger that just tapped plastic reads as "it did not work", and a refused
  // preset navigates to `/tonight` a moment later and renders it properly anyway.
  if (step === "go") {
    return (
      <div className="view" id="tonight">
        <EmptyState
          description="Reading the card, then drawing your pick."
          heading="Setting up your pick…"
        />
      </div>
    )
  }

  return (
    <div className="view" id="tonight">
      {/* 0 — WHAT A PRESET CARD COULD NOT DO. Only ever present after a card sent somebody
          here, and it names the one answer that is missing. */}
      {presetNote ? (
        <p
          className="subhint"
          id="tonight-preset-note"
          role="alert"
        >
          {presetNote}
        </p>
      ) : null}

      {/* 1 — WHO'S HERE. A filter, and the copy says so: this screen knows nothing about
          who is in the room and must never pretend to. */}
      <section className="tsection" id="tonight-people">
        <h2 className="tlabel">Who&rsquo;s here</h2>
        <p className="subhint">
          A filter, not a guest list. Ticking a name narrows
          the queues below — nothing here can tell who is
          actually in the room.
        </p>

        {peopleError ? (
          <p className="subhint" role="alert">
            Could not read the roster: {peopleError}
          </p>
        ) : people.length ? (
          <div className="peoplebox">
            <CheckboxGroup
              checked={selectedPeople}
              id="tonight-roster"
              onToggle={(value, isChecked) => {
                setPresetNote(null)
                setSelectedPeople((prev) =>
                  isChecked
                    ? [...prev, value]
                    : prev.filter((id) => id !== value),
                )
              }}
              options={people.map((person) => ({
                label: (
                  <span className="tonightperson">
                    <PersonFace
                      id={person.id}
                      label={person.displayName}
                    />
                    <span>{person.displayName}</span>
                  </span>
                ),
                value: person.id,
              }))}
              // The ROSTER is this group's second writer — the user's own clicks write
              // `checked`, so keying on that would remount a box under a finger.
              seedKey={people
                .map((person) => person.id)
                .join(",")}
            />
          </div>
        ) : (
          <p className="subhint">
            No people yet. The roster arrives with the
            owner-confirmed import; guests below work
            without it.
          </p>
        )}

        <GuestStepper
          count={guestCount}
          onChange={setGuestCount}
        />
      </section>

      {/* 2 — ACTIVITY. Six tiles, Surprise Me last, and no provider brand on any of them:
          "Video Games" covers MiSTer, Steam, Switch, Wii U and GameCube together, and no
          tile names a device.

          A `RadioGroup`, because that is exactly what this is — one choice out of six, all
          on screen, mutually exclusive, announced as "3 of 6".

          `itemShape="tile"` is the whole box now. WP-6 painted it here — a `.actgrid >
          [role="radio"]` rule giving each option its border, padding and selected surface —
          and said in the same breath that the rule got DELETED rather than adjusted once
          the library had the shape. It does. The grid, the card, the name, the hint and the
          selected edge are all Charcuterie's; what is left in this file is the list. */}
      <section className="tsection" id="tonight-activity">
        <h2 className="tlabel">Activity</h2>
        <RadioGroup
          itemShape="tile"
          items={ACTIVITIES.map((one) => ({
            hint: one.hint,
            label: one.label,
            value: one.id,
          }))}
          label="Activity"
          onChange={(value) =>
            chooseActivity(
              (value ?? "video-games") as ActivityId,
            )
          }
          selectedValue={session.activity}
        />
      </section>

      {isSurpriseStep ? (
        <SurpriseStep
          guestCount={guestCount}
          selectedPeople={selectedPeople}
        />
      ) : (
        <>
          {/* 3 — FILTERS. Pick only. Never a second "Mode" row. */}
          {!isQueues && filters.length ? (
            <section
              className="tsection"
              id="tonight-filters"
            >
              <h2 className="tlabel">
                {activity?.label} filters
              </h2>
              <div className="tfilters">
                {filters.map((filter) => (
                  <div className="tfilter" key={filter.id}>
                    <span className="tfilterlbl">
                      {filter.label}
                    </span>
                    {filter.control === "segment" ? (
                      <SegmentedControl
                        items={filter.options}
                        // The ACTIVITY is the second writer: switching tiles reseeds every
                        // filter, and the control seeds on mount only.
                        key={`${session.activity}:${filter.id}`}
                        label={filter.label}
                        onChange={(value) =>
                          setSession((prev) => ({
                            ...prev,
                            filters: {
                              ...prev.filters,
                              [filter.id]:
                                value ??
                                filter.defaultValue,
                            },
                          }))
                        }
                        selectedValue={
                          session.filters[filter.id]
                        }
                        size="sm"
                      />
                    ) : filter.control === "multiPicker" ? (
                      <CategoryFilter
                        categories={
                          boardGameCategories ?? []
                        }
                        error={boardGameCategoriesError}
                        isLoading={
                          boardGameCategories === null
                        }
                        key={`${session.activity}:${filter.id}`}
                        onChange={(value) =>
                          setSession((prev) => ({
                            ...prev,
                            filters: {
                              ...prev.filters,
                              [filter.id]: value,
                            },
                          }))
                        }
                        value={
                          session.filters[filter.id] ?? ""
                        }
                      />
                    ) : (
                      <SelectListbox
                        id={`tonight-${filter.id}`}
                        key={`${session.activity}:${filter.id}`}
                        label={filter.label}
                        onChange={(value) =>
                          setSession((prev) => ({
                            ...prev,
                            filters: {
                              ...prev.filters,
                              [filter.id]: value,
                            },
                          }))
                        }
                        options={filter.options}
                        value={
                          session.filters[filter.id] ?? ""
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* 4 — PICK | QUEUES. The segment, above Go, defaulted by the activity. It is
              the ONLY mode control on this screen. */}
          <section className="tsection" id="tonight-mode">
            <SegmentedControl
              items={[
                { label: "Pick", value: "pick" },
                { label: "Queues", value: "queues" },
              ]}
              // Keyed on the ACTIVITY — the second writer. Not on `mode`, which the user's
              // own tap writes; keying on that remounts the control under their finger.
              key={session.activity}
              label="How this session runs"
              onChange={(value) => {
                setSession((prev) => ({
                  ...prev,
                  mode:
                    value === "queues" ? "queues" : "pick",
                }))
                setQueueId(null)
              }}
              selectedValue={session.mode}
            />
          </section>

          {/* 5 — WHICH QUEUE? Queues only. */}
          {isQueues ? (
            <WhichQueue
              activityLabel={activity?.label ?? ""}
              chosenQueueId={chosenQueue?.id ?? null}
              hasSelection={selectedPeople.length > 0}
              matches={matches}
              onChoose={setQueueId}
              seedKey={`${session.activity}:${selectedPeople.join(",")}`}
            />
          ) : null}

          {/* 6 — GO. */}
          {/* The SECTION and the BUTTON are different ids on purpose: `#tonight-go` is the
              control the suites drive, and a duplicate on its wrapper would hand every
              `$eval('#tonight-go')` the box instead of the button. */}
          <section
            className="tsection tgo"
            id="tonight-launch"
          >
            <GoButton
              activity={session.activity}
              chosenQueue={isQueues ? chosenQueue : null}
              filters={session.filters}
              guestCount={guestCount}
              isQueues={isQueues}
              selectedPeople={selectedPeople}
            />
          </section>
        </>
      )}
    </div>
  )
}

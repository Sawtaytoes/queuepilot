import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  RadioGroup,
  SegmentedControl,
} from "@charcuterie/ui"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router"

import { CheckboxGroup } from "../components/CheckboxGroup"
import { GuestStepper } from "../components/GuestStepper"
import { SelectListbox } from "../components/SelectListbox"
import { api } from "../lib/api"
import {
  ACTIVITIES,
  ACTIVITY_FILTERS,
  type ActivityId,
  defaultFilterValues,
  defaultModeFor,
  findActivity,
  goLabel,
  isProviderWorthNaming,
  queuesForTonight,
  rosterOrder,
  type SessionMode,
  SURPRISE_SCOPES,
  type TonightQueue,
  tonightQueues,
} from "../lib/tonight"
import type { PeopleResponse, Person } from "../lib/types"
import { openPlayMenu } from "../state/overlays"
import { useStore } from "../state/store"

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
 * ## What is REAL here and what is waiting on WP-5
 *
 * Real: the people (`GET /api/people`, WP-3's rows), the queues, their providers, the
 * segment, the Which queue? step and Go — which starts a pull queue through `/go/<id>` and
 * opens the device menu for a push one, exactly as the queue's own page does.
 *
 * Stubbed, in ONE place each and both named in `lib/tonight.ts`: a queue's ACTIVITY is
 * derived from its provider kind (`activityForSet`) instead of stored on it, and a queue
 * carries no PEOPLE (`TonightQueue.hasRoster` is false, so the people filter passes every
 * queue through). WP-5 fills both and the rule they feed does not change.
 *
 * Not built, and deliberately not faked: the pick engine (WP-7/WP-8). Go is disabled on
 * Pick and says why.
 */
export function TonightView({
  isHidden,
  step,
}: {
  isHidden: boolean
  step: "surprise" | null
}) {
  const navigate = useNavigate()
  const { reg } = useStore()

  const [people, setPeople] = useState<Person[]>([])
  const [peopleError, setPeopleError] = useState<
    string | null
  >(null)
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

  const chooseActivity = (id: ActivityId) => {
    setSession({
      activity: id,
      filters: defaultFilterValues(id),
      mode: defaultModeFor(id),
    })
    setQueueId(null)

    // Surprise Me is a SECOND SCREEN, not a one-tap random pick: you narrow down first and
    // only then does it choose. Every other tile leaves that step.
    navigate(
      id === "surprise" ? "/tonight/surprise" : "/tonight",
    )
  }

  // Loaded when the view becomes visible rather than at mount: the four views are all
  // permanently mounted and toggle `hidden`, so an eager fetch here would run on every
  // landing paint for a screen nobody opened.
  useEffect(() => {
    if (isHidden) return

    let isCancelled = false

    void api<PeopleResponse>("GET", "/api/people")
      .then((r) => {
        if (isCancelled) return
        setPeople(rosterOrder(r.people ?? []))
        setPeopleError(null)
      })
      .catch((e: unknown) => {
        if (isCancelled) return
        setPeople([])
        // Said out loud rather than rendered as an empty roster: "nobody is in the people
        // table yet" and "the request failed" look identical otherwise, and only one of
        // them is something to go and fix.
        setPeopleError(
          e instanceof Error ? e.message : String(e),
        )
      })

    return () => {
      isCancelled = true
    }
  }, [isHidden])

  // The provider's PRODUCT name, off the registry's own vocabulary — no second request, and
  // no table of brand names in this app's source.
  const providerLabels = new Map(
    (reg?.sets ?? []).map((set) => [
      set.provider_kind,
      set.vocabulary?.name ?? "",
    ]),
  )
  const queues = tonightQueues(
    reg?.sets ?? [],
    providerLabels,
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
    matches.find((q) => q.id === queueId) ??
    matches[0] ??
    null

  const activity = findActivity(session.activity)
  const filters = ACTIVITY_FILTERS[session.activity]
  const isSurpriseStep = step === "surprise"
  const isQueues = session.mode === "queues"

  return (
    <main className="view" hidden={isHidden} id="tonight">
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
              onToggle={(value, isChecked) =>
                setSelectedPeople((prev) =>
                  isChecked
                    ? [...prev, value]
                    : prev.filter((id) => id !== value),
                )
              }
              options={people.map((person) => ({
                label: person.displayName,
                value: person.id,
              }))}
              // The ROSTER is this group's second writer — the user's own clicks write
              // `checked`, so keying on that would remount a box under a finger.
              seedKey={people.map((p) => p.id).join(",")}
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
          on screen, mutually exclusive, announced as "3 of 6". `.actgrid` is app LAYOUT and
          paints nothing: it makes the group a grid whose column count comes from the
          CONTAINER's width rather than the window's, which is the standing rule for any
          list of cards. */}
      <section className="tsection" id="tonight-activity">
        <h2 className="tlabel">Activity</h2>
        <RadioGroup
          className="actgrid"
          items={ACTIVITIES.map((one) => ({
            label: (
              <span className="actlbl">
                <span className="actname">{one.label}</span>
                <span className="acthint">{one.hint}</span>
              </span>
            ),
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
        <SurpriseStep />
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
              chosenQueue={isQueues ? chosenQueue : null}
              guestCount={guestCount}
              isQueues={isQueues}
              selectedPeople={selectedPeople}
            />
          </section>
        </>
      )}
    </main>
  )
}

/**
 * Step 5. One match is implied and is shown rather than asked; two or more are a real
 * choice; zero is an empty state.
 *
 * A grid, never a column of full-width rows — the column count comes from this section's
 * width, so the same list is one column in the Narrow View and four on a wide monitor.
 */
function WhichQueue({
  activityLabel,
  chosenQueueId,
  matches,
  onChoose,
  seedKey,
}: {
  activityLabel: string
  chosenQueueId: string | null
  matches: readonly TonightQueue[]
  onChoose: (id: string) => void
  seedKey: string
}) {
  // The one place a provider brand belongs on this screen: once two backends serve the
  // same activity, which one a queue runs on is the thing that tells them apart.
  const isProviderShown = isProviderWorthNaming(matches)

  const card = (queue: TonightQueue) => (
    <span className="qcard">
      <span className="qcardname">{queue.name}</span>
      <span className="qcardmeta">
        {/* The people are the badges that tell two otherwise identical queues apart.
            Empty until WP-5 stores them; the row simply does not paint until then. */}
        {queue.peopleNames.map((name) => (
          <Badge intent="neutral" key={name} size="sm">
            {name}
          </Badge>
        ))}
        {isProviderShown && queue.providerLabel ? (
          <Badge
            appearance="outline"
            intent="neutral"
            size="sm"
          >
            {queue.providerLabel}
          </Badge>
        ) : null}
      </span>
    </span>
  )

  return (
    <section className="tsection" id="tonight-queue">
      <h2 className="tlabel">Which queue?</h2>

      {matches.length === 0 ? (
        <EmptyState
          description={`Nothing matches ${activityLabel || "this activity"} and the people you ticked. Untick somebody, or switch to Pick.`}
          headingLevel={3}
          heading="No queue for that"
          size="sm"
        />
      ) : matches.length === 1 && matches[0] ? (
        // ONE match is implied, not asked — a question with a single answer is not a
        // question. It is still SHOWN, so Go is never a mystery.
        <div className="qimplied" id="tonight-queue-only">
          {card(matches[0])}
          <span className="subhint">
            The only one — Go plays it.
          </span>
        </div>
      ) : (
        <RadioGroup
          className="queuegrid"
          items={matches.map((queue) => ({
            label: card(queue),
            value: queue.id,
          }))}
          // The MATCH LIST is the second writer: changing the activity or the ticked
          // people rebuilds it, and the control seeds on mount only.
          key={seedKey}
          label="Which queue"
          onChange={(value) => {
            if (value) onChoose(value)
          }}
          selectedValue={chosenQueueId ?? undefined}
        />
      )}
    </section>
  )
}

/**
 * Go, and it does the real thing wherever the real thing exists today.
 *
 * A PULL queue (reading, board games) hands back a URL, so this is an anchor to
 * `/go/<id>` — the same stable launcher `OpenQueueButton` and the shelf already use, and
 * the reason it opens a new tab is that the form you launched from is still here on the way
 * back. A PUSH queue is sent at a device, so Go opens the device menu.
 *
 * ⚠️ `.playbtn` is LOAD-BEARING and paints nothing: `PlayMenu`'s outside-click handler asks
 * `t.closest(".playbtn")`, so a control that opens that menu without the class opens a menu
 * that shuts on the same click.
 *
 * On **Pick** there is nowhere to go yet. The pick engine and the result card are WP-7 and
 * WP-8, and a Go that navigated somewhere plausible would be worse than one that says it
 * cannot: this screen collects the answer, and the half that acts on it is not built.
 */
function GoButton({
  chosenQueue,
  guestCount,
  isQueues,
  selectedPeople,
}: {
  chosenQueue: TonightQueue | null
  guestCount: number
  isQueues: boolean
  selectedPeople: readonly string[]
}) {
  const label = goLabel(selectedPeople, guestCount)

  if (!isQueues) {
    return (
      <>
        <Button
          id="tonight-go"
          intent="accent"
          isDisabled
          size="lg"
        >
          {label}
        </Button>
        <p className="subhint">
          Pick chooses one thing and offers a reroll. That
          engine is not connected yet — switch to Queues to
          start something now.
        </p>
      </>
    )
  }

  if (!chosenQueue) {
    return (
      <Button
        id="tonight-go"
        intent="accent"
        isDisabled
        size="lg"
      >
        {label}
      </Button>
    )
  }

  if (chosenQueue.delivery === "pull") {
    return (
      <ButtonLink
        href={`/go/${encodeURIComponent(chosenQueue.id)}`}
        id="tonight-go"
        intent="accent"
        isExternal
        size="lg"
      >
        {label}
      </ButtonLink>
    )
  }

  return (
    <Button
      className="playbtn"
      id="tonight-go"
      intent="accent"
      onClick={(e) =>
        openPlayMenu({
          anchor: e.currentTarget.getBoundingClientRect(),
          setId: chosenQueue.id,
        })
      }
      size="lg"
    >
      {label}
    </Button>
  )
}

/**
 * Surprise Me's second screen.
 *
 * Tapping the tile chooses nothing. It brings you here, you narrow down, and only then does
 * it choose — and the narrowing list is COARSER than the tile row: "media" is one entry
 * spanning Movies, Shows and YouTube, which is why it cannot be derived from `ACTIVITIES`.
 *
 * ⚠️ **The groupings are not settled and are deliberately not invented.** The owner has been
 * asked for them. `SURPRISE_SCOPES` is the seam; fill it in and this step renders its
 * choices with no other change. Until then it says what it is waiting for, because a
 * plausible made-up taxonomy on this screen would read as settled and get built on.
 */
function SurpriseStep() {
  if (SURPRISE_SCOPES.length === 0) {
    return (
      <section className="tsection" id="tonight-surprise">
        <EmptyState
          description="Surprise Me narrows down first and chooses second. What it narrows BY is still being settled — it is coarser than the tiles above, so it is not the same list again. Pick another activity for now."
          headingLevel={2}
          heading="Narrow it down"
        />
      </section>
    )
  }

  return (
    <section className="tsection" id="tonight-surprise">
      <h2 className="tlabel">Narrow it down</h2>
      <RadioGroup
        className="actgrid"
        items={SURPRISE_SCOPES.map((scope) => ({
          label: (
            <span className="actlbl">
              <span className="actname">{scope.label}</span>
              <span className="acthint">{scope.hint}</span>
            </span>
          ),
          value: scope.id,
        }))}
        label="Narrow it down"
      />
    </section>
  )
}

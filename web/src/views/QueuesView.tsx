import { useAdaptiveColumns } from "@charcuterie/ui"
import { Fragment, useMemo, useRef } from "react"
import { useLocation } from "react-router"
import { AlsoInDivider } from "../components/AlsoInDivider"
import { LandingFilterBar } from "../components/LandingFilterBar"
import { useHomeDrags } from "../hooks/useHomeDrags"
import {
  filteredParent,
  groupQueueFamilies,
  nestFilteredQueues,
} from "../lib/filteredQueues"
import { isRandomOrder } from "../lib/kind"
import { activeSet } from "../lib/nowPlaying"
import { queueListNumbers, queueTitle } from "../lib/people"
import { ROUTE_PATHS } from "../lib/routePaths"
import type { PeopleMatch } from "../lib/tonight"
import {
  missingRequiredPeople,
  peopleMatch,
  resolveMembers,
  rosterOrder,
  splitByMatch,
} from "../lib/tonight"
import {
  parsePeople,
  parseProviders,
} from "../state/landingFilter"
import { usePeople } from "../state/people"
import {
  curatedIds,
  rotationChannels,
  useStore,
} from "../state/store"
import {
  setCollapsed,
  toggleCollapsed,
  useUi,
} from "../state/ui"
import { RulesShelf } from "./RulesShelf"
import { Shelf } from "./Shelf"
import { shelfMatches } from "./shelfMatches"

/**
 * QUEUES — the configurator. Every ordered queue is a horizontal poster shelf, so
 * all of them are glanceable but only one is "expanded" at a time; tapping one
 * opens it as a grid. Posters drag within and between shelves; the ≡ handle
 * reorders whole shelves. (decision `2026-07-20-queue-web-ui-ux-and-write-format`)
 */
export function QueuesView({
  toolbar,
}: {
  /** The Home toolbar, when the viewport is narrow enough that it mounts here. */
  toolbar: React.ReactNode
}) {
  const { data, now, reg } = useStore()
  const people = usePeople()
  const { search } = useLocation()
  const { collapsed, filter, hasCollapsePreference } =
    useUi()
  const shelvesRef = useRef<HTMLDivElement>(null)

  useHomeDrags(shelvesRef)

  const playingSet = activeSet(now, data)
  const only = parseProviders(search)
  const selected = parsePeople(search)

  /** Every queue's audience, resolved through the SAME group rule the former queue landing
   * used. A group remains one "at least N of these people" member; it must not be flattened
   * into people here or the filter would require the whole group. */
  const membersOf = useMemo(() => {
    const out = new Map<
      string,
      ReturnType<typeof resolveMembers>
    >()

    for (const [setId, members] of Object.entries(
      people.byQueue,
    )) {
      out.set(
        setId,
        resolveMembers(
          members,
          people.people,
          people.groups,
        ),
      )
    }

    return out
  }, [people])

  // WP-5. Two queues may share people and activity — "Allow, and add a number."
  //
  // Over the shelves THIS PAGE DRAWS, in the order it draws them, and not over the registry.
  // A number is how you tell two cards apart, so it only means anything among cards somebody
  // can see at once: numbering the registry made this page open at "Movies & Shows 3",
  // because two filtered pools on the Pools page had taken 1 and 2.
  // EVERY Picks queue, both lane defaults. It was the priority-lane half until 2026-08-26,
  // which is what left `Alex — Anime` and nine others listed on the Rules page instead
  // (decision `2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to`).
  const setById = (id: string) =>
    reg?.sets.find((set) => set.id === id) ?? null
  // A FILTERED queue is drawn UNDER the queue it views, wherever the file happens to have
  // written it (`lib/filteredQueues.ts`).
  const shelfIds = nestFilteredQueues(
    curatedIds(data),
    setById,
  )
  const rulesChannels = rotationChannels(reg)
  const queueIds = [
    ...shelfIds,
    ...rulesChannels.map((channel) => channel.id),
  ]
  const kindOf = (id: string) =>
    reg?.sets.find((set) => set.id === id)?.provider_kind ??
    ""
  /**
   * HOW WELL one queue answers the filter — `exact`, `also` or `none`.
   *
   * The provider filter is a plain AND and has no tiers: a Kavita queue is not a near miss
   * for "Plex", it is a different library. Only the PEOPLE question has a middle answer.
   */
  const matchOf = (
    id: string,
    forPeople: readonly string[],
    forOnly: readonly string[],
  ): PeopleMatch =>
    forOnly.length && !forOnly.includes(kindOf(id))
      ? { missingRequired: 0, tier: "none" }
      : peopleMatch(membersOf.get(id) ?? [], forPeople)
  const shownShelfIds = splitByMatch(shelfIds, (id) =>
    matchOf(id, selected, only),
  )
  const shownRulesChannels = splitByMatch(
    rulesChannels,
    (channel) => matchOf(channel.id, selected, only),
  )
  const countFor = (
    forPeople: readonly string[],
    forOnly: readonly string[],
  ) =>
    queueIds.filter(
      (id) =>
        matchOf(id, forPeople, forOnly).tier !== "none",
    ).length
  /**
   * Is there a queue that NAMES all of these people? The filter bar's dead-end test.
   *
   * `(membersOf.get(id)?.length ?? 0) > 0` is the whole difference from `countFor`: a queue
   * nobody is filed on passes every people filter by design, so a plain count answers yes for
   * two people who share nothing.
   */
  const hasQueueFor = (
    forPeople: readonly string[],
    forOnly: readonly string[],
  ) =>
    queueIds.some(
      (id) =>
        (membersOf.get(id)?.length ?? 0) > 0 &&
        matchOf(id, forPeople, forOnly).tier !== "none",
    )
  const providerKinds = [
    ...new Set(queueIds.map(kindOf).filter(Boolean)),
  ]
  const labelForKind = (kind: string) =>
    reg?.sets.find((set) => set.provider_kind === kind)
      ?.vocabulary?.name || kind
  // `queueListNumbers` is the Picks shelves in nested order, then the Rules shelves — the two
  // sections this page draws. The native TV catalog calls the same function over the same
  // registry, so a queue wears the same number on both.
  const numbers = queueListNumbers(
    reg?.sets ?? [],
    people.byQueue,
  )
  /**
   * The names the "Also in these queues" line prints, over BOTH tiers' also-in lists at once
   * and in roster order.
   *
   * One list for the page rather than one per section, so the Picks divider and the Rules
   * divider cannot name two different sets of people for the same filter — they are answering
   * the same question about the same selection.
   */
  const alsoNames = (() => {
    const wanted = new Set(
      [
        ...shownShelfIds.also,
        ...shownRulesChannels.also.map(
          (channel) => channel.id,
        ),
      ].flatMap((id) =>
        missingRequiredPeople(
          membersOf.get(id) ?? [],
          selected,
        ),
      ),
    )

    return rosterOrder(people.people)
      .filter((person) => wanted.has(person.id))
      .map((person) => person.displayName)
  })()

  const toggleQueue = (
    id: string,
    isCollapsed: boolean,
  ) => {
    if (hasCollapsePreference) {
      toggleCollapsed(id, isCollapsed)
    } else {
      // No saved preference means all cards are collapsed, not an empty collapsed set.
      setCollapsed(
        new Set(
          queueIds.filter((queueId) => queueId !== id),
        ),
      )
    }
  }
  const renderShelf = (id: string) => {
    const queue = data!.sets[id]!
    const registrySet = setById(id)
    // THE NAME WHEN THERE IS ONE, the ACTIVITY when there is not. This shelf
    // printed the activity unconditionally until 2026-08-26, which renamed
    // "Manga & Webtoons" to "Reading" on a queue the owner had deliberately named
    // (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`).
    // `q.label` stays the FILTER's haystack below either way, so typing "manga"
    // finds it even when the shelf is showing the activity.
    const title = registrySet
      ? queueTitle(registrySet, numbers.get(id) ?? null)
      : queue.label

    return (
      <Shelf
        onToggle={() =>
          toggleQueue(
            id,
            !hasCollapsePreference || collapsed.has(id),
          )
        }
        groups={people.groups}
        isCollapsed={
          !hasCollapsePreference || collapsed.has(id)
        }
        isHiddenByFilter={
          !shelfMatches(
            filter,
            [title, queue.label],
            queue.items,
          )
        }
        items={queue.items}
        label={title}
        members={people.byQueue[id] ?? []}
        now={now}
        people={people.people}
        playingSet={playingSet}
        providerKind={registrySet?.provider_kind ?? ""}
        filteredFrom={filteredParent(registrySet, setById)}
        set={registrySet ?? null}
        setId={id}
        // The registry row first, the queues payload as the fallback — the same
        // pair `QueueView` and `App` resolve the lane from, so one queue cannot
        // read as priority-by-default on its shelf and random-by-default on its
        // own page.
        setLane={
          isRandomOrder(registrySet ?? queue)
            ? "random"
            : "priority"
        }
      />
    )
  }
  const families = [
    ...groupQueueFamilies(shownShelfIds.exact, setById).map(
      (ids) => ({ ids, isAlso: false }),
    ),
    ...groupQueueFamilies(shownShelfIds.also, setById).map(
      (ids) => ({ ids, isAlso: true }),
    ),
  ]
  const matches = (id: string) => {
    const queue = data?.sets[id]
    const set = setById(id)
    return Boolean(
      queue &&
        shelfMatches(
          filter,
          [
            set
              ? queueTitle(set, numbers.get(id) ?? null)
              : queue.label,
            queue.label,
          ],
          queue.items,
        ),
    )
  }
  const layout = useAdaptiveColumns({
    itemBlockSize: 220,
    itemCount:
      families.filter(({ ids }) => ids.some(matches))
        .length +
      [
        ...shownRulesChannels.exact,
        ...shownRulesChannels.also,
      ].filter((channel) =>
        shelfMatches(
          filter,
          [
            queueTitle(
              channel,
              numbers.get(channel.id) ?? null,
            ),
            channel.label,
          ],
          [],
        ),
      ).length,
    chromeBlockSize: 300,
    minColumnInlineSize: 340,
    maxAutoColumns: 4,
  })
  const gridStyle = {
    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
    maxInlineSize: layout.contentMaxInlineSize,
  }
  return (
    <div className="view" id="home">
      <div id="gslot-narrow">{toolbar}</div>
      <LandingFilterBar
        basePath={ROUTE_PATHS.queues.replace("/*", "")}
        countFor={countFor}
        hasQueueFor={hasQueueFor}
        labelForKind={labelForKind}
        only={only}
        people={rosterOrder(people.people)}
        providerKinds={providerKinds}
        search={search}
        selected={selected}
      />
      <div className="queue-section-heading picks-queue-heading">
        <div>
          <h2>Picks</h2>
          <p>Queues whose titles you choose and arrange.</p>
        </div>
      </div>
      <div
        className="queue-grid-measure"
        ref={layout.containerRef}
      >
        <div
          className="queue-card-grid"
          id="shelves"
          ref={shelvesRef}
          style={gridStyle}
        >
          {families.map(({ ids, isAlso }, index) => (
            <Fragment key={ids[0]}>
              {isAlso && !families[index - 1]?.isAlso ? (
                <AlsoInDivider names={alsoNames} />
              ) : null}
              <div
                className="queue-family"
                hidden={!ids.some(matches)}
              >
                {ids.map((id) => (
                  <Fragment key={id}>
                    {renderShelf(id)}
                  </Fragment>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      {rulesChannels.length ? (
        <section
          aria-labelledby="rules-queues-heading"
          className="rules-queue-picker"
        >
          <div className="queue-section-heading">
            <div>
              <h2 id="rules-queues-heading">Rules</h2>
              <p>Queues filled from eligibility filters.</p>
            </div>
          </div>
          <div
            className="rules-queue-shelves queue-card-grid"
            style={gridStyle}
          >
            {[
              ...shownRulesChannels.exact,
              ...shownRulesChannels.also,
            ].map((channel, index) => (
              <Fragment key={channel.id}>
                {shownRulesChannels.also.length > 0 &&
                index ===
                  shownRulesChannels.exact.length ? (
                  <AlsoInDivider names={alsoNames} />
                ) : null}
                <RulesShelf
                  onToggle={() =>
                    toggleQueue(
                      channel.id,
                      !hasCollapsePreference ||
                        collapsed.has(channel.id),
                    )
                  }
                  channel={channel}
                  filter={filter}
                  groups={people.groups}
                  isCollapsed={
                    !hasCollapsePreference ||
                    collapsed.has(channel.id)
                  }
                  members={people.byQueue[channel.id] ?? []}
                  people={people.people}
                  title={queueTitle(
                    channel,
                    numbers.get(channel.id) ?? null,
                  )}
                />
              </Fragment>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

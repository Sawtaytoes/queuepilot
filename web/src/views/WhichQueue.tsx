import {
  Badge,
  EmptyState,
  RadioGroup,
} from "@charcuterie/ui"
import {
  isProviderWorthNaming,
  type TonightQueue,
} from "../lib/tonight"

/**
 * Step 5. One match is implied and is shown rather than asked; two or more are a real
 * choice; zero is an empty state.
 *
 * A grid, never a column of full-width rows — the column count comes from this section's
 * width, so the same list is one column in the Narrow View and four on a wide monitor.
 */
export function WhichQueue({
  activityLabel,
  chosenQueueId,
  hasSelection,
  matches,
  onChoose,
  seedKey,
}: {
  activityLabel: string
  chosenQueueId: string | null
  /** Whether anybody is ticked — which of the two empty answers this is. */
  hasSelection: boolean
  matches: readonly TonightQueue[]
  onChoose: (id: string) => void
  seedKey: string
}) {
  // The one place a provider brand belongs on this screen: once two backends serve the
  // same activity, which one a queue runs on is the thing that tells them apart.
  const isProviderShown = isProviderWorthNaming(matches)

  /* The badge row a queue card carries under its name. It is the `hint` of a choice tile
     when the host is choosing, and the second line of the implied card when there is
     nothing to choose — one definition, so the two can never say different things. */
  const meta = (queue: TonightQueue) => (
    <span className="qcardmeta">
      {/* The people are the badges that tell two otherwise identical queues apart, and
          they are why a queue is or is not in this list. A "Nice to have" member is drawn
          as an outline rather than a fill: being there never removes the queue, so it is
          not the same claim as a "Must be here" one.

          A queue nobody is filed on says so in words. An empty row reads as "still
          loading", and this one is never filtered out — it is offered to everybody. */}
      {queue.members.length === 0 ? (
        <span className="qcardanyone">Anybody</span>
      ) : (
        queue.members.map((member) => (
          <Badge
            appearance={
              member.role === "optional"
                ? "outline"
                : "solid"
            }
            intent="neutral"
            key={`${member.kind}:${member.id}`}
            size="sm"
          >
            {member.label}
          </Badge>
        ))
      )}
      {isProviderShown && queue.providerLabel ? (
        <span className="qcardprov">
          <Badge
            appearance="outline"
            intent="accent"
            size="sm"
          >
            {queue.providerLabel}
          </Badge>
        </span>
      ) : null}
    </span>
  )

  /* The IMPLIED queue, which is not a control at all — so it keeps its own small card
     rather than borrowing a radio's. */
  const card = (queue: TonightQueue) => (
    <span className="qcard">
      <span className="qcardname">{queue.name}</span>
      {meta(queue)}
    </span>
  )

  return (
    <section className="tsection" id="tonight-queue">
      <h2 className="tlabel">Which queue?</h2>

      {matches.length === 0 ? (
        /* A filter that silently drops to nothing is worse than an over-inclusive list, so
           the empty state says WHICH of the two empties this is. Nobody ticked and no
           matches means the activity has no queue at all — untelling somebody would not
           help, and saying so would send the host hunting for a tick that is not there. */
        <EmptyState
          description={
            hasSelection
              ? `No ${activityLabel || "queue"} queue lists everybody you ticked. Untick somebody, or switch to Pick and let it draw.`
              : `There is no ${activityLabel || "queue"} queue yet. Switch to Pick, or make one on the Queues page.`
          }
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
          itemShape="tile"
          items={matches.map((queue) => ({
            hint: meta(queue),
            label: queue.name,
            value: queue.id,
          }))}
          // A queue name is a whole title, so its tiles want more room across than an
          // activity's two words do.
          minTileInlineSize={260}
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

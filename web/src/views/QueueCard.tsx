import {
  Badge,
  Button,
  ButtonLink,
  Card,
} from "@charcuterie/ui"
import type { TonightPickWire } from "../lib/types"
import { openPlayMenu } from "../state/overlays"

/**
 * ONE QUEUE, as a card.
 *
 * What it says and what it deliberately does not:
 *
 *   - The **queue** is the answer. It is named, and the provider it runs on is a badge
 *     beside it — the one place a provider brand belongs on this surface.
 *   - **Up next** is what would come up, when that could be answered without starting
 *     anything. When it could not, the card says WHY in the same place, because a blank space
 *     where a title should be reads as a bug.
 *   - There is **no Mark played**. A queue records its own progress when it plays; a button
 *     here would be a second writer of the same fact.
 *
 * Go is the queue's own launch, and it is the same two shapes the shelf and the Tonight form
 * already use: a PULL queue is an anchor to `/go/<id>`, a PUSH queue opens the device menu.
 *
 * ⚠️ `.playbtn` is LOAD-BEARING and paints nothing — `PlayMenu`'s outside-click handler asks
 * `t.closest(".playbtn")`, so a control that opens that menu without the class opens a menu
 * that shuts on the same click.
 */
export function QueueCard({
  idPrefix,
  pick,
}: {
  idPrefix: string
  pick: TonightPickWire
}) {
  return (
    <Card
      className="bgcard"
      heading={pick.setLabel}
      headingLevel={2}
      id={`${idPrefix}-queue`}
      padding="lg"
      surface="raised"
    >
      <div className="bgbadges">
        {pick.providerLabel ? (
          <Badge
            appearance="outline"
            intent="neutral"
            size="sm"
          >
            {pick.providerLabel}
          </Badge>
        ) : null}
        <Badge intent="neutral" size="sm">
          {pick.delivery === "pull"
            ? "Opens on the device you are holding"
            : "Sent to a device"}
        </Badge>
      </div>

      {pick.upNext ? (
        <p className="bgmeta" id={`${idPrefix}-upnext`}>
          Up next: {pick.upNext.title}
          {pick.upNext.detail
            ? ` · ${pick.upNext.detail}`
            : ""}
        </p>
      ) : (
        <p className="bgmeta" id={`${idPrefix}-upnext`}>
          {pick.upNextReason ??
            "This queue has not said what comes next."}
        </p>
      )}

      <p className="bgmeta">
        The queue chooses what plays when it starts.
      </p>

      <div className="bglinks">
        {pick.launchUrl ? (
          <ButtonLink
            href={pick.launchUrl}
            id={`${idPrefix}-go`}
            intent="accent"
            isExternal
            size="lg"
          >
            Start it
          </ButtonLink>
        ) : (
          <Button
            className="playbtn"
            id={`${idPrefix}-go`}
            intent="accent"
            onClick={(event) =>
              openPlayMenu({
                anchor:
                  event.currentTarget.getBoundingClientRect(),
                setId: pick.setId,
              })
            }
            size="lg"
          >
            Start it
          </Button>
        )}
      </div>
    </Card>
  )
}

import { Button, ButtonLink } from "@charcuterie/ui"
import { useState } from "react"
import { useNavigate } from "react-router"
import { tableSize } from "../lib/boardGames"
import { writePickSession } from "../lib/pickSession"
import {
  type ActivityId,
  goLabel,
  type TonightQueue,
} from "../lib/tonight"
import { drawTonight } from "../lib/tonightDraw"
import { routeFor } from "../lib/tonightRouting"
import { openPlayMenu } from "../state/overlays"
import { setStatus } from "../state/store"

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
 * On **Pick**, this calls the same draw used by a preset card. The resulting criteria include
 * every Board Game Picker filter that the Tonight form exposes, so the result and reroll keep
 * the user's interaction, category and playtime choices.
 */
export function GoButton({
  activity,
  chosenQueue,
  filters,
  guestCount,
  isQueues,
  selectedPeople,
}: {
  activity: ActivityId
  chosenQueue: TonightQueue | null
  filters: Record<string, string>
  guestCount: number
  isQueues: boolean
  selectedPeople: readonly string[]
}) {
  const navigate = useNavigate()
  const [isDrawing, setIsDrawing] = useState(false)
  const label = goLabel(selectedPeople, guestCount)
  // The one map: which backend this activity reaches, and how Pick draws for it.
  const route = routeFor(activity)

  /**
   * ONE handler for both Pick engines, and it is the SAME function a preset card's address
   * runs (`lib/tonightDraw.ts`). The two used to be written out here, once each, which is
   * exactly where a second caller could not reach them — and a copy would be two places for
   * "which engine does this activity use" to drift apart.
   */
  const draw = async () => {
    setIsDrawing(true)
    try {
      const outcome = await drawTonight({
        activity,
        filters,
        guestCount,
        personIds: [...selectedPeople],
      })

      if (!outcome.isDrawn) {
        setStatus(outcome.reason, "err")
        return
      }

      // WRITTEN DOWN BEFORE WE NAVIGATE. The pick and reroll's memory used to be plain
      // component state, so leaving the card lost both.
      writePickSession(outcome.session)
      navigate("/result")
    } catch (error) {
      setStatus(
        `Could not pick: ${(error as Error).message}`,
        "err",
      )
    } finally {
      setIsDrawing(false)
    }
  }

  if (!isQueues && route.engine === "board-games") {
    const size = tableSize(selectedPeople, guestCount)

    // A pick needs to know how many are playing, and this screen's people are a FILTER —
    // so an empty answer is not "nought players", it is "you have not said". Guests count,
    // which is how a table of people with no roster rows still gets a pick.
    if (size === 0) {
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
            Tick who is playing, or add a guest — a pick
            needs to know how many are at the table.
          </p>
        </>
      )
    }

    return (
      <Button
        id="tonight-go"
        intent="accent"
        isDisabled={isDrawing}
        onClick={() => void draw()}
        size="lg"
      >
        {label}
      </Button>
    )
  }

  // SURPRISE ME narrows before it picks. The tile routes to its own screen, so this branch is
  // only reachable through stale state; it points back to the approved second step.
  if (!isQueues && route.engine === "narrow-first") {
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
          Surprise Me narrows down first. Choose Media,
          Games or Reading.
        </p>
      </>
    )
  }

  // EVERY OTHER TILE IS QUEUE-FIRST (WP-7). The draw chooses one queue for this activity and
  // these people, binds the session to that queue's backend, and hands the card a shortlist
  // of three drawn at the same time. The queue's own engine chooses the ITEM when it starts —
  // it is the only thing that already knows what is left.
  if (!isQueues) {
    return (
      <Button
        id="tonight-go"
        intent="accent"
        isDisabled={isDrawing}
        onClick={() => void draw()}
        size="lg"
      >
        {label}
      </Button>
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
      onClick={(event) =>
        openPlayMenu({
          anchor:
            event.currentTarget.getBoundingClientRect(),
          setId: chosenQueue.id,
        })
      }
      size="lg"
    >
      {label}
    </Button>
  )
}

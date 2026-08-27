import { Badge } from "@charcuterie/ui"
import type { ReactNode } from "react"

import { queuePeopleLabel } from "../lib/people"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "../lib/types"

/**
 * WHO A QUEUE IS FOR, as a chip on a row of text.
 *
 * The third form of the same fact. A shelf heading and a landing card draw `PeopleRow`, the
 * queue editor draws the trays, and a MENU row draws this — a menu item is a line, and a row
 * of 26px faces would set its height from the faces and make every other row in the panel
 * look short.
 *
 * It exists because the queue's displayed name is its ACTIVITY now
 * (decision `2026-08-25-a-queue-is-people-plus-an-activity`), so an Add-to menu listing four
 * queues listed "Movies & Shows" four times. Reported 2026-08-26: *"These options should show
 * some badge or something of who's involved in them because it's not clear now that we're
 * using auto-names."*
 *
 * `.optionbadge` is the same class `SelectListbox` puts on a picker option's chip, and it
 * carries the right-align — one rule, both list shapes. It is a layout class on a Charcuterie
 * `Badge`, which is the app-layout exception the component rule names, not a skin.
 */
export function QueuePeopleBadge({
  groups,
  members,
  people,
}: {
  members: readonly QueueMember[]
  people: readonly Person[]
  groups: readonly GroupWithRoster[]
}): ReactNode {
  return (
    <Badge
      appearance="outline"
      className="optionbadge"
      intent="neutral"
      size="sm"
    >
      {queuePeopleLabel(members, people, groups)}
    </Badge>
  )
}

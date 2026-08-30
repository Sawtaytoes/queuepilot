import type { ReactNode } from "react"

import { queuePeopleLabel } from "../lib/people"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "../lib/types"
import { PersonFace } from "./PersonFace"

/**
 * WHO A QUEUE IS FOR, as compact faces and a label on a menu row.
 *
 * The third form of the same fact. A shelf heading and a landing card draw `PeopleRow`, the
 * queue editor draws the trays, and an Add-to menu draws this compact form. The same face
 * marker makes a long list easier to scan than a wall of text-only chips.
 *
 * It exists because the queue's displayed name is its ACTIVITY now
 * (decision `2026-08-25-a-queue-is-people-plus-an-activity`), so an Add-to menu listing four
 * queues listed "Movies & Shows" four times. Reported 2026-08-26: *"These options should show
 * some badge or something of who's involved in them because it's not clear now that we're
 * using auto-names."*
 *
 * The visible label remains. Colour and initials supplement the words; they never replace
 * them. Optional people keep the smaller dashed face used by `PeopleRow`.
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
  const labelFor = (member: QueueMember): string =>
    member.kind === "group"
      ? (groups.find((group) => group.id === member.id)
          ?.label ?? member.id)
      : (people.find((person) => person.id === member.id)
          ?.displayName ?? member.id)

  return (
    <span className="optionpeople">
      {members.length > 0 ? (
        <span aria-hidden="true" className="optionfaces">
          {members.map((member) => (
            <PersonFace
              id={member.id}
              isOptional={member.role === "optional"}
              key={`${member.kind}:${member.id}`}
              label={labelFor(member)}
              size="sm"
            />
          ))}
        </span>
      ) : null}
      <span className="optionpeople-label">
        {queuePeopleLabel(members, people, groups)}
      </span>
    </span>
  )
}

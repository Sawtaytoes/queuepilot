import { VisuallyHidden } from "@charcuterie/ui"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "../lib/types"
import { PersonFace } from "./PersonFace"

/**
 * WHO A QUEUE IS FOR, as a row of avatar badges and names.
 *
 * The queue list inherits the trays: required members come first and optional members follow.
 * Every surface uses the same face marker. Required faces are large; optional faces are small
 * and dashed. This is what replaced the queue's name — every movies queue is called "Movies",
 * and this row is what tells two of them apart.
 *
 * Every face carries its name in text as well as in colour. Optional members keep their
 * initials-only circle with a visually hidden accessible name.
 */
export function PeopleRow({
  groups,
  members,
  people,
}: {
  members: readonly QueueMember[]
  people: readonly Person[]
  groups: readonly GroupWithRoster[]
}) {
  if (members.length === 0) {
    // Not an error and not empty data — a queue nobody has filed yet. Said in words, because
    // an empty row reads as "still loading".
    return <span className="qpeople none">Anybody</span>
  }

  const labelFor = (member: QueueMember): string =>
    member.kind === "group"
      ? (groups.find((g) => g.id === member.id)?.label ??
        member.id)
      : (people.find((p) => p.id === member.id)
          ?.displayName ?? member.id)

  const required = members.filter(
    (m) => m.role === "required",
  )
  const optional = members.filter(
    (m) => m.role === "optional",
  )

  return (
    <span className="qpeople">
      {required.map((member) => (
        <span
          className="qperson req"
          key={`${member.kind}:${member.id}`}
        >
          <PersonFace
            id={member.id}
            label={labelFor(member)}
          />
          <span className="qpname">{labelFor(member)}</span>
        </span>
      ))}
      {optional.map((member) => (
        <span
          className="qperson opt"
          key={`${member.kind}:${member.id}`}
          // Optional faces are small on purpose — the row would stop being readable at four
          // people otherwise. The visible name remains beside the badge.
          title={`${labelFor(member)} — nice to have`}
        >
          <PersonFace
            id={member.id}
            isOptional
            label={labelFor(member)}
            size="sm"
          />
          <VisuallyHidden>
            {labelFor(member)} — nice to have
          </VisuallyHidden>
        </span>
      ))}
    </span>
  )
}

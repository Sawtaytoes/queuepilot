import { VisuallyHidden } from "@charcuterie/ui"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "../lib/types"
import { PersonFace } from "./PersonFace"

/**
 * WHO A QUEUE IS FOR, as a row of faces.
 *
 * The queue list inherits the trays: must-be-here faces large, nice-to-have faces small and
 * dashed (decision `2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster` §3).
 * This is what replaced the queue's name — every movies queue is called "Movies", and this row
 * is what tells two of them apart.
 *
 * Every face carries its name in text as well as in colour. The visible label is the name for
 * a required member and the initials-only circle for an optional one, and both are in the
 * accessible name — a row of coloured dots would say nothing to a screen reader and would fail
 * WCAG 1.4.1 outright.
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
          // The one place the name is not also visible text, so it is the element's own
          // accessible name instead. Optional faces are small on purpose — the row would stop
          // being readable at four people otherwise.
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

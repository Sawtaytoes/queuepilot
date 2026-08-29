import { VisuallyHidden } from "@charcuterie/ui"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "../lib/types"
import { PersonFace } from "./PersonFace"

/**
 * WHO A QUEUE IS FOR, as a row of names with an optional face marker.
 *
 * The queue list inherits the trays: required members come first and optional members follow.
 * The queue shelf uses names only because its heading is already dense; other surfaces can
 * enable the face marker to draw required faces large and optional faces small and dashed
 * (decision `2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster` §3). This is
 * what replaced the queue's name — every movies queue is called "Movies", and this row is what
 * tells two of them apart.
 *
 * Every face carries its name in text as well as in colour when the caller enables it. The
 * queue shelf does not use the face marker because its heading is already dense; it keeps the
 * names as the audience distinction. Other surfaces keep the face marker. Optional members
 * use visible names when the marker is off, and otherwise keep their initials-only circle with
 * a visually hidden accessible name.
 */
export function PeopleRow({
  isFaceVisible = true,
  groups,
  members,
  people,
}: {
  isFaceVisible?: boolean
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
          {isFaceVisible ? (
            <PersonFace
              id={member.id}
              label={labelFor(member)}
            />
          ) : null}
          <span className="qpname">{labelFor(member)}</span>
        </span>
      ))}
      {optional.map((member) => (
        <span
          className="qperson opt"
          key={`${member.kind}:${member.id}`}
          // With the face marker on, the name is not also visible text, so it is the element's
          // own accessible name instead. Optional faces are small on purpose — the row would
          // stop being readable at four people otherwise.
          title={`${labelFor(member)} — nice to have`}
        >
          {isFaceVisible ? (
            <>
              <PersonFace
                id={member.id}
                isOptional
                label={labelFor(member)}
                size="sm"
              />
              <VisuallyHidden>
                {labelFor(member)} — nice to have
              </VisuallyHidden>
            </>
          ) : (
            <span className="qpname">
              {labelFor(member)}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}

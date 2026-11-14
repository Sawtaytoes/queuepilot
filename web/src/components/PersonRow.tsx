import { Button } from "@charcuterie/ui"
import { useMemo, useState } from "react"
import type { GroupWithRoster, Person } from "../lib/types"
import { removePerson, renamePerson } from "../state/people"
import { setStatus } from "../state/store"
import { NameRow } from "./NameRow"
import { PersonFace } from "./PersonFace"
import { PersonPhotoPanel } from "./PersonPhotoPanel"

/** One person. Renameable, and removable behind a confirmation that says what goes with them. */
export function PersonRow({
  byQueue,
  groups,
  person,
}: {
  person: Person
  groups: readonly GroupWithRoster[]
  byQueue: Readonly<Record<string, unknown[]>>
}) {
  const [isConfirming, setIsConfirming] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [isEditingPhoto, setIsEditingPhoto] =
    useState(false)

  // WHAT A DELETE WOULD TAKE WITH THEM, counted in the browser because both halves are already
  // here — `/api/queue-people` and the group rosters both arrived with the roster. The server
  // counts it again for its own answer; this one exists so the confirmation can say it BEFORE
  // the row is gone.
  const filed = useMemo(() => {
    const queues = Object.values(byQueue).filter(
      (members) =>
        (members as { kind?: string; id?: string }[]).some(
          (member) =>
            member.kind === "person" &&
            member.id === person.id,
        ),
    ).length
    const inGroups = groups.filter((group) =>
      group.roster.some(
        (rosterMember) =>
          rosterMember.personId === person.id,
      ),
    ).length
    return { inGroups, queues }
  }, [byQueue, groups, person.id])

  const remove = async () => {
    setIsRemoving(true)
    try {
      await removePerson(person.id)
      setStatus(`${person.displayName} removed`, "ok")
    } catch (error) {
      setStatus(
        `Could not remove: ${(error as Error).message}`,
        "err",
      )
      setIsRemoving(false)
      setIsConfirming(false)
    }
    // No `setIsRemoving(false)` on success — the row unmounts with the reload.
  }

  // Said in words, and pluralised properly. "3 group(s)" is the shape that leaks out of a
  // template, and this sentence is the last thing read before a destructive click.
  const count = (amount: number, word: string) =>
    `${amount} ${word}${amount === 1 ? "" : "s"}`
  const where = [
    filed.queues ? count(filed.queues, "queue") : null,
    filed.inGroups ? count(filed.inGroups, "group") : null,
  ].filter(Boolean)

  return (
    <NameRow
      face={
        <PersonFace
          id={person.id}
          label={person.displayName}
        />
      }
      id={person.id}
      name={person.displayName}
      note={
        isEditingPhoto && !isConfirming ? (
          <PersonPhotoPanel
            onClose={() => setIsEditingPhoto(false)}
            person={person}
          />
        ) : isConfirming ? (
          <span className="peopleconfirm">
            Remove {person.displayName}?
            {where.length
              ? ` They are filed on ${where.join(" and ")}, and will be taken off.`
              : " They are not filed on anything."}
            <Button
              intent="danger"
              isDisabled={isRemoving}
              onClick={() => void remove()}
              size="sm"
            >
              Remove
            </Button>
            <Button
              appearance="outline"
              intent="neutral"
              onClick={() => setIsConfirming(false)}
              size="sm"
            >
              Cancel
            </Button>
          </span>
        ) : null
      }
      onSave={(next) => renamePerson(person.id, next)}
      trailing={
        isConfirming ? null : (
          <>
            <Button
              appearance="outline"
              aria-expanded={isEditingPhoto}
              aria-label={`Photo for ${person.displayName}`}
              intent="neutral"
              onClick={() =>
                setIsEditingPhoto((isOpen) => !isOpen)
              }
              size="sm"
            >
              Photo
            </Button>
            {/* A WORD, not a ✕. The row already carries a text button beside it, so a glyph
                here would be the only control in the modal you have to hover to identify —
                and the ✕ this started as is the same mark the modal's own close button uses
                one line up, which is a destructive action wearing a dismissive one's
                clothes. */}
            <Button
              appearance="outline"
              aria-label={`Remove ${person.displayName}`}
              intent="danger"
              onClick={() => setIsConfirming(true)}
              size="sm"
            >
              Remove
            </Button>
          </>
        )
      }
    />
  )
}

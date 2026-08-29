import { Button, EmptyState } from "@charcuterie/ui"
import { useMemo, useState } from "react"

import type { GroupWithRoster, Person } from "../lib/types"
import {
  closePeopleModal,
  openGroupsModal,
} from "../state/overlays"
import {
  createPerson,
  removePerson,
  renamePerson,
  usePeople,
} from "../state/people"
import { setStatus } from "../state/store"
import { Modal } from "./Modal"
import { PersonFace } from "./PersonFace"

/**
 * THE ROSTER EDITOR — who exists in this household, and what each of them is called.
 *
 * It exists because the alternative was editing `/config/people-mapping.yaml` and restarting
 * the app:
 * *"All those configs are managed by you, not inside the app."* Reported 2026-08-26, from the
 * queue editor's trays: *"There are now two Kevins here. Can we please fix this so I can edit
 * the names somewhere?"*
 *
 * ── One column, not a grid ───────────────────────────────────────────────────────────────
 *
 * A row here is a face and a text field. That is a reading surface, not a wall of cards, so it
 * is one column at every width and the field takes the space
 * (decision `2026-08-25-a-text-heavy-row-list-is-one-column`).
 *
 * ── Why a row is not saved on blur ───────────────────────────────────────────────────────
 *
 * Save-on-blur would be fewer controls, and it would also commit a half-typed name to every
 * screen in the app the moment he tabbed away or clicked a scrollbar. A name is read by the
 * landing, the shelves, the trays and the Tonight checklist, so the write is explicit: the
 * button is disabled until the row is dirty, Enter submits it, and Escape puts it back.
 */
export function PeopleModal() {
  const { byQueue, groups, isLoaded, people } = usePeople()

  return (
    <Modal
      footer={
        <>
          <Button
            appearance="outline"
            id="groupsedit"
            intent="neutral"
            onClick={() =>
              openGroupsModal(groups[0]?.id ?? null)
            }
          >
            Edit people groups
          </Button>
          <Button
            appearance="outline"
            intent="neutral"
            onClick={closePeopleModal}
          >
            Close
          </Button>
        </>
      }
      id="peoplemodal"
      isOpen
      onClose={closePeopleModal}
      title="People"
      titleId="peoplemodal-title"
    >
      <p className="subhint peoplehint">
        People are individual members. People groups are
        saved rules that can include several people. Edit
        the group rules separately so a group can stay clear
        when it is used on a queue.
      </p>

      <section className="peoplesec">
        {/* An h4: `Modal` renders the title as the h3, so this is the level below it — and the
            shared `#peoplemodal h3` title chrome (a 28px gutter for the ✕) then does not land
            on a section heading that has no ✕ beside it. */}
        <h4>People</h4>
        {!isLoaded ? (
          <p className="subhint">Loading…</p>
        ) : people.length === 0 ? (
          <EmptyState
            description="Add the first one below."
            heading="Nobody yet"
            headingLevel={5}
            size="sm"
          />
        ) : (
          <ul className="peoplerows">
            {people.map((person) => (
              <PersonRow
                byQueue={byQueue}
                groups={groups}
                key={person.id}
                person={person}
              />
            ))}
          </ul>
        )}
        <AddPerson />
      </section>
    </Modal>
  )
}

/**
 * One editable name row for a person.
 *
 * `face` and `note` are passed in so the row stays reusable for the person editor.
 */
function NameRow({
  face,
  id,
  name,
  note,
  onSave,
  trailing,
}: {
  id: string
  name: string
  face: React.ReactNode
  /** The quiet second line — a person's "filed on" count. */
  note?: React.ReactNode
  onSave: (next: string) => Promise<void>
  /** The destructive control, when the row has one. */
  trailing?: React.ReactNode
}) {
  const [draft, setDraft] = useState(name)
  const [isSaving, setIsSaving] = useState(false)
  const trimmed = draft.trim()
  const isDirty = trimmed !== name && trimmed.length > 0

  const save = async () => {
    if (!isDirty || isSaving) return
    setIsSaving(true)
    try {
      await onSave(trimmed)
      setStatus(`Renamed to ${trimmed}`, "ok")
    } catch (e) {
      setStatus(
        `Could not rename: ${(e as Error).message}`,
        "err",
      )
      // Back to what the server still believes, rather than leaving the field showing a name
      // that was refused.
      setDraft(name)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <li className="peoplerow">
      <span className="peoplerowmain">
        {face}
        {/* Not a `<form>`: this row is rendered INSIDE the modal's own form, and a nested
            form is invalid HTML that browsers silently drop — the Enter key would then submit
            the OUTER one. So Enter is handled here and stopped from bubbling. */}
        <input
          aria-label={`Name for ${name}`}
          className="peoplename"
          id={`peoplename-${id}`}
          maxLength={60}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              e.stopPropagation()
              void save()
            }
            if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              setDraft(name)
            }
          }}
          type="text"
          value={draft}
        />
        <Button
          intent="accent"
          isDisabled={!isDirty || isSaving}
          onClick={() => void save()}
          size="sm"
        >
          Save
        </Button>
        {trailing}
      </span>
      {note ? (
        <p className="peoplerownote">{note}</p>
      ) : null}
    </li>
  )
}

/** One person. Renameable, and removable behind a confirmation that says what goes with them. */
function PersonRow({
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

  // WHAT A DELETE WOULD TAKE WITH THEM, counted in the browser because both halves are already
  // here — `/api/queue-people` and the group rosters both arrived with the roster. The server
  // counts it again for its own answer; this one exists so the confirmation can say it BEFORE
  // the row is gone.
  const filed = useMemo(() => {
    const queues = Object.values(byQueue).filter(
      (members) =>
        (members as { kind?: string; id?: string }[]).some(
          (m) => m.kind === "person" && m.id === person.id,
        ),
    ).length
    const inGroups = groups.filter((group) =>
      group.roster.some((m) => m.personId === person.id),
    ).length
    return { inGroups, queues }
  }, [byQueue, groups, person.id])

  const remove = async () => {
    setIsRemoving(true)
    try {
      await removePerson(person.id)
      setStatus(`${person.displayName} removed`, "ok")
    } catch (e) {
      setStatus(
        `Could not remove: ${(e as Error).message}`,
        "err",
      )
      setIsRemoving(false)
      setIsConfirming(false)
    }
    // No `setIsRemoving(false)` on success — the row unmounts with the reload.
  }

  // Said in words, and pluralised properly. "3 group(s)" is the shape that leaks out of a
  // template, and this sentence is the last thing read before a destructive click.
  const count = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`
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
        isConfirming ? (
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
          // A WORD, not a ✕. The row already carries a text button beside it, so a glyph here
          // would be the only control in the modal you have to hover to identify — and the ✕
          // this started as is the same mark the modal's own close button uses one line up,
          // which is a destructive action wearing a dismissive one's clothes.
          <Button
            appearance="outline"
            aria-label={`Remove ${person.displayName}`}
            intent="danger"
            onClick={() => setIsConfirming(true)}
            size="sm"
          >
            Remove
          </Button>
        )
      }
    />
  )
}

/** Add somebody. The id comes from the name, is generated by the server, and never moves after. */
function AddPerson() {
  const [name, setName] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const trimmed = name.trim()

  const add = async () => {
    if (!trimmed || isSaving) return
    setIsSaving(true)
    try {
      await createPerson(trimmed)
      setStatus(`${trimmed} added`, "ok")
      setName("")
    } catch (e) {
      setStatus(
        `Could not add: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="peopleadd">
      <label className="field">
        Add a person
        <input
          id="peopleadd-name"
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              e.stopPropagation()
              void add()
            }
          }}
          placeholder="e.g. Ada Lovelace"
          type="text"
          value={name}
        />
      </label>
      <Button
        id="peopleaddbtn"
        intent="accent"
        isDisabled={!trimmed || isSaving}
        onClick={() => void add()}
      >
        Add
      </Button>
    </div>
  )
}

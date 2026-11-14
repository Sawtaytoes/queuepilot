import { Button, EmptyState } from "@charcuterie/ui"
import {
  closePeopleModal,
  openGroupsModal,
} from "../state/overlays"
import { usePeople } from "../state/people"
import { AddPerson } from "./AddPerson"
import { Modal } from "./Modal"
import { PersonRow } from "./PersonRow"

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
 *
 * ── A photo is the same: chosen, previewed, THEN saved ───────────────────────────────────
 *
 * Each row's Photo button opens a panel under it — a Charcuterie `FileDropZone` (a real file
 * input, so it works from the keyboard and on a phone, with drag and drop on top), plus paste.
 * A chosen picture is shown in the circle it will be cropped to before anything is uploaded,
 * because the server crops to the CENTER square and a face near the edge of a wide photo is
 * the thing the preview exists to catch.
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

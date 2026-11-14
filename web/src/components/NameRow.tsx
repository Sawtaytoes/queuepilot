import { Button } from "@charcuterie/ui"
import { useState } from "react"
import { setStatus } from "../state/store"

/**
 * One editable name row for a person.
 *
 * `face` and `note` are passed in so the row stays reusable for the person editor.
 */
export function NameRow({
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
    } catch (error) {
      setStatus(
        `Could not rename: ${(error as Error).message}`,
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
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              event.stopPropagation()
              void save()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()
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

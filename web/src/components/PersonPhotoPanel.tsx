import { Button, FileDropZone } from "@charcuterie/ui"
import { useCallback, useEffect, useState } from "react"
import { personPhotoUrl } from "../lib/people"
import type { Person } from "../lib/types"
import {
  removePersonPhoto,
  setPersonPhoto,
} from "../state/people"
import { setStatus } from "../state/store"

/** The formats and the size the server takes. The server is the authority — it reads the type
 *  from the bytes — and this is only so a wrong file is refused before it is uploaded. */
const PHOTO_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
]

const MAX_PHOTO_MB = 15

const photoProblem = (file: File): string | null =>
  file.type && !PHOTO_TYPES.includes(file.type)
    ? "Use a JPEG, PNG, or WebP image."
    : file.size > MAX_PHOTO_MB * 1024 * 1024
      ? `Use an image under ${MAX_PHOTO_MB} MB.`
      : null

/**
 * Set, replace, or remove one person's photo.
 *
 * Three ways in, one path: the drop zone's file picker, a drop onto it, and a paste anywhere
 * while the panel is open (a screenshot, or "Copy image" from another app). Each lands in
 * `choose()`, which previews the file locally and uploads nothing until Save.
 */
export function PersonPhotoPanel({
  onClose,
  person,
}: {
  person: Person
  onClose: () => void
}) {
  const [pending, setPending] = useState<{
    file: File
    url: string
  } | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const currentUrl = personPhotoUrl(
    person.id,
    person.photoVersion,
  )
  const shownUrl = pending?.url ?? currentUrl

  // An object URL holds the file in memory until it is revoked, so each one is released when
  // the preview moves on or the panel closes.
  useEffect(
    () => () => {
      if (pending) URL.revokeObjectURL(pending.url)
    },
    [pending],
  )

  const choose = useCallback((file: File | undefined) => {
    if (!file) return
    const problem = photoProblem(file)
    if (problem) {
      setStatus(problem, "err")
      return
    }
    setPending({ file, url: URL.createObjectURL(file) })
  }, [])

  // PASTE. Only an IMAGE on the clipboard is taken, so pasting text into the name field above
  // still pastes text.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(
        event.clipboardData?.files ?? [],
      ).find((item) => item.type.startsWith("image/"))
      if (!file) return
      event.preventDefault()
      choose(file)
    }
    document.addEventListener("paste", onPaste)
    return () =>
      document.removeEventListener("paste", onPaste)
  }, [choose])

  const save = async () => {
    if (!pending || isSaving) return
    setIsSaving(true)
    try {
      await setPersonPhoto(person.id, pending.file)
      setStatus(
        `Photo saved for ${person.displayName}`,
        "ok",
      )
      setPending(null)
    } catch (error) {
      setStatus(
        `Could not save the photo: ${(error as Error).message}`,
        "err",
      )
    } finally {
      setIsSaving(false)
    }
  }

  const remove = async () => {
    setIsSaving(true)
    try {
      await removePersonPhoto(person.id)
      setStatus(
        `Photo removed for ${person.displayName}`,
        "ok",
      )
    } catch (error) {
      setStatus(
        `Could not remove the photo: ${(error as Error).message}`,
        "err",
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <span
      className="photopanel"
      data-testid={`photopanel-${person.id}`}
    >
      <span className="photopreview">
        {shownUrl ? (
          // The circle the face is drawn in, at a size you can judge a crop by. A center
          // `object-fit: cover` is exactly the server's crop, so this IS the stored picture.
          <img
            alt={
              pending
                ? `New photo for ${person.displayName}, not saved yet`
                : `Photo of ${person.displayName}`
            }
            src={shownUrl}
          />
        ) : (
          <span className="photoempty">No photo</span>
        )}
      </span>
      <span className="photocontrols">
        <FileDropZone
          accept={PHOTO_TYPES.join(",")}
          description={`JPEG, PNG, or WebP, up to ${MAX_PHOTO_MB} MB. You can also paste an image. It is cropped to a square from the center.`}
          isDisabled={isSaving}
          label={
            currentUrl || pending
              ? "Choose a different photo, or drop one here"
              : "Choose a photo, or drop one here"
          }
          onDropFiles={(files) => choose(files[0])}
        />
        <span className="photobuttons">
          {pending ? (
            <>
              <Button
                intent="accent"
                isDisabled={isSaving}
                onClick={() => void save()}
                size="sm"
              >
                Save photo
              </Button>
              <Button
                appearance="outline"
                intent="neutral"
                isDisabled={isSaving}
                onClick={() => setPending(null)}
                size="sm"
              >
                Cancel
              </Button>
            </>
          ) : currentUrl ? (
            <Button
              appearance="outline"
              intent="danger"
              isDisabled={isSaving}
              onClick={() => void remove()}
              size="sm"
            >
              Remove photo
            </Button>
          ) : null}
          <Button
            appearance="outline"
            intent="neutral"
            onClick={onClose}
            size="sm"
          >
            Done
          </Button>
        </span>
      </span>
    </span>
  )
}

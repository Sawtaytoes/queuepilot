import { Avatar } from "@charcuterie/ui"

import { initials, personPhotoUrl } from "../lib/people"
import { usePeople } from "../state/people"

/**
 * One person or group, as a face — their QueuePilot photo when they have one, a colored
 * initial otherwise.
 *
 * ### This is Charcuterie's `Avatar`, adapted
 *
 * Until 2026-10-22 this was a hand-rolled circle, written as the app's stand-in for an
 * `Avatar` that `@charcuterie/ui@3.10.0` did not have. The library has one now, and it already
 * does the hard part of a photo: an image that 404s or fails to decode falls back to the
 * initials with no empty box in between. Adding photos to the hand-rolled circle would have
 * been fixing a shared shape per app (decision
 * `2026-10-22-a-person-photo-is-a-row-in-the-book-of-record`). What stays here is the APP's
 * half, exactly as `SelectListbox` adapts `Picker`:
 *
 *  - **Which photo.** A person's `photoVersion` comes from the people slice, so no caller has
 *    to thread it through. A GROUP never has one — `kind` is what keeps a group whose id
 *    happens to equal a person's from wearing that person's face.
 *  - **The color key is the ID**, never the name, so a rename does not repaint somebody.
 *  - **Required vs nice-to-have.** A nice-to-have face is drawn `soft` rather than `solid`, and
 *    the callers that show one (`PeopleRow`, `QueuePeopleBadge`) say "nice to have" in text as
 *    well.
 *  - **One size: the library's smallest.** `Avatar` sizes itself in `em` of the type scale, and
 *    at this app's density its `sm` step is already ~30 px — bigger than the 26 px circle this
 *    replaced, and big enough for a photo to read as somebody. Its `md` (~34 px) made initials
 *    heavier than the names printed beside them. The old 19 px "small" face has no library
 *    step; an `xs` would be a Charcuterie change, not an app override.
 *
 * ### Colour is never the only channel
 *
 * The face is decoration beside a name the caller prints, so it is `aria-hidden` and the
 * caller's text is the accessible name. `Avatar` would otherwise announce itself as an image
 * of the same name, and the name would be read twice.
 *
 * `data-person-face` is a DOM handle for the e2e harnesses and carries no style.
 */
export function PersonFace({
  id,
  isOptional = false,
  kind = "person",
  label,
}: {
  /** The id, NOT the name — a rename must not move somebody's colour. */
  id: string
  label: string
  /** Nice-to-have. Drawn soft rather than solid. */
  isOptional?: boolean
  /** A group has no photo. Defaults to a person, which is every caller but the group ones. */
  kind?: "person" | "group"
}) {
  const { people } = usePeople()
  const imageUrl =
    kind === "person"
      ? personPhotoUrl(
          id,
          people.find((person) => person.id === id)
            ?.photoVersion,
        )
      : undefined

  return (
    <Avatar
      appearance={isOptional ? "soft" : "solid"}
      aria-hidden="true"
      categoricalKey={id}
      data-has-photo={imageUrl ? "true" : undefined}
      data-person-face={kind}
      imageUrl={imageUrl}
      initials={initials(label)}
      name={label || id}
      size="sm"
    />
  )
}

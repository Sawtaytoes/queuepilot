import { hueFor, initials } from "../lib/people"

/**
 * One person or group, as a coloured initial.
 *
 * ### Why this is an APP component and not a Charcuterie one
 *
 * `@charcuterie/ui@3.10.0` has no `Avatar`. It has `Badge`, `Swatch`, `MediaTile` and
 * `Board`, and none of them is this shape — a `Badge` is a pill of text and a `Swatch` is a
 * colour with no glyph in it. So an `Avatar` is a genuine LIBRARY GAP, and this component is
 * the app's stand-in until it is filled, not a decision to keep the shape local. It is
 * deliberately small and prop-driven so it can be deleted in one commit when the library
 * ships one.
 *
 * The DATA half is the app's either way: hashing an id into a hue is exactly what Folio does
 * with a repo name, and the library would take the hue as a prop rather than compute it.
 *
 * ### Colour is never the only channel
 *
 * The circle carries a hue AND the initials AND — through its `title` — the whole name. A
 * bare coloured dot is a WCAG 1.4.1 failure and is invisible to a screen reader, which is the
 * same rule `BoardCard`'s accent bar states about itself. `aria-hidden` on the circle and the
 * real name in text beside it is the shape every caller here uses.
 */
export function PersonFace({
  id,
  isOptional = false,
  label,
  size = "md",
}: {
  /** The id, NOT the name — a rename must not move somebody's colour. */
  id: string
  label: string
  /** Nice-to-have. Drawn smaller and dashed, which is how the queue list says "optional"
   *  without a word. */
  isOptional?: boolean
  size?: "sm" | "md"
}) {
  return (
    <span
      aria-hidden="true"
      className={`pface${size === "sm" ? " sm" : ""}${isOptional ? " opt" : ""}`}
      style={
        { "--pface-hue": hueFor(id) } as React.CSSProperties
      }
    >
      {initials(label)}
    </span>
  )
}

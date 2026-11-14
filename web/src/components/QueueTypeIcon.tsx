/**
 * A glyph each, so the tile's hue lands on something with a shape.
 *
 * `@charcuterie/ui@4.1.0` colours a tile's icon in the tile's own categorical hue and
 * sits it beside the name. Without an `icon` the colour is only the left bar, which
 * reads as decoration; with one it is the thing the eye goes to first.
 *
 * Paths, never emoji or a symbol font — charcuterie's
 * `2026-07-29-ship-no-icons-and-no-symbol-glyphs`. `currentColor` is what the library
 * sets, so neither of these states a colour.
 */
export function QueueTypeIcon({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width="24"
    >
      {children}
    </svg>
  )
}

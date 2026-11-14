/**
 * ↑ / ↓ — into the Priority queue, or back out to the Random pool.
 *
 * The arrow points the way the tile MOVES on screen: the Priority lane is drawn above the
 * pool, so up is a promote and down is a demote. It is the same write the drag across the
 * lane divider makes, for a pointer that would rather press a button than drag one
 * (owner, 2026-08-26).
 */
export const LaneGlyph = ({ isUp }: { isUp: boolean }) => (
  <svg
    aria-hidden="true"
    fill="none"
    height="13"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 14 14"
    width="13"
  >
    {isUp ? (
      <path d="M7 11.5V2.5M3 6.5l4-4 4 4" />
    ) : (
      <path d="M7 2.5v9M3 7.5l4 4 4-4" />
    )}
  </svg>
)

/**
 * ✓ — the select mark, as an SVG.
 *
 * It was the TEXT character `✓` until 2026-08-26, and it never painted: the rule that turns a
 * selected tile's circle accent (`.tile.selected .check`) is outranked by the one that draws
 * the circle in the first place (`.editable .tile .tilechrome .check`), so the mark stayed
 * `color: transparent` in every state and the control looked identical checked and unchecked.
 * The same reason `.remove` gives for its ×: a font glyph is not a reliable icon here.
 */
export const CheckGlyph = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="13"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2.5"
    viewBox="0 0 14 14"
    width="13"
  >
    <path d="M2.5 7.5l3 3 6-6.5" />
  </svg>
)

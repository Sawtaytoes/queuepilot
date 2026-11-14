/** Choose where this starts. A clock face, not the "⏱" character: a glyph that is a tofu
 *  box in some fonts is the same defect the Watched chip was written to avoid. */
export const StartGlyph = () => (
  <svg
    aria-hidden="true"
    height="14"
    viewBox="0 0 14 14"
    width="14"
  >
    <circle
      cx="7"
      cy="7"
      fill="none"
      r="5.5"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <path
      d="M7 3.8V7l2.3 1.6"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.6"
    />
  </svg>
)

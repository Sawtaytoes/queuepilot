export function CollapseIcon({
  isCollapsed,
}: {
  isCollapsed: boolean
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="20"
    >
      <path
        d={isCollapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"}
      />
    </svg>
  )
}

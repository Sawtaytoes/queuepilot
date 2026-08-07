import { Tooltip } from "@charcuterie/ui"
import type { ReactElement } from "react"

/**
 * The Charcuterie `Tooltip`, but a no-op when there's nothing to add — so a caller can
 * pass a maybe-null label without branching, and a tip only ever appears when it says
 * something. `children` is a SINGLE element the tip clones onto (not wrapped); on the
 * touch kiosk the tip simply never shows, which is the component's own contract.
 */
export function Tip({
  children,
  label,
}: {
  children: ReactElement
  label?: string | null
}): ReactElement {
  return label ? <Tooltip label={label}>{children}</Tooltip> : children
}

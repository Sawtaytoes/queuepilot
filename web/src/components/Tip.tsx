import { useClonedChild } from "@charcuterie/logic"
import { Tooltip, type TooltipProps } from "@charcuterie/ui"
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
  ...slotProps
}: {
  children: ReactElement
  label?: string | null
} & Omit<
  TooltipProps,
  "children" | "label"
>): ReactElement {
  // `Tip` is itself a slot. A `Menu` can clone its anchor props onto this component,
  // so those props must continue to the button at the bottom of the chain. Dropping the
  // injected `ref` leaves floating-ui without an anchor and puts the menu at (0, 0).
  const slottedChild = useClonedChild(children, slotProps)

  return label ? (
    <Tooltip label={label}>{slottedChild}</Tooltip>
  ) : (
    slottedChild
  )
}

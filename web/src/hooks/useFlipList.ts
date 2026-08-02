import { useLayoutEffect, useRef } from "react"

import { prefersReducedMotion } from "../lib/flip"

/**
 * React's half of FLIP, for a list React itself renders.
 *
 * The vanilla `flipPaint()` measured, mutated, then measured again — all inside one
 * function. React splits those apart: the mutation is the commit. So the "First"
 * measurement happens in the RENDER phase, where the DOM still holds the previous
 * commit, and the "Last" measurement + animation happen in a layout effect.
 *
 * Measuring the DOM during render is impure, and it is also the only place the
 * pre-mutation boxes still exist. It is safe here specifically because the read has
 * no side effect on the tree: under StrictMode's double render it simply measures
 * the same unchanged DOM twice.
 *
 * `signature` is what identifies "the list changed" — pass a join of the keys plus
 * whatever else re-orders them. `animate` is false for a first paint of a newly
 * opened queue (the vanilla `gridPaintedSet === set` test), because opening a
 * different queue is not a shuffle of the current one.
 */
export function useFlipList(
  ref: { current: HTMLElement | null },
  signature: string,
  animate: boolean,
) {
  const before = useRef<Map<string, DOMRect> | null>(null)
  const lastSignature = useRef<string | null>(null)

  if (
    animate &&
    ref.current &&
    lastSignature.current !== signature &&
    !prefersReducedMotion()
  ) {
    const map = new Map<string, DOMRect>()

    for (const t of ref.current.querySelectorAll<HTMLElement>("li.tile")) {
      if (t.dataset.key) map.set(t.dataset.key, t.getBoundingClientRect())
    }

    before.current = map
  }

  useLayoutEffect(() => {
    const container = ref.current
    const first = before.current

    lastSignature.current = signature
    before.current = null

    if (!container || !first || !animate || prefersReducedMotion()) return

    for (const t of container.querySelectorAll<HTMLElement>("li.tile")) {
      const last = t.getBoundingClientRect()
      const start = t.dataset.key ? first.get(t.dataset.key) : undefined

      if (!start) {
        t.animate(
          [
            { opacity: 0, transform: "scale(0.92)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 180, easing: "ease-out" },
        )

        continue
      }

      const dx = start.left - last.left
      const dy = start.top - last.top

      if (dx || dy) {
        t.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          { duration: 240, easing: "cubic-bezier(.2,.7,.3,1)" },
        )
      }
    }
    // `signature` is the whole dependency: it changes exactly when the list did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
}

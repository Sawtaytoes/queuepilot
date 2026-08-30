/** The nearest ancestor that owns vertical scrolling, or the document when none does. */
export const findVerticalScrollRegion = (
  element: HTMLElement,
): HTMLElement | null => {
  let ancestor = element.parentElement

  while (ancestor) {
    const overflow = getComputedStyle(ancestor).overflowY

    if (overflow === "auto" || overflow === "scroll")
      return ancestor

    ancestor = ancestor.parentElement
  }

  return null
}

export const scrollRegionBy = (
  region: HTMLElement | null,
  delta: number,
) => {
  // A direct offset is synchronous. The drag loop reads the new value in the same frame to
  // decide whether it should keep moving while the pointer stays at the edge.
  if (region) region.scrollTop += delta
  else window.scrollBy(0, delta)
}

export const scrollRegionTop = (
  region: HTMLElement | null,
) =>
  region?.scrollTop ??
  document.scrollingElement?.scrollTop ??
  window.scrollY

export const scrollRegionTo = (
  region: HTMLElement | null,
  top: number,
) => {
  if (region) region.scrollTop = top
  else window.scrollTo(0, top)
}

/** The work-page scroll owner installed by Charcuterie's viewport-height `Shell`. */
export const pageScrollRegion = () =>
  document.querySelector<HTMLElement>("main")

/** Viewport coordinates for the visible part of a vertical scroll owner. */
export const scrollRegionBounds = (
  region: HTMLElement | null,
) => {
  if (region) {
    const rect = region.getBoundingClientRect()

    return { bottom: rect.bottom, top: rect.top }
  }

  const viewport = window.visualViewport
  const top = viewport?.offsetTop ?? 0

  return {
    bottom: top + (viewport?.height ?? window.innerHeight),
    top,
  }
}

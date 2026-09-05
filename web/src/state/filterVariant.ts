import type { LandingFilterVariant } from "../components/LandingFilterBar"
import { LANDING_FILTER_VARIANTS } from "../components/LandingFilterBar"

/**
 * ⚠️ TEMPORARY. Which filter-bar layout to draw, read off `?layout=` — a PREVIEW SWITCH, so
 * the owner can compare the chip row against the two multi-select dropdowns he proposed on
 * the real page with a real roster, rather than from a description.
 *
 * > "I kinda think both of those could be handled by 2 multi-select combobox dropdowns
 * > instead. Just a thought. We can play around with it and see what looks better."
 *
 * Two of the three layouts and this whole file are deleted once he picks. It is in the query
 * string, not `localStorage`, because a preview you compare has to be two addresses you can
 * hold open in two tabs.
 */
export function parseLayout(
  search: string,
): LandingFilterVariant {
  const value = new URLSearchParams(search).get("layout")

  return LANDING_FILTER_VARIANTS.includes(
    value as LandingFilterVariant,
  )
    ? (value as LandingFilterVariant)
    : "chips"
}

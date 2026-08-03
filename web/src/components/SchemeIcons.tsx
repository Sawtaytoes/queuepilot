import type { ColorSchemeIcons } from "@charcuterie/ui"
import type { ReactNode } from "react"

/**
 * Sun / moon / monitor glyphs for the colour-scheme switcher.
 *
 * The app ships **no icon library** — every other glyph in the chrome is a raw
 * character (`✎`, `↶`, `↷`, `▶`). Sun/moon/monitor have no clean monochrome
 * single-codepoint form (the emoji ones paint their own colour and fight the
 * ghost-button look), so these are inline `currentColor` SVGs: no new dependency,
 * and they inherit the button's text colour in both light and dark schemes.
 *
 * lucide (the Charcuterie fleet recommendation for icons) was deliberately NOT
 * added — it would be the app's first icon dependency for three glyphs. If a
 * broader icon set is ever wanted, adopt it then and swap these three.
 */

const svgProps = {
  fill: "none",
  height: 18,
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 2,
  viewBox: "0 0 24 24",
  width: 18,
} as const

/** `light` */
function SunIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
}

/** `dark` */
function MoonIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

/** `system` — follow the OS */
function MonitorIcon(): ReactNode {
  return (
    <svg {...svgProps}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

export const schemeIcons: ColorSchemeIcons = {
  dark: <MoonIcon />,
  light: <SunIcon />,
  system: <MonitorIcon />,
}

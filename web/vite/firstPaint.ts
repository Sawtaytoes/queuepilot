import {
  buildFirstPaintScript,
  DEFAULT_COLOR_SCHEME_STORAGE_KEY,
  daylight,
} from "@charcuterie/tokens"
import type { Plugin } from "vite"

/**
 * Inject the `@charcuterie/tokens` first-paint snippet into `<head>` before any
 * stylesheet.
 *
 * The app follows the OS light/dark scheme (and a persisted override), so
 * `<html data-scheme>` can no longer be a constant in `index.html`. Two things must
 * happen before the browser paints a single frame, and only inline script in
 * `<head>` runs that early:
 *
 *  1. `data-scheme` is set from the resolved choice — the same rule the runtime
 *     `useColorScheme` core uses (`stored === "dark" || ((null|system) && matchMedia)`),
 *     read from the **same** `storageKey` (`charcuterie-scheme`), so the pre-paint
 *     attribute and the hydrated state never disagree by a flash; and
 *  2. the anti-flash background branches on the resolved scheme — written as a
 *     `var(--color-surface-base, <hex>)` fallback so the literal applies only while
 *     the token stylesheet is still loading and the token takes over the instant it
 *     lands (an unlayered raw colour would outrank the token and pin the canvas —
 *     the trap `firstPaintColour.test.ts` guards).
 *
 * `buildFirstPaintScript` derives both surface hexes from the `daylight` token
 * source, so they cannot drift from the palette. The `<script>…</script>` wrapper is
 * stripped because Vite's tag descriptor re-adds it.
 */
export const firstPaintScriptBody = (): string =>
  buildFirstPaintScript(daylight, {
    storageKey: DEFAULT_COLOR_SCHEME_STORAGE_KEY,
  })
    .replace(/^<script>\r?\n?/, "")
    .replace(/\r?\n?<\/script>\s*$/, "")

export const firstPaint = (): Plugin => ({
  name: "plex-channels:first-paint",
  transformIndexHtml: {
    handler: () => [
      {
        children: firstPaintScriptBody(),
        injectTo: "head-prepend",
        tag: "script",
      },
    ],
    order: "pre",
  },
})

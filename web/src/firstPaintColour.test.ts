import { daylight } from "@charcuterie/tokens"
import { expect, test } from "vitest"

// Read through Vite's `?raw` rather than `node:fs`, so this file stays inside the
// browser program and the tsconfig can keep `"types": []`.
import indexHtml from "../index.html?raw"
import { firstPaintScriptBody } from "../vite/firstPaint"

/**
 * The trap gallery-downloader's port fell into, guarded — now for the DYNAMIC
 * first-paint script.
 *
 * The app follows the OS light/dark scheme, so `data-scheme` and the anti-flash
 * background are no longer static in `index.html`: they are set before first paint
 * by the inline snippet the `firstPaint` Vite plugin injects
 * (`@charcuterie/tokens`' `buildFirstPaintScript(daylight)`). These tests pin the
 * two properties that a wrong port silently loses — the anti-flash literal must be a
 * `var()` FALLBACK (never a raw colour that outranks the token and pins the canvas),
 * and both surface hexes must come from the `daylight` token source.
 */

const script = firstPaintScriptBody()

test("the anti-flash background is a var() fallback, never a raw pinned colour", () => {
  // The one form that is safe: the literal applies only while
  // `--color-surface-base` is still undefined, then the token takes over.
  expect(script).toContain("background-color:var(--color-surface-base,")

  // A bare `background: #hex` / `background-color: #hex` is the exact regression —
  // unlayered, it beats Tailwind's `@layer utilities` token and pins the page.
  expect(script).not.toMatch(/background(?:-color)?\s*:\s*#/)
})

test("both surface hexes come from the daylight token source", () => {
  const darkBase = daylight.schemes.dark.surface.base
  const lightBase = daylight.schemes.light.surface.base

  expect(darkBase).toMatch(/^#[0-9A-Fa-f]{6}$/)
  expect(lightBase).toMatch(/^#[0-9A-Fa-f]{6}$/)

  // Branches on the resolved scheme rather than pinning one — otherwise a
  // dark-default fallback flashes on a light-resolved load.
  expect(script).toContain(darkBase)
  expect(script).toContain(lightBase)
})

test("the script sets data-scheme from the shared storage key", () => {
  // Same key the runtime `localStoragePersistence` uses, or the pre-paint attribute
  // and the hydrated state disagree by exactly one flash.
  expect(script).toContain('"charcuterie-scheme"')
  expect(script).toContain('setAttribute("data-scheme"')
})

test("index.html no longer statically pins a scheme", () => {
  // The scheme is resolved at runtime; a hardcoded `data-scheme` would be a second,
  // stale source of truth that fights the switcher.
  const htmlTag = indexHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .match(/<html[\s\S]*?>/)?.[0]

  expect(htmlTag).not.toContain("data-scheme")
  // No leftover static anti-flash block, either — the script owns it now.
  expect(indexHtml).not.toContain("<style>")
})

test("data-variant is omitted and data-density is carried", () => {
  const htmlTag = indexHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .match(/<html[\s\S]*?>/)?.[0]

  expect(htmlTag).toContain("data-density")
  expect(htmlTag).not.toContain("data-variant")
})

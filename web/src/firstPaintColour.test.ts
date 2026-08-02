import { daylight } from "@charcuterie/tokens"
import { expect, test } from "vitest"

// Read through Vite's `?raw` rather than `node:fs`, so this file stays inside the
// browser program and the tsconfig can keep `"types": []`.
import indexHtml from "../index.html?raw"

/**
 * The trap gallery-downloader's port fell into, guarded.
 *
 * An inline `<style>` is UNLAYERED, and unlayered author CSS beats every `@layer`
 * regardless of specificity. Tailwind v4 emits utilities into `@layer utilities`.
 * So a flat `background-color: #131822` in the anti-flash rule silently outranks
 * the token on `<body>` and pins the canvas dark forever — light mode then renders
 * as light cards on a dark page. Neither a typecheck nor a build nor an axe run can
 * see it: the CSS is valid, the utility is emitted, and it just loses.
 *
 * Written as a `var()` FALLBACK, the literal applies only while
 * `--color-surface-base` is undefined, which is the only thing the rule was ever
 * for.
 */

test("the anti-flash background is daylight's dark surface", () => {
  const expected = daylight.schemes.dark.surface.base

  expect(expected).toMatch(/^#[0-9A-Fa-f]{6}$/)
  expect(indexHtml).toContain(`var(--color-surface-base, ${expected})`)
})

test("no unlayered rule pins a raw colour on the canvas", () => {
  const inlineStyle = indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1]

  expect(inlineStyle).toBeTypeOf("string")

  const declarations = (inlineStyle ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .match(/background(?:-color)?\s*:[^;}]+/g)

  expect(declarations?.length).toBeGreaterThan(0)

  for (const declaration of declarations ?? []) {
    expect(declaration).toContain("var(--color-")
  }
})

test("the document declares the scheme it is painted in", () => {
  expect(indexHtml).toContain('data-scheme="dark"')
  expect(indexHtml).toContain("color-scheme: dark")
})

test("data-variant is omitted — daylight is the default and :root carries it", () => {
  // Only the real `<html>` tag matters; the file's own comment says the word
  // (which is why the comments come out first).
  const htmlTag = indexHtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .match(/<html[\s\S]*?>/)?.[0]

  expect(htmlTag).toContain("data-scheme")
  expect(htmlTag).not.toContain("data-variant")
})

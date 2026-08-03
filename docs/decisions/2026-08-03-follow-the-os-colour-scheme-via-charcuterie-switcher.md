# Follow the OS light/dark scheme via Charcuterie's `ColorSchemeSwitcher`

- **Status:** Proposed (PR `feat/os-color-scheme`) — one OPEN question for the owner, below
- **Date:** 2026-08-03
- **Type:** Frontend behavior / UI
- **Supersedes:** the hardcoded `data-scheme="dark"` in `web/index.html`
- **Superseded by:** —

## Decision

plex-channels stops pinning `data-scheme="dark"` and instead **follows the OS
light/dark scheme**, with a user override, using the Charcuterie 1.1 scheme stack:

- **Header switcher.** `@charcuterie/ui`'s `<ColorSchemeSwitcher>` sits at the right
  of the header `.bar`, after undo/redo — a cycling single-button `IconButton`
  (`appearance="ghost"`, matching the sibling ghost icon buttons). It wires the three
  browser defaults from `@charcuterie/logic/browser` itself: `matchMedia` resolver,
  `localStorage` persistence under the shared key `charcuterie-scheme`, and
  `data-scheme` written on `<html>`. The app supplies only the glyphs.
- **Vocabulary + default.** `mode` is `light | dark | system`; the default is
  **`system`**. The button cycles **light → dark → system**. `resolvedScheme`
  (`light | dark`) is what reaches `data-scheme`; in `system` it tracks the OS live
  (an OS flip re-themes with no click and is NOT persisted).
- **First paint.** `web/index.html` no longer carries a scheme or a static anti-flash
  `<style>`. A `firstPaint` Vite plugin (`web/vite/firstPaint.ts`) injects
  `@charcuterie/tokens`' `buildFirstPaintScript(daylight)` **head-prepend**, before the
  token stylesheet. That inline script reproduces the core's resolution rule against
  the same `charcuterie-scheme` key and branches the anti-flash background hex on the
  resolved scheme (as a `var(--color-surface-base, <hex>)` fallback) — so a persisted
  or OS-resolved scheme paints correctly on the first frame with no flash.

## Icons — inline SVG, not a new dependency

The app ships **no icon library** (every glyph in the chrome is a raw character:
`✎`, `↶`, `↷`, `▶`). `ColorSchemeToggle` requires `icons: { light, dark, system }`
as `ReactNode`s; Charcuterie ships none (lucide is its recommendation). Rather than
add lucide for three glyphs, `web/src/components/SchemeIcons.tsx` provides inline
`currentColor` sun/moon/monitor SVGs — no dependency, and they inherit the button's
text colour in both schemes. **Flag:** if a broader icon set is ever wanted, adopt
lucide then and swap these three.

## OPEN QUESTION — the kids' wall display (owner decision needed before this ships)

plex-channels renders the **kids' Plex cards**, a surface that may live on an
**always-on wall display**. Defaulting to `system` means that display will render
**light** if its OS/browser reports a light `prefers-color-scheme` — a bright panel on
a wall, a behavior change from today's always-dark.

This is intentionally left for the owner to decide. The mechanism already supports
either answer at zero code cost, because the persisted choice wins over the OS:

- **Pin that surface dark** — set the scheme to Dark once on the wall-display browser
  (one click on the switcher, or seed `localStorage['charcuterie-scheme'] = "dark"`).
  The persisted `dark` overrides `system`, and first paint honours it.
- **Or make dark the app default** — change the switcher's initial `mode` to `"dark"`
  (and the first-paint fallback) so *every* surface with no saved choice stays dark and
  only an explicit pick opts into light. That would be a follow-up decision superseding
  the `system` default above.

**Do not merge/deploy until the owner picks.**

## Why

- The rest of the fleet is moving to OS-follow (rip-deck and gallery-downloader are on
  the same 1.1 switcher); plex-channels was the one still hardcoding dark.
- Adopting `<ColorSchemeSwitcher>` keeps the browser coupling in one component and
  leaves the app DOM-free of `matchMedia`/`localStorage`, consistent with
  `2026-08-02-adopting-a-component-means-deleting-its-skin.md` (the app keeps layout +
  selectors only; the control's skin is the component's).

## Evidence

Branch `feat/os-color-scheme`. Verified live on the Vite dev server (driven in an
isolated Playwright context, screenshots in `__screenshots__/`):

| State | OS | Stored | `data-scheme` | Note |
| --- | --- | --- | --- | --- |
| system | light | — | `light` | monitor icon |
| system | dark | — | `dark` | **follows OS, no click, not persisted** |
| light (clicked) | dark | `light` | `light` | pin beats OS |
| dark (clicked) | dark | `dark` | `dark` | cycle next = System |
| reload | light | `dark` | `dark` **at load** | **no flash** — first-paint honours the pin |

Gates re-run green: `web typecheck`, `web test` (29 — the rewritten
`firstPaintColour.test.ts` now guards the dynamic script's `var()` fallback + token
provenance), `web build` (first-paint script injected before the CSS link in
`dist/index.html`).

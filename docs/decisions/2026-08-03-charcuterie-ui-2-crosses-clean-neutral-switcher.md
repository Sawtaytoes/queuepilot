# Crossing `@charcuterie/ui` 2.x is clean for plex-channels; the scheme switcher goes neutral

- **Status:** Accepted (PR `feat/charcuterie-ui-2`)
- **Date:** 2026-08-03
- **Type:** Frontend dependency / measured compatibility
- **Supersedes:** the `@charcuterie/ui: ^1.1.0` pin from
  `2026-08-03-follow-the-os-colour-scheme-via-charcuterie-switcher.md`
- **Superseded by:** —

## Decision

Bump `@charcuterie/ui` to **`^2.2.0`** (and `@charcuterie/tokens` to `^1.1.1`;
`@charcuterie/logic` stays `^1.1.0`). **No source change** — the header scheme
switcher renders as neutral chrome for free, and crossing the 2.0.0 major breaks
nothing in this app.

## Why the switcher changes with no code

`ColorSchemeToggle`/`ColorSchemeSwitcher` gained an `intent` prop **defaulting to
`neutral`** (verified in the installed `@charcuterie/ui@2.2.0`
`dist/ColorSchemeToggle/ColorSchemeToggle.d.ts`). `Header.tsx` renders
`<ColorSchemeSwitcher icons={schemeIcons} />` with no `intent`/`appearance` override,
so it inherits the neutral default: `text-content-primary` icon,
`hover:bg-intent-neutral-surface`, focus-ring intact — instead of the 1.x
accent-violet icon with an invisible hover. (Note: the fleet's *local* charcuterie
checkout lagged the npm release at the time — 2.1.0, no `intent` prop — but the
published 2.2.0 package the app installs has it.)

## What 2.0.0 actually breaks here: nothing

The 2.0.0 breaking set (the M8 overlay rebuild) is **entirely overlay-scoped**:

- `Modal` → renamed `Dialog` (chrome); a new base-layer `Modal` takes the old name.
- Type `ModalSize` → `DialogSize` (`ModalSize` export removed).
- Overlays portal to `document.body`; `Popover`/`Menu`/`Tooltip` reworked;
  `popover="manual"`/`showPopover()` removed. New `Listbox`/`Combobox` (additive).

plex-channels imports **none** of these. It uses its **own** modal (charcuterie's
`Modal` was never adopted — it lacked a `<form>`; see
`2026-08-02-components-that-cannot-be-adopted-yet.md`) and imports only
`Accordion`, `Select` (native `<select>`, no overlay dependency), `Badge`,
`EmptyState`, and `ColorSchemeSwitcher` — all untouched across the entire 2.x line.

**Measured, not assumed:** on `@charcuterie/ui@2.2.0` — `tsc --noEmit` clean, 29 unit
tests pass, `vite build` green. Lockfile pulled a new transitive
`@tanstack/react-virtual@3.14.9` (a 2.x overlay dep we don't use; tree-shaken, bundle
unchanged at ~288 KB).

## Evidence

Branch `feat/charcuterie-ui-2`. Switcher verified live (isolated browser, dev server):
button classes carry `intent-neutral` (not `intent-accent`),
`hover:bg-intent-neutral-surface`, and the `focus-visible:outline-focus-ring` set; icon
computed colour is `#171D28` (light) / `#EDF0F5` (dark) — content-primary, not violet.
Screenshots in `__screenshots__/ui2-*.png`. Wall-display default stays `system`.

# Adopting a `@charcuterie/ui` component means deleting the app's skin for it

- **Status:** Accepted
- **Date:** 2026-08-02
- **Type:** Frontend convention
- **Supersedes:** —
- **Superseded by:** —

## Decision

When a hand-rolled control in `web/src` is replaced by a `@charcuterie/ui`
component, the app's own **skin** declarations for that control are **deleted**,
not kept and not merged: `background`, `border`, `border-radius`, `padding`,
`font`, and every `color` that the component's `intent` now supplies.

`app.css` keeps only two things about a migrated control:

1. **Layout** — where the control sits and how wide it is in ITS container
   (`flex`, `width`, `grid-column`, `margin`).
2. **Selectors** — the class names the e2e suites read. They stay on the element
   via the component's `className` prop, carrying no declarations of their own.

## Context

`web/src/styles/app.css` is **unlayered**. Tailwind emits its utilities into
`@layer utilities`, and unlayered CSS beats every `@layer` regardless of
specificity. So an app rule and a component utility naming the same property is
not a close call — the app rule wins every time, silently, with the build green.

Found on the first migrated control. `.playrow .rowtier { padding: 6px 8px }`
outranked `Select`'s `pe-9`, which is the padding that reserves room for the
chevron `Select` draws in an absolutely-positioned overlay. The chevron printed
on top of the label text. `.addpos select`, `.chhead select`, `#selbar select`
and `.tile .eps select` all carried the same declaration.

The same trap, one component later: `.badge.movie`/`.show`/`.collection`/`.warn`
each set `color` and `border-color`. Kept, they would have made `intent` a prop
that typechecks, renders, and does nothing.

This is the same failure mode M6e recorded for gallery-downloader (an unlayered
inline `<style>` pinning the canvas dark against the token) pointed at the app's
own stylesheet rather than at `index.html`.

## Why

- A skin that outranks the component is worse than no component: the app pays the
  bundle cost and the API cost and keeps its old appearance, and nothing reports
  it. `intent`, `size` and `appearance` become decoration.
- It cannot be caught by typecheck, unit tests, or the e2e suites — every one of
  those passed with the chevron sitting on top of the text. **Only a screenshot
  found it.**
- Keeping the class names but emptying them preserves the DOM contract the
  seventeen Playwright suites gate the port with, at zero cost.

## Evidence

Phase 2 of M6d, branch `feat/m6d-charcuterie-ui`.

Measured on the Play landing before the skin was removed: `.rowtier` computed
`padding-right: 8px` where `Select` asks for `2.25rem`, and the chevron `<svg>`
landed at x=413–430 inside a control ending at x=442 — on top of the label.
After: `padding-right: 38.25px`, chevron clear, control 151px wide and back
inline on the title row instead of 403px on a line of its own.

See also `2026-08-02-the-library-wrapper-is-sized-by-the-app.md` for the layout
half of the same boundary.

# The `app.css` `@layer` fix (F6) is a separate, screenshot-gated change — not yet shipped

- **Status:** Proposed (deferred)
- **Date:** 2026-08-03
- **Type:** Frontend convention / build
- **Supersedes:** —
- **Superseded by:** —
- **Relates to:** [2026-08-02-adopting-a-component-means-deleting-its-skin](2026-08-02-adopting-a-component-means-deleting-its-skin.md)

## Decision

The proposed fix for the unlayered-`app.css` hazard —

```css
@layer theme, base, components, app, utilities;
/* …with app.css's own rules wrapped in @layer app { … } */
```

— is **not shipped in the first-load-performance batch (Phases A–F1–F5)**. It is recorded here
as the remaining isolated change, to be made on its own and gated on screenshot review.

## Context

`web/src/styles/app.css` is unlayered, and unlayered CSS beats every Tailwind `@layer`
regardless of specificity (established in
[2026-08-02-adopting-a-component-means-deleting-its-skin](2026-08-02-adopting-a-component-means-deleting-its-skin.md)).
So any app rule naming a property a `@charcuterie/ui` component also sets wins **silently**,
with the build green. The layer fix converts that silent trap into a loud one: app rules move
**below** Tailwind's `utilities`, so a component's utilities win by default and a deliberate
override must be written explicitly.

## Why it is deferred, not done

1. **It changes dozens of controls at once.** Wrapping ~850 lines of `app.css` below
   `utilities` flips every place an app rule currently (intentionally or not) overrides a
   component utility. That is a large, wide blast radius in one commit.
2. **Its gate is a screenshot, and the batch it would ride in had no screenshot review.** The
   original skin-collision bug (a chevron printed on top of label text) *passed* typecheck,
   unit tests, and all seventeen Playwright suites — **only a screenshot found it**. Shipping
   the layer fix without that review would be shipping the one change most likely to regress
   exactly the way the suites cannot catch.
3. **It is defensive, not a fix.** Nothing user-facing is broken today by the absence of the
   layer fix; F1–F5 deleted the specific skins they touched by hand per the skin-deletion
   decision. The layer fix is insurance for *future* adoptions.

## When to do it

As its own change, gated on:

- the full Playwright suite (necessary, not sufficient), **plus**
- `e2e/shots.mjs` screenshot review at desktop and 760px, **in both `data-scheme` values and
  both densities**, because the failure mode is visual and scheme/density-dependent.

Until then, the skin-deletion discipline (delete the app skin when adopting a component) is the
active guardrail, applied by hand.

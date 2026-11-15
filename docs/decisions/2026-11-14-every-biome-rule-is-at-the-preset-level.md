# Every Biome rule is at the preset's level, and app.css orders rules by their ending

- **Status:** Accepted
- **Date:** 2026-11-14
- **Type:** Tooling / CI
- **Supersedes:** In part, [Lint warnings fail CI](2026-11-14-lint-warnings-fail-ci.md): item 4's
  statement that the other rules `biome.json` lowers keep their lower level. The rest of that
  record stands.
- **Superseded by:** —

## Decision

1. `biome.json` lowers no rule. `style/noNonNullAssertion`, `a11y/noNoninteractiveTabindex`,
   `a11y/noStaticElementInteractions` and `a11y/useKeyWithClickEvents` are back at the preset's
   level in `web/`, and `style/noDescendingSpecificity` is back in `web/src/styles/app.css`. The
   `noLabelWithoutControl` entry stays: it names this app's own input components and keeps the
   preset's `error` level.
2. A `!` becomes a guard, a narrowed type, or `defined()`. `defined()` now lives in
   `shared/defined.ts` so the web app can use it; `server/src/defined.ts` re-exports it, so
   every existing import still works.
3. A click handler sits on a control. The renameable heading's text is a `<button>` and a tab
   stop, because the Narrow View hides the Rename pen and the heading is then the only way to
   rename from the keyboard. A startable next-up line on a tile is a `<button>`. A tile's `<li>`
   is no longer a tab stop: it had no role and no key action, and the controls inside it are
   tab stops of their own. In a search list, Escape from a row's own control closes the results
   and returns focus to the input.
4. In `app.css`, the first rule that ends in a given selector (its last compound selector, such
   as `p`, `.field`, `.libs` or `a:hover`) is the least specific rule with that ending. A rule
   that had to move for this carries a comment that says so.

## Context

The owner, on 2026-11-14, about the rules the earlier record left off: *"We can enable and fix
those."*

The earlier record left five rules off because each still had findings: `noNonNullAssertion`
(54), the three a11y rules (4), and `noDescendingSpecificity` (43).

## Why

A rule that is off checks nothing, and its findings can grow without anyone seeing them.

Biome's `noDescendingSpecificity` remembers the first rule for each ending and reports each later
rule with that ending that is less specific. It reads `@media` blocks in the same pass. Two
rules with the same ending often style different parts of the page, so the rule cannot tell a
real conflict from a coincidence. Ordering by ending still helps a reader, because the file
order and the cascade then agree.

Moving a less specific rule earlier, or a more specific one later, never changes which of the
two wins. A move can change the result only against a rule of the SAME specificity that styles
the same element, so each move was checked for that.

## Evidence

- Before, on `main` at `fef3419`, with the five rules at the preset's level: 54
  `noNonNullAssertion`, 1 `noNoninteractiveTabindex`, 1 `noStaticElementInteractions`, 2
  `useKeyWithClickEvents` and 43 `noDescendingSpecificity` findings. After: 0 Biome warnings or
  errors (the 32 infos are unchanged) and 0 ESLint warnings.
- No `biome-ignore` was added.
- The `app.css` moves were checked two ways. A script compared every pair of selectors whose
  order changed, and reported each pair with equal specificity, the same `!important`, and an
  overlapping property. Each reported pair was read by hand and styles different elements.
  Then the 13 VRT screens and the Configure modal were rendered from `main` and from this
  change, wide and narrow, light and dark. Every element's computed style matched. The only new
  element is the heading's rename `<button>`, and those screenshots are byte-identical.

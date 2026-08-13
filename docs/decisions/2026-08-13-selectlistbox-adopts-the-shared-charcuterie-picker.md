# `SelectListbox` adopts the shared `@charcuterie/ui` `Picker`

**Status:** Accepted
**Date:** 2026-08-13
**Type:** UI · Dependency
**Supersedes:** —
**Superseded by:** —

## Decision

`web/src/components/SelectListbox.tsx` stops assembling its own trigger
(`useVisibility` + `Button` + `Listbox` + a hand-rolled chevron) and becomes a thin
adapter over **`Picker`**, shipped in `@charcuterie/ui@2.15.0`.

The component **keeps its name and its props**, so all **nine call sites are unchanged**.
Requires `@charcuterie/ui@^2.15.0`, `@charcuterie/logic@^1.5.0`, `@charcuterie/tokens@^1.5.0`
(logic must move too: the `ui` barrel now pulls `QueryBuilder`, which imports
`createTree`/`selectRootGroup` from `logic@1.5`).

This **extends, and does not reverse,**
[2026-08-07](2026-08-07-plex-channels-pickers-are-listbox-not-native-select.md) — every
picker is still a Charcuterie `Listbox`. Only who assembles the trigger changes.

## Context

Charcuterie's
[`Picker` record](https://github.com/Sawtaytoes/charcuterie/blob/main/docs/decisions/2026-08-13-picker-is-the-assembled-listbox-and-listbox-stays-trigger-agnostic.md)
counted **four** independent copies of the same thirty lines across the fleet — this repo's
`SelectListbox` among them, alongside board-games' `SelectMenu`, mux-magic's `ListboxPicker`,
and twice inside `@charcuterie/ui` itself. `Picker` is the shared assembly; this is one of
the two app-side adoptions it left deliberately un-migrated.

## Why

- **Two of the four copies had drifted into defects.** Ours was one: the trigger's
  accessible name was a bare `aria-label={label}`, which does **not** contain the button's
  visible text (the current value) — a WCAG 2.5.3 "Label in Name" failure.
- **The `id` trap this repo already paid for is now documented on the component**, so the
  next adopter does not rediscover it through broken selectors.

## What this file still owns, and why it is not deleted

Two things here are the app's, not the library's:

- **`data-value` inside every option label.** `e2e/pick.mjs` picks by VALUE
  (`[role="option"] [data-value="…"]`) — that is what replaced `selectOption(sel, value)`
  when the native `<select>` went away. `textValue` keeps the plain string as the type-ahead
  target and the trigger's text.
- **The `id` → `data-testid` swap.** `useAnchoredOverlay` overwrites the trigger's `id`, so
  an `id` never survives; the suite's stable handle is `data-testid`.

The old placeholder fallback chain (`value` → `placeholder` → first option's label) is
preserved by folding the tail into what `Picker` is handed.

## Consequences

- **One behaviour changes, deliberately:** the trigger's accessible name is now
  `"<label>: <value>"` (`"Add to: Top (plays next)"`), not a bare `"Add to"`. That is the
  WCAG fix. No test targeted the old name.
- **Visually inert, and verified so.** Before/after renders of the real component are
  **byte-identical** in both states — `sha256 45e1c9e8…` closed, `1a1154e3…` open.
- **The `pick.mjs` contract has no CI coverage** — see below. It was verified by hand for
  this change; it is not verified on an ongoing basis.

## The coverage gap this change runs into

`e2e/pick.mjs` is exercised only by the **Plex-gated** Playwright step in `ci.yml`, whose own
comment states the secret is unset, *"so that step is skipped on every PR today."* A green CI
on this PR therefore does **not** prove the pickers still work.

It was verified manually instead: the real `SelectListbox` was mounted in a scratch harness
against the published `2.15.0` and driven through the actual `pick.mjs` helpers — `pickValue`,
`pickIndex`, `readOptions`, `readOptionValues`, `readOptionPairs`, `currentValue`, and the
re-click `closeVia` path (which must close, not close-then-reopen). All twelve assertions
passed, plus `data-testid` and the accessible name.

**Follow-up — done, same day.** That harness is now permanent: `web/e2e-harness/` plus
`e2e/pick-contract-test.mjs`, run by the **`pick.mjs` picker contract (browser, no Plex
needed)** step beside the narrow-view horizontal-scroll gate. Eleven assertions, on every
PR. (Status update only — the decision above is unchanged.)

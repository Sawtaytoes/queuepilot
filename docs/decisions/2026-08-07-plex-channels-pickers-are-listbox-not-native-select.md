# plex-channels pickers are a themed `Listbox`, not the native `Select`

- **Status:** Accepted
- **Date:** 2026-08-07
- **Type:** UI / component choice
- **Supersedes:** —
- **Superseded by:** —

## Decision

**Every** single-select picker in plex-channels is a Charcuterie **`Listbox`** (behind a
`Button` trigger), not the native `Select`. The app-local
`web/src/components/SelectListbox.tsx` adapter carries the old `Select` prop shape
(`id`/`label`/`value`/`onChange`/`options`) so each swap is mechanical.

Converted — non-modal: the Play-landing **tier picker** (`ChannelRow`), the **channel** and
**profile** pickers (`#chchannel` / `#chprofile`), the queue **Add-to position** pickers
(queue view + toolbar), the per-item **episodes-per-play**, the selection-bar **Move-to**.
Converted — in-modal (see next section): SetModal (`set-kind`), DynModal (`dyn-behavior`,
`b-profile`), StartModal (`start-series` / `start-season` / `start-episode`).

This reverses the app's earlier "native `Select`" default. That default only ever existed
because `@charcuterie/ui` had **no** `Listbox`/`Combobox` — the owner accepted native as a
stopgap. `@charcuterie/ui@2.0.0` (M8) shipped both, so the stopgap is over.

## Context

The owner, in the running app, flagged three native dropdowns as wrong — the tier picker,
the channel/profile pickers, the Add-to position — and stated the rule directly:

> *"I don't wanna use any native Select components. I only told the agent some time ago
> because we didn't have a Listbox or Combobox component. Now that we do, I'd prefer that
> one."*

This also settles the coexistence question the 2026-08-03
[`handoff-charcuterie-listbox-combobox`](../handoff-charcuterie-listbox-combobox.md) left
open. That handoff said "keep native for plain lists"; the owner has decided plex-channels
does not — themed consistency wins here, and `Listbox` keeps type-ahead + full keyboard nav,
forfeiting only form-submission / `:invalid` / autofill / the mobile wheel, none of which
these controls use.

## The modal blocker — RESOLVED by rebuilding `Modal` on Charcuterie

The reason in-modal pickers *couldn't* be `Listbox` at first: plex-channels' `Modal` was a
**native `<dialog>` + `showModal()`** (browser top layer), and Charcuterie's `Listbox`
portals its panel to `document.body` — **below** the top layer — so the dropdown rendered
*behind* the modal and was unclickable (Playwright's option click was intercepted by the
in-dialog element every time).

Fixed by rewriting `web/src/components/Modal.tsx` to wrap Charcuterie's **base `Modal`** (a
`document.body`-portalled overlay at `--layer-modal`, with its own focus-trap / scrim /
dismiss) instead of a native `<dialog>`. A picker's dropdown now portals to the same body
layer and stacks *above* the modal (verified: `option-on-top`, and the whole in-modal flow
green in `verify-profile-bindings`).

The app `Modal`'s **public API and DOM contract are unchanged** — the three consumers
(DynModal/SetModal/StartModal) are untouched, and the app-styled `#id` box, the `<form
onSubmit>`, `.modalbtns` footer and `.modalx` ✕ are all preserved. Two things had to move:

- **No native `<dialog>` → no `open` attribute / no `.close()`.** The box carries a
  `data-open` attribute while visible; e2e selects `#{id}[data-open]` (was `#{id}[open]`),
  waits for **detach** on close (was `:not([open])`), and closes via the ✕ (was
  `dialog.close()`).
- **`::backdrop` is gone** (Charcuterie renders its own `SharedBackdrop`); `busy.openModals`
  + `html.modal-open` are still maintained in `Modal.tsx` so `uiBusy()` is unaffected.

## Consequences worth knowing

- **`#chchannel` lost its option groups.** `Listbox` has no `optgroup`; the channel picker
  is now flat (dynamic channels first, then curated). Acceptable for a short list.
- **e2e drives pickers differently.** No native `<select>`, so `selectOption` is gone: the
  trigger keeps the old id as **`data-testid`**, each option's label carries **`data-value`**,
  and `e2e/pick.mjs` opens the trigger and clicks `[role=option]`. It closes by re-clicking
  the trigger — **never Escape**, which would close a parent `<dialog>`.
- One-owner state holds: `SelectListbox` seeds the `Listbox` from `value` and reports back
  via `onChange`, exactly as the uncontrolled native `Select` did — so
  [2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer](2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer.md)
  still applies (no `key`).

## Evidence

- Owner quote above (this session), plus the two earlier flags: *"something is very wrong…
  the Select"* (the Play-landing dropdowns) and *"this is the wrong dropdown component… a
  native select from Charcuterie."*
- CI browser suites green after the change: `channels-test`, `ui-test`, `kbd-undo`,
  `homedrag`, `sse`; `verify-pr4-cutover` (19) and `verify-profile-bindings` (16, incl. the
  in-modal `dyn-behavior` + `b-profile` Listboxes) green end to end.
- The modal fix is proven by the DynModal `b-profile` Listbox: its option click, once
  intercepted by the top-layer dialog, now lands (`option-on-top`) and the flow passes.

# An "Add to" menu is a `Menu`, not a `Picker` — the picker rule does not reach it

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** UI / component choice
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Pending tile's **Add to** and the Home toolbar search row's **Add to** are Charcuterie
**`Menu`**s. They are **not** `Picker`/`Listbox`/`SelectListbox`, and converting them to one
would be a regression, not a completion of the 2026-08-07 picker rule.

The test is what the rows *are*, and it is stated in Charcuterie's own `Menu` source:

- a **`menuitem` DOES something** — Rename, Delete, "add this film to Bob — Movies";
- an **`option` IS something** — a value you are choosing and that stays chosen.

Choosing "Bob — Movies" here POSTs `/api/queues/bob/items` and leaves no selected value
behind. On Pending the tile leaves the list entirely; in the toolbar the results stay open
for the next title. Nothing on either screen can afterwards report "Bob — Movies is
selected", because nothing is. That is a menu.

The counter-example is one element away on the same toolbar: **Add to _position_** ("Top
(plays next)" / "Bottom") holds `addPosition` across renders and is correctly a
`SelectListbox`. Same three words in the label, opposite component, and the difference is
only whether a value survives the click.

**`PlayMenu` ("▶ Play on ▾") is a menu by the same test and is deliberately NOT converted in
this change.** See "What is left" below.

## Context

The owner, looking at the Pending page:

> *"Is this QueuePilot page for Pending items using the correct Charcuterie dropdowns?
> Doesn't look like that's a listbox or non-native Select (Picker) or anything."*

He was right that it was wrong, and the useful part of the answer is *how* it was wrong.
All three of the app's `.qmenu` menus were hand-rolled `<div>`s holding `<Button>`s:

- `PendingView.tsx` — a raw `<button className="addto">` whose label was the literal string
  `Add to ▾`, and a `<div className="qmenu">`. No `role="menu"`, no `role="listbox"`, no
  arrow keys, no Escape, no outside-press dismiss. It closed on a second trigger click or a
  successful add, and on nothing else.
- `Toolbar.tsx` — the same shape, with a hand-written `onKeyDown` doing ArrowUp/ArrowDown by
  `querySelectorAll("button")` and `indexOf(document.activeElement)`, plus a **document-level
  Escape listener** to paper over the state where the menu has no focusable row at all.
- `PlayMenu.tsx` — the same shape again, positioned from a caller-supplied `DOMRect`.

**No lint rule could have caught this, and that is the general lesson.** `web/biome.json`'s
picker ban (`@charcuterie/biome-config/app`, added in #152) is expressed as
`noRestrictedElements` on `<select>` and `noRestrictedImports` on `Select`. Both look for a
native select. This code never used one — it used a `<div>` and some `<button>`s, which no
rule can distinguish from any other `<div>` and `<button>`s. **A hand-rolled overlay is
invisible to the picker rule by construction.** The rule bans the *wrong component*; it
cannot ban the *absence of a component*.

## Why a menu, argued rather than assumed

The brief that opened this work asked for the menu-vs-listbox call to be made explicitly
rather than inherited, so:

| | Add to (both sites) | Add to position | Play on |
| --- | --- | --- | --- |
| A row does what? | POSTs an add | sets `addPosition` | starts playback |
| Is there a value afterwards? | no | **yes**, and it is shown | no |
| Would a checkmark mean anything? | no | yes | no |
| Component | `Menu` | `SelectListbox` (`Picker`) | `Menu` (not yet) |

The screen-reader announcement is where it becomes concrete: a listbox says "listbox,
selected, 2 of 4", which claims a selection that does not exist and would not survive the
next render. A menu says "menu, 2 items". Charcuterie names mux-magic's `TypePicker` as the
fleet's one instance of getting this backwards — `role="menu"` over items that set a value —
and the failure is invisible in a browser and invisible to axe. It is worth stating in a
record precisely because nothing automated will ever tell you.

## What the conversion bought, beyond the role

Verified by driving a real browser, not by reading the component:

- `role="menu"` on the panel, `role="menuitem"` on each row.
- Arrow Up/Down, Home and End move a roving focus; the arrow keys no longer scroll the page.
- Focus moves INTO the panel when it opens and returns to the trigger when it closes.
- Escape and outside press both dismiss (floating-ui `useDismiss`, on the document).
- The trigger gets `aria-haspopup="menu"`, `aria-expanded` and `aria-controls`, and the panel
  is named by the trigger through `aria-labelledby`.
- Placement is floating-ui's `flip` + `shift` against the real viewport.

Three pieces of app code were **deleted** rather than ported, each of them a hand-rolled
version of something the component already does:

1. **`Toolbar`'s document-level Escape listener.** Its comment explained that the menu's own
   `onKeyDown` could not hear Escape in the no-compatible-queue state, because that state had
   no focusable row and focus stayed on the trigger — a sibling of the menu. `useDismiss`
   listens on the document, so Escape now closes it from the trigger.
2. **`Toolbar`'s arrow-key handler**, ~30 lines walking `querySelectorAll("button")`.
3. **`.pendingtile .qmenu { left: 0 }`**, which existed because `.qmenu` hung off its
   container's right edge and a ~160px tile pushed a 220px menu off the viewport. `shift()`
   reads the actual viewport.

## The empty state is a DISABLED item, not an empty menu

Both menus have a state with no compatible queue ("No queue draws from “Shorts” — add it to
one via its ⚙."). `Menu` renders `items` and nothing else, so there is no slot for the loose
`<p>` the hand-rolled panel used. It became **one item with `isDisabled: true`**:

- the sentence stays inside the menu, where a screen reader reaches it by arrowing;
- `MenuAction` never registers a disabled item with `RovingFocus`, so the arrow keys skip it
  and focus stays on the trigger;
- it announces as unavailable rather than as absent — "you cannot do this right now", not
  "this does not exist".

## What is left

**`PlayMenu` is the last hand-rolled menu in the app, and its conversion is its own change.**
`Menu` **clones a trigger element**; `PlayMenu` is a singleton rendered once in `App` and
opened from six unrelated call sites (`QueuesView`, `QueueView` twice, `ChannelsView`,
`SelectionBar`, `EntrySettings`) through
`openPlayMenu({ anchor: e.currentTarget.getBoundingClientRect(), … })`. The anchor is a
`DOMRect` in module state, not an element to clone. Converting it means deleting the
`overlays.playMenu` singleton, rendering a `Menu` at each of the six ▶ buttons, and moving
the shared `useQuery` for the device registry with it. The honest half-measure — keep the
singleton and give `Menu` a hidden trigger parked at the rect — is the hand-rolled
positioning again with a component wrapped around it, so it was not done. The reasoning is
repeated at the top of `PlayMenu.tsx`, where the next reader will actually be standing.

## Consequences worth knowing

- **The panel is a PORTAL child of `<body>`.** Any selector of the form
  `#gresults .qmenu …` is now wrong by construction. `e2e/ui-test.ts` and
  `e2e/kbd-undo-test.ts` were updated in the same commit; the class is `.addtomenu` and the
  rows are `[role="menuitem"]`.
- **`SearchDropdown`'s blur guard had to learn about the portal.** It closed the results
  250 ms after the input lost focus unless focus was inside the `<ul>` — and a portalled menu
  item is inside the dropdown on screen and outside it in the DOM, so opening the menu closed
  the results and took the menu with them. The check now also accepts focus inside
  `[role="menu"]`.
- **`.qmenu` survives, for `PlayMenu` only**, and the `data-density="compact"` on it goes
  with it. The two converted panels do not set a density: `MenuAction`'s rows are
  `px-2 py-1.5 text-sm`, not `--control-height`, so the axis has nothing to act on.
- **One `Menu` per row, mounted while closed.** A closed `Menu` renders only its cloned
  trigger, and floating-ui's `autoUpdate` needs a mounted floating element, so a long Pending
  list pays for hook state and no observers.

## Evidence

- Owner's report, quoted above (2026-08-21).
- Driven in a real Chromium, menu open: `role="menu"`; panel named "Add to" through
  `aria-labelledby` (the chevron is `aria-hidden`, so it is not in the accessible name);
  ArrowDown/ArrowUp/Home/End all move focus; Escape closes and returns focus to the trigger;
  Enter on a row fires the POST and dismisses; an outside click dismisses; the empty state is
  a single disabled `menuitem` and Escape closes it **from the trigger** — the case the
  deleted document listener existed for.
- axe (`wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`) with the menu open reports one violation,
  `aria-hidden-focus`, on floating-ui's `data-floating-ui-focus-guard` sentinel spans. It is
  **pre-existing and not from this change**: the identical violation is reported on `main`
  with any existing `SelectListbox` open, because every Charcuterie anchored overlay renders
  the same guards.
- Always-run CI gates green locally: `pick-contract`, `narrow-scroll`, `routing`,
  `play-reorder`, `pool-editor-keeps-blocked`. Plus lint, both typechecks, 117 unit tests and
  both builds.

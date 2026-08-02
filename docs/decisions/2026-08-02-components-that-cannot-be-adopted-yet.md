# Five `@charcuterie/ui` components plex-channels cannot adopt yet, and why each is a library gap

- **Status:** Accepted
- **Date:** 2026-08-02
- **Type:** Frontend / migration scope
- **Supersedes:** —
- **Superseded by:** —

## Decision

M6d phase 2 adopts `Select` (12 sites), `Badge` (7), `EmptyState` (2) and
`Accordion` (1). It deliberately does **not** adopt `Field`, `Menu`, `Modal`,
`Toast`/`ToastRegion`, or `Badge` for the two badge-shaped buttons and the
two-part collection chip.

Each is blocked by a **library API gap**, not by effort. None is worked around in
this repo, because every available workaround is worse than not using the
component. They are reported to M6f as the requirements they are.

## The gaps

### 1. `Field` overwrites the control's `id` — blocks the ~10 single-control fields

`Field` clones its child with `id: \`${baseId}-control\``, and `cloneElement`'s
second argument wins. There is no `controlId` prop.

Measured against the **installed 1.0.0**, not assumed, and re-checked after M6f
shipped (M6f fixed `Field`↔`Tooltip` slot-prop merging between two library
components; it did not change what happens to a child's own `id`):

```
<Field label="Audio language"><input id="dyn-audio" type="text" /></Field>
→ <label for="_R_0_-control">Audio language</label><input id="_R_0_-control" type="text"/>
```

Every labelled control in this app is addressed by that id from the e2e suites
(`#set-label`, `#dyn-label`, `#dyn-kind`, `#dyn-audio`, `#ch-audio`, and the
three `.subfield`s per binding). Adopting `Field` renames all of them at once.
Rewriting seventeen suites to accessible names is the sanctioned direction in
general — but doing it in the same change that moves the markup discards the only
regression gate the port has, which is the one thing phase 1 built the DOM
contract to prevent.

**Needs:** `Field` to accept the control's own `id` (respect a child that already
has one, or take a `controlId` prop).

**Not blocked, and newly possible:** the ~7 **checkbox groups** are a different
shape and `FieldGroup` — new in 1.0.0 — fits them. It renders `<fieldset>` +
`<legend>` and its children **as-is, not cloned**, and the ids the suites read
(`#ch-ratings`, `#set-libs`, `#ch-movielibs`, `#ch-otherlibs`) sit on the inner
`.libs` div rather than on the `<fieldset>`, so nothing is renamed. That is the
top phase-3 item. Its one gap: `FieldGroupProps` has no rest-props passthrough,
so the three fieldsets that carry their own `id`/`hidden` (`#ch-otherbox`,
`#dyn-otherbox`, `#dyn-profilesbox`) need either a passthrough or a wrapper.

### 2. `Menu` cannot anchor to a point — blocks `TileMenu`

`MenuProps` requires `trigger: ReactElement`, cloned and used as the floating
reference. `TileMenu` has **no trigger**: it opens on a right-click / long-press
at viewport coordinates, `position: fixed`, clamped to the edges. floating-ui
supports a virtual reference for exactly this; `Menu` does not expose one.

`Menu` also takes no `id`, and `verify-start-modal.mjs` selects
`#tilemenu:not([hidden])`.

M6a asked for this one to be decided explicitly, and this is the decision: a
context menu is a distinct case from a menu button.

**Needs:** a point/virtual anchor, and an `id` passthrough.

### 3. `Menu` items cannot be non-items — blocks `PlayMenu`

`MenuItem` is `{ key, label, onSelect }`; `onSelect` is required. Three of
`PlayMenu`'s four states are **paragraphs, not actions**: "Loading devices…", "No
devices announced yet (…)", and the MQTT error. `channels-test` asserts
`.playmenu p` matches `/MQTT/i`, and it is CI-gated.

Second blocker: `openPlayMenu` stores a `DOMRect`, not an element, because three
different triggers (`#chplay`, `.shelfplay`, the landing rows' `.playbtn`) open
one singleton menu through `state/overlays.ts` — the arrangement phase 1
documents and the vanilla app had before it. `Menu` needs the trigger element
co-located with the menu.

**Needs:** an empty/loading/error slot, or a documented "not for menus with
non-item states".

### 4. `Modal` has no form, and the app's dialogs are forms

The library `Modal` renders `<header>` / body `<div>` / `<footer>`. The app's
three dialogs are a `<form>` wrapping all of it, with `#set-save` / `#dyn-save` /
`#start-save` as `type="submit"` — which is what makes Enter submit. Moving the
form into `children` puts the footer buttons outside it.

The app's `Modal` also increments `busy.openModals`, which is the guard that stops
an SSE refetch landing mid-gesture (phase 1, "four things kept imperative").

**Needs:** a form-aware `Modal`, or a documented pattern for footer submit
buttons (the `form=` attribute).

### 5. `Badge` is a `<span>` with one label slot

- **`.startbadge` and `.exclude` are real `<button>`s.** `Badge` is a `<span>`
  with no `asChild`, and a badge-shaped button is not a `Badge` with an
  `onClick`.
- **The two-part collection chip** (`.badgekind` + `.badgename`) puts a filled
  kind against a truncating name. `Badge` renders its children inside ONE label
  span that is `overflow-hidden text-ellipsis whitespace-nowrap`, so the halves
  collapse into a single ellipsised run. The `icon` slot is `aria-hidden`, so
  putting "Collection" there would hide the word from a screen reader. M6a
  predicted this shape would need its own component.

**Needs:** `asChild` (or an `as`), and a two-part / split `Badge`.

### And one that is not a gap: `EmptyState` in the filters panel

`EmptyState` requires a real heading, which is right for an empty container and
wrong for "Nothing blocked." — a one-line note directly under the control that
adds rows, in a 300px sidebar. Rendered, it became a bold two-line "Nothing /
blocked" 123px tall. Those two sites keep their plain `<li>`. This is a **fit**
judgement, not a missing feature: not every string that means "nothing here" is
an empty state.

## Why

Working around any of these means either patching `charcuterie` (out of scope —
this repo does not touch it) or reaching into a component's internals from
`app.css`, which is worse than not adopting it: it couples the app to markup the
library is free to change, and it hides the requirement from the library.

Reporting them as requirements is what makes M6f able to fix them once for the
whole fleet.

## Evidence

Phase 2 of M6d, branch `feat/m6d-charcuterie-ui`. The `Field` id result above was
produced by a throwaway `renderToStaticMarkup` probe against the installed
package, not read off the source.

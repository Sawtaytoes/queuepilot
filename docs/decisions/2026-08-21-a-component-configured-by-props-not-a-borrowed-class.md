# A control is a Charcuterie component configured by PROPS, not an app class name

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** UI / component adoption
- **Supersedes:** —
- **Superseded by:** —

## Decision

**When `@charcuterie/ui` ships a component for a thing, use that component and configure it
with its props. Do not dress a raw element in an app class to get the same look, and do not
add an app class to a Charcuterie component to change one.**

Concretely:

1. A pressable control is a **`Button`** (or `ButtonLink`, or `IconButton`) with
   `appearance` / `intent` / `size` / `sizing`. Not `<button className="ghost accent">`.
2. A pill is a **`Badge`** with `intent` / `appearance` / `size`.
3. A label over one control is a **`Field`**; over several, a **`FieldGroup`**. Their
   `label` and `description` props are where the text goes.
4. A picker is a **`Picker`** (through this app's `SelectListbox`), and its trigger keeps
   `Picker`'s own `outline`.
5. **A `className` on a Charcuterie component is a smell.** `app.css` is unlayered and
   Tailwind's utilities are in `@layer utilities`, so *any* app rule outranks the component
   it lands on. An app class on a component is therefore never a tweak; it is a silent
   override of something the library decided.

The exceptions, stated so the rule survives the first case it does not fit:

- **App layout is not a component-library concern.** Page scaffolding, grids, the gap
  between two form blocks, a sticky panel, a scroll container — these are `app.css`, and a
  layout class on a component's outer element is fine when it sets *position and spacing*
  and nothing else. `#dynmodal fieldset { margin-bottom: 14px }` is the worked example.
- **A shape the library cannot express yet.** The two-part Collection chip is the standing
  case: `Badge` renders one run of content, and the chip is a count welded to a name. That
  is a Charcuterie change, not an app class — but until it lands the app class stays and
  says why.
- **A DOM handle.** `data-testid` (and an `id` where a component forwards one) is not
  styling. Where a component forwards neither, a class used *only* as a selector is
  acceptable and must carry no rule.

This **extends** [a class name is not a style](2026-08-21-a-class-name-is-not-a-style.md).
That record says a borrowed class ships unstyled markup; this one says what to reach for
instead, and it is the stronger rule of the two — it applies to a class that *does* match,
as well as to one that does not.

## Context

The owner, 2026-08-21:

> *"I'd prefer not to use borrowed classes rather than component library components which
> have all the Tailwind classes built in. No className props required. It's all props."*

That was said about the five findings
[the earlier record listed and deliberately left open](2026-08-21-a-class-name-is-not-a-style.md#five-more-on-other-pages--reported-not-fixed).
`e2e/borrowed-class-audit.ts` reported 23 class/element pairs that match no rule for the
class they wear; five of them were real, and four had **never once** shown the look their
class name asks for. All five are fixed here, and every one of them by adopting a component
rather than by un-scoping a CSS rule — un-scoping would have satisfied the bug report and
contradicted the instruction.

The audit now reports **16** pairs, and the sixteen left are the expected non-findings: a
state class that exists to be someone else's ancestor (`body.play-view`, `ul.editable`,
`.showsonly`, `body.name-editable`, `.lbl`) and Tailwind's own `peer` / `divide-*`
primitives.

## What each of the five became

| Where | Was | Is now |
| --- | --- | --- |
| `ChannelsView` `#newdyn`, `#newcurated` | `<button className="ghost accent">` | `<Button appearance="outline" intent="accent">` |
| `ChannelsView` `#chresample`, `#chconfigure` | `<button className="ghost">` | `<Button appearance="outline" intent="neutral">` |
| `ChannelFilters` `#ch-alllibs` | `<p className="subhint">` | `<p className="hint">` — **no component fits**, see below |
| `DynModal` `#dyn-lineup` | `<fieldset className="field flags">` | `<FieldGroup label="Playback">` |
| `DynModal` `#dyn-on-complete` | `<label className="field">` + `className="fieldselect"` | `<Field label="…">` around the picker |
| `DynModal` `#dyn-collection-members` | `className="fieldselect"` | class removed — nothing to restore |
| `SelectionBar` — all eight buttons | `<button className="primary">` etc. under `#selbar button` | `<Button>` with `appearance` / `intent`; the five `#selbar button…` rules deleted |

### Why the two `＋` buttons brought their neighbours with them

`#newdyn` and `#newcurated` are two of five controls in one row. Converting only those two
would have left a row of four Charcuterie buttons beside two app-CSS ones at a different
height, radius and padding — the mixed look this rule exists to stop. `#chresample` and
`#chconfigure` came with them. `#chplay` did **not**: it is `.playbtn`, its class matches
its rule, and it alternates with `OpenQueueButton`'s `<a className="playbtn openbtn">` in
the same slot — converting one of a pair splits them. Both belong to the button sweep in the
staged plan below.

### Why the selection bar was converted whole

`#bulkapply` alone could not be. `#selbar button { background: accent-solid; … }` is an
id-scoped rule in an unlayered stylesheet, so it beats every utility a `Button` carries;
fixing one button means either excluding it from that rule by hand or deleting the rule. The
rule had to go anyway, for a second reason the finding did not mention: **a `Picker` trigger
is a `<button>`**, so `#selbar button` was painting both pickers solid indigo — against this
repo's own rule that a picker trigger keeps `Picker`'s `outline`
([AGENTS.md](../../AGENTS.md)). The `Default` chip inside the Episodes count picker was
white-on-indigo for the same reason.

With the rule gone, each control says what it is: **Apply is the one `solid`** — which is
what `primary` was asking for and never got — Remove is `solid`/`danger`, Move and Reset are
`outline`/`accent`, and Clear and the two `— keep —` are `outline`/`neutral`.

### The one that got no component, and why

`#ch-alllibs` is a standing hint that belongs to **three sibling control groups** ("Show
libraries", "Movie libraries", "Other videos" are one optional scope). Charcuterie's only
hint slots are `Field.description` and `FieldGroup.description`, and both attach to exactly
one group; attaching it to one of the three moves the text away from the scope it describes,
and "Other videos" is `hidden` when the server reports none, which would hide the hint. A
wrapping `FieldGroup` is the right shape and does not work here either: it renders a
`<fieldset>`, and `#chfilters fieldset` paints every fieldset in that panel as a bordered
box — so it would draw a fourth box around the other three.

So it wears `.hint`, this panel's **own** hint class (`#chfilters .hint`), which is what the
sibling note under "Show libraries" six lines above already wears. The borrowed class is
gone and the paragraph is muted at 0.8rem again; the restructure that would let a component
own it is a change of its own.

### `Field` adopted, `description` declined — on purpose

`#dyn-on-complete` is a `Field` with a `label` and **no `description`**, and the
`<p className="subhint">` under it stayed. `Field`'s hint slot renders `text-sm` /
`content-secondary`; the two hints directly above it in the same box are `.subhint` at
0.8rem muted, and one of them belongs to a `Checkbox`, **which has no description slot at
all** and therefore cannot follow. Using the slot for one control of three leaves a box with
two hint typographies and the odd one in the middle. Moving this app's hints onto
Charcuterie's slots is worth doing and is in the plan; it is a uniform change across every
modal, not a side effect of this one.

## Why

### The instruction is stronger than the bug it came from

The five findings were classes that matched **no** rule. The owner's sentence is about
classes generally: a component "has all the Tailwind classes built in", so an app class is
redundant at best. That reaches classes that *do* match — `.playbtn`, `button.ghost`,
`.badge` — which the audit will never report and which are the bulk of what is left.

### An app class on a component is never a tweak

This file already knew it and had written it down twice, both times after being bitten:

> *"The skin declarations these sites used to carry (`background`/`border`/`border-radius`/
> `padding`) are GONE, not moved. `app.css` is unlayered and Tailwind's utilities are in
> `@layer utilities`, so every one of them silently outranked the component — `padding` beat
> `pe-9` and the chevron printed on top of the label text. Adopting a component means letting
> it own its own look."*

`#selbar button` is the same defect a third time, and it reached two `Picker`s and a `Badge`
that nobody had thought about when the rule was written. That is the general shape: an
element-scoped app rule hits every component that happens to render that element, including
ones written years later.

### What could and could not catch it

Nothing automated. Biome sees a string; tsc does not read CSS; the 126 unit tests load no
stylesheet; axe is content with an unstyled button. `e2e/borrowed-class-audit.ts` catches the
sub-case where the class matches nothing, **and it still reports rather than gates** — a
state class matching nothing is legitimate, so a human has to read it. The general rule has
no tool at all, which is why it is written down here instead.

## Two gaps this ran into, both upstream in Charcuterie

Neither is a workaround-in-the-app problem; both belong in `@charcuterie/ui`.

1. **`FieldProps` and `FieldGroupProps` do not spread rest props onto their own element.**
   `Button` is `Omit<ComponentPropsWithRef<"button">, "disabled"> & {…}`, `Badge` is
   `ComponentPropsWithRef<"span"> & {…}`, `Picker` likewise — so `id`, `hidden`, `data-*`
   and `ref` all reach the DOM. `Field` and `FieldGroup` are closed six-key types with no
   rest spread, so **nothing** but `className` can reach the `<div>` / `<fieldset>` they
   render. Two consequences here: `#dyn-lineup` had to give up its `id` and take a
   `className` as its e2e handle, and `#dyn-collections` could not become a `Field` at all,
   because that box needs `hidden`.
2. **`Checkbox` has no `description` slot.** A checkbox with standing help under it cannot
   express that help through a component, so its hint stays an app paragraph — and that is
   what stops a whole box moving to Charcuterie's field typography at once.

## Evidence

- Owner's instruction, quoted verbatim above (2026-08-21).
- `e2e/borrowed-class-audit.ts` before and after, self-test probe firing on every route in
  both runs: **23** class/element pairs → **16**, with all five listed findings gone and
  nothing new introduced.
- Before/after captures from `e2e/shot-component-adoption.ts`, **fixture data only** — the
  library names are the harness's five synthetic sections and the queue names come from
  `e2e/fixtures/sets.fixture.yaml`. Four subjects, six frames.
- Charcuterie 2.18.0 read in the source rather than assumed: `Button.tsx` (`isDisabled`
  renders a real `disabled`), `Field.tsx` / `FieldGroup.tsx` (the closed prop types, and
  `Field`'s clone precedence `Field.id` → child's `id` → generated), `slotProps.ts` /
  `mergeClonedProps.js` (a clone replaces a value and composes a `ref`/`on*`, so an explicit
  `undefined` from the wrapper *does* erase a child's own `aria-describedby` — which is why
  the hint could not be bound by hand once `description` was declined), `Picker.tsx` (the
  trigger's own `id` now survives `useAnchoredOverlay`, which is what let `SelectListbox`
  start rendering one).
- Keyboard-driven, not read: `#newdyn` takes focus and shows a solid focus ring, `Enter`
  opens the pool editor, the `Field`'s `<label for>` resolves to the trigger's real id, the
  Playback group is a `<fieldset>` with a `<legend>` and computes `display: flex` for the
  first time, and `Enter` / `ArrowDown` / `Enter` on the on-complete picker changes the
  value.
- All CI gates green locally: Biome, three typechecks, 126 unit tests, both builds,
  `pick-contract` (14 assertions), `narrow-scroll`, `routing`, `play-reorder`,
  `pool-editor-keeps-blocked`, `drag-stability`, `shelf-remove`, `pending`.

# `SegmentedControl` props audit — the Pick | Queues control

- **Date:** 2026-08-23
- **Kind:** findings note, not a decision record
- **Question:** does `@charcuterie/ui`'s `SegmentedControl` cover a two-option
  **Pick | Queues** control with a controlled value, a visible label, and the Narrow View
  width?
- **Blocks:** the Tonight surface work package, and nothing else.

## Verdict

**Yes. Nothing is missing, no Charcuterie change is needed, and the Tonight work package is
not blocked on one.**

The one thing the component does not have — a controlled `value` — it refuses to have on
purpose, and this app settled the answer to that on 2026-08-02: key an uncontrolled control
on its second writer. Here the second writer is the activity tile.

## What was audited

`@charcuterie/ui@^3.10.0`, which is what `web/package.json` pins and what `yarn.lock`
resolves (`@charcuterie/ui@npm:3.10.0`). The installed copy ships
`dist/SegmentedControl/` and exports `SegmentedControl` and `SegmentedControlProps` from the
package index, so the control is available to this app today with no version bump.

⚠️ **Do not audit this against the Charcuterie working checkout.** That tree is on
`packages/ui@2.2.0`, on a feature branch, and its `toClassName.ts` is the *older* plain-join
implementation. `SegmentedControl.tsx` and `SegmentedOption.tsx` happen to be byte-identical
between the two, but `toClassName` is not, and that difference is what decides the width
answer below. The published `src/` ships inside the package — read that.

## The whole prop surface

```ts
type SegmentedItem = {
  isDisabled?: boolean
  label: ReactNode
  value: string
}

type SegmentedControlProps = {
  className?: string
  items: readonly SegmentedItem[]
  /** The group's accessible name. Required. */
  label: string
  onChange?: (selectedValue: string | null) => void
  /** **Initial** only. Charcuterie owns it from then on. */
  selectedValue?: string
  size?: ControlSize
}
```

Six props, and the type is **closed** — it does not spread rest props. That matters once,
under *Visible label*.

## Two options

Covered, and it is a shipped example rather than an inference: the component's own
`AllStates` story renders a two-option `Grid | List` group. Rendered with
`items = [{label: "Pick", value: "pick"}, {label: "Queues", value: "queues"}]` it produces a
`role="radiogroup"` holding two `role="radio"` buttons, the first `aria-checked="true"`, one
tab stop between them.

It is a **radio group**, not two `aria-pressed` toggles — so a screen reader announces "1 of
2" and that pressing one un-presses the other. That is the right semantic for Pick vs Queues,
which is a single choice from a named set.

## Controlled value — the real finding

`selectedValue` is **initial only**. The component's own test says so in its name and in its
body:

> `test("selectedValue decides the first render and nothing after")`
>
> *"A controlled prop is the thing this library refuses to have"*

So a prop that follows the app's state does not exist, and asking for one upstream is asking
the library to reverse a stated position. **Do not open that PR.**

The app already has the answer, as a decision:
[uncontrolled components are keyed on their second writer](decisions/2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer.md).
The rule is: give the control a `key` if and only if something other than the user can change
its value, derive the key from that writer, and say which writer in a comment at the site.

Here the second writer is named in the absorb decision itself — *"Default the segment
intelligently by activity (board games → Pick, shows/reading → Queues)."* Changing the
activity tile is the outside write. So the key is the activity:

```tsx
<SegmentedControl
  items={[
    { label: "Pick", value: "pick" },
    { label: "Queues", value: "queues" },
  ]}
  // SECOND WRITER: the activity tile. Picking a different activity re-defaults
  // the segment, and `selectedValue` is a seed the control stops listening to.
  key={activity}
  label="How should we choose?"
  onChange={(next) => { setMode(next === "queues" ? "queues" : "pick") }}
  selectedValue={defaultModeFor(activity)}
/>
```

**One trap, and it is silent.** The remount does **not** fire `onChange`.
`createSinglePicker` seeds `wantedValue` from `selectedValue` at construction, and
`setWantedValue` short-circuits when the value is unchanged — so the mount-time
`select(activeValue)` is a no-op for the callback. The parent must therefore set its own mode
state to `defaultModeFor(activity)` **in the same handler that sets the activity**. Set only
the activity and the segment repaints on the new default while the parent still believes the
old one, with nothing reporting the divergence — which is exactly the failure the 2026-08-02
record was written about.

## Visible label

`label` is the group's accessible name and renders as `aria-label` on the `role="radiogroup"`
element. It is **not drawn**. The mockup's Pick | Queues control has no visible label either,
so the default shape needs nothing.

If one is wanted, the wrapper is **`FieldGroup`**, not `Field`, and the difference is not a
preference:

- `FieldGroup` **wraps**. It renders `<fieldset>` + `<legend>`, which names a group of
  controls natively, and at 3.10.0 it spreads its rest props onto the `<fieldset>`. Safe.
- `Field` **clones** onto its one child — it mints an id and passes `id`,
  `aria-describedby`, `aria-invalid`, `aria-required` and `required` down. `SegmentedControl`
  accepts none of those and drops them in silence. Rendered with `id` and
  `aria-describedby`, the output carries neither attribute. The `<label htmlFor>` above would
  point at nothing in the document — precisely the defect `Field`'s own docstring says it
  exists to make impossible. A `<label htmlFor>` cannot name a `<div role="radiogroup">`
  anyway.

## Narrow View width

Covered. The group is `inline-flex` — it takes the width of its options and no more — and two
short labels at the `md` control size come to roughly 150 px: `Pick` and `Queues` plus
`--control-padding-inline-md` (0.875rem) on each side, a `gap-1`, and the group's own 2 px
padding. There is nothing here for `e2e/narrow-scroll-test.ts` to catch at 360 px, and the
largest `--control-padding-inline-md` in the whole token set is 1.25rem, so no density pushes
it near 360 px.

The mockup draws it as a **full-width 50/50** bar (`grid-template-columns: 1fr 1fr`). That is
a sketch, and it is available without a library change, but read the note before using it:

- At 3.10.0 `toClassName` is `tailwind-merge`, not a plain join, so a caller's `className`
  **reliably beats** the component's own conflicting class. Passing `"flex w-full"` produces
  a class list with `inline-flex` removed. Confirmed by rendering, not inferred.
- `"flex w-full"` alone does **not** give 50/50 — the options carry no `flex-1` and there is
  no per-option class hook, so they stay packed at the start of a full-width bar.
  `"grid w-full grid-cols-2"` does give an exact 50/50, because a grid item stretches to its
  column.
- But that second one reaches into the component's internal layout, and this app has a rule
  about that: [a control is a Charcuterie component configured by props, not a borrowed
  class](decisions/2026-08-21-a-component-configured-by-props-not-a-borrowed-class.md). Its
  app-layout exception covers `w-full`; it does not comfortably cover `grid-cols-2`.

**So: build it at intrinsic width first and show the owner.** If he wants the mockup's
stretch, the clean form is an upstream prop rather than a call-site override —

```ts
/** Fill the container, options sharing the width equally. */
isFullWidth?: boolean
```

— setting `flex w-full` on the group and `flex-1` on each `SegmentedOption`. That is a
Charcuterie PR, it is **cosmetic**, and it blocks nothing: the control ships, works and
passes the gates without it. Do not add a QueuePilot one-off for it.

## One implementation caution

`web/src/styles/app.css` is unlayered and Tailwind's utilities sit in `@layer utilities`, so
any app rule outranks the component it lands on — `AGENTS.md` says this and `#selbar button`
is the worked example. `SegmentedOption` renders a real `<button>`, so the file's bare
`button { font: inherit; cursor: pointer }` reaches it. That rule already reaches every
`Button`, `IconButton` and `BadgeButton` in this app, so it is a standing condition and not a
new defect — but check the checked pill's weight and size on screen when the control lands,
rather than assuming the component's `text-md` and `font-medium` survived.

## How this was checked

- Read the published `src/` and `dist/*.d.ts` of `@charcuterie/ui@3.10.0` as installed:
  `SegmentedControl.tsx`, `SegmentedOption.tsx`, its test file, its stories, `toClassName.ts`,
  `Field.tsx`, `FieldGroup.tsx`.
- Read `@charcuterie/logic`'s `createSinglePicker.ts` for the `onChange` firing rule.
- Rendered the control through `react-dom/server` against the installed package to confirm,
  rather than infer: the two-option markup and which option is checked, that `selectedValue`
  decides the first paint, that `className` merging drops `inline-flex`, that no option
  carries `flex-1` or `grow`, and that an unknown prop is dropped without a trace.

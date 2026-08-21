# Handoff — `Listbox` and `Combobox` belong in `@charcuterie/ui`

> ## ⚠️ DELIVERED, and its "keep native for plain lists" rule is DEAD
>
> **Read this as history, not as guidance.** The ask landed — `@charcuterie/ui` ships
> `Listbox`, `Combobox` and the assembled `Picker` — and every picker in this app went over
> on 2026-08-07
> ([decision](decisions/2026-08-07-plex-channels-pickers-are-listbox-not-native-select.md)),
> with `SelectListbox` becoming a `Picker` adapter on 2026-08-13
> ([decision](decisions/2026-08-13-selectlistbox-adopts-the-shared-charcuterie-picker.md)).
> There is **not one native `Select` left in this repo**, and there should never be another.
>
> Two passages below are the opposite of what is now settled, and are struck through where
> they appear: **"Keep the native path"** with its *"pick `Select` unless you need a rich
> option or filtering"* rule, and the note that the `StartModal` season/episode pickers
> *"should probably stay `Select`"*. Native `Select` is a **compatibility hatch**, not a
> default — fleet-wide as of 2026-08-20, and library-wide since 2026-08-10 (see
> [`AGENTS.md`](../AGENTS.md) for both records). Everything else here — the prior art, the
> consumer counts, the floating-ui and density constraints — is still an accurate account of
> why the components exist.

**Audience:** an agent working in `/mnt/TrueNAS-Apps/Repos/charcuterie`.
**Status:** ✅ delivered 2026-08-07 / 2026-08-13. Written as requirements; kept for the record.
**Origin:** the plex-channels first-load performance + UI work of 2026-08-03. The UI complaint
that produced this doc was *"the selects look native and chunky on desktop."* That complaint is
**not** fixable in plex-channels, and the reason is below.

---

## The gap

`@charcuterie/ui` exports **`Select`**, and `Select` is deliberately a **styled native
`<select>`** (`packages/ui/src/Select/Select.tsx`). Its popup list is the operating system's
popup. It therefore:

- cannot render a rich option — an icon, two lines, a badge, a count;
- cannot filter;
- cannot be styled at all below the closed control.

There is no `Listbox`, no `Combobox`, and no `Dropdown` in the package. The component's own
docblock already names the gap and scopes it:

> *"mux-magic has six controls that need one of those (`CommandPicker`, `PathPicker`,
> `LinkPicker`, `EnumPicker`, `AssFieldPicker`, `RenameTargetPicker`), and every one of them is
> a **`Combobox`**: a text input that filters a listbox. That is a different pattern with a
> different ARIA contract, it is P2 in the plan, and building a bare `Listbox` here that none of
> the six could adopt would have shipped a component with no caller."*

That reasoning was right at the time and is why `Select` shipped native-only. What has changed
is that the callers now exist and are counted below.

~~**Keep the native path.** Whatever gets built must not replace `Select`. On a phone a native
`<select>` is genuinely better than any hand-rolled listbox — it gets the system wheel picker,
type-ahead, Home/End, PageUp/PageDown, form submission, `:invalid` and autofill for free. The
desktop-only complaint is the one worth solving, and the two components should coexist with a
documented "pick `Select` unless you need a rich option or filtering" rule.~~
**↑ REVERSED** (2026-08-07 here, 2026-08-10 in the library, 2026-08-20 fleet-wide). `Listbox`
keeps type-ahead and full keyboard nav; what it forfeits — the mobile wheel, autofill,
`:invalid`, no-JS form submission — is not used by a single control in this app. `Select` is
the hatch, and reaching for it now needs a written reason.

---

## The proven prior art to port

`/mnt/TrueNAS-Apps/Repos/mux-magic/packages/web/src/components/PortalDropdown/PortalDropdown.tsx`
— 225 lines, with a test file beside it. It already does:

- `createPortal` out of the clipping ancestor;
- `role="listbox"` / `role="option"` with the matching `aria-*` wiring;
- flip above/below based on available space, with `maxHeightPx = 400`;
- an optional sticky search box at the top of the list;
- dismissal on outside `pointerdown` **and** Escape.

Mine it for requirements rather than designing fresh. mux-magic has the fleet's most robust UI
and its deepest Storybook coverage, so its API surface is evidence, not opinion.

### The real consumer count (verified 2026-08-03)

The `PortalDropdown` component itself has **four** consumers:

| Consumer | What it needs beyond a native `<select>` |
|---|---|
| `LanguageCodeField` | filtering over a long list |
| `LanguageCodesField` | filtering + multi-select |
| `SubtitleTypesField` | multi-select |
| `SmartMatchModal/RenameTargetPicker` | rich two-line options |

**And four more controls hand-roll `createPortal` separately, without using `PortalDropdown` at
all:** `CommandPicker`, `EnumPicker`, `PathPicker`, `LinkPicker`. That is the strongest argument
in this document — the pattern is already duplicated *five times inside one repo*, which is what
a missing library primitive looks like from the inside. Read all eight before fixing the API.

---

## Deliverables

Build in this order. `Listbox` first, because `Combobox` is `Listbox` plus a filter input and
shipping them together hides which behaviours belong to which.

1. **`Listbox`** — selection only. Rich options, single and multi select, keyboard nav
   (Up/Down/Home/End/Escape/Enter), type-ahead.
2. **`Combobox`** — a text input that filters a `Listbox`. Different ARIA contract
   (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`); do not try to
   serve both from one component's props.

Each ships the four files the `Select/` directory already has, matching that directory's shape:
`<Name>.tsx`, `<Name>.stories.tsx`, `<Name>.test.tsx`, `<Name>.mdx`. Export both from
`packages/ui/src/index.ts`.

### Constraints

- **Placement via `floating-ui`**, matching `Popover`'s existing configuration exactly —
  `middleware: [offset(8), flip(), shift({ padding: 8 })]`, `strategy: "fixed"`
  (`packages/ui/src/Popover/Popover.tsx:100-101`). Do not hand-roll flip logic; `PortalDropdown`
  predates the library's adoption of floating-ui and its manual flip is the one part not to port.
- **Honour the `density` token axis** and `MIN_TOUCH_TARGET_CLASS`
  (`packages/ui/src/controlStyles.ts:50`). A `data-density="compact"` ancestor must shrink the
  rows, and `comfortable` must keep the 44 px floor. That axis is what lets a consumer
  de-chunkify a control with one attribute instead of an override.
- **Uncontrolled, keyed on its second writer** — per
  `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`: `value` is initial-only,
  and a consumer keys on the thing that writes it externally, never on the value itself.

---

## Consumers to migrate afterwards

**mux-magic** — the eight controls above; delete `PortalDropdown` and the four hand-rolled
`createPortal` picker implementations.

**plex-channels** — fourteen `<Select>` call sites, of which the desktop-chunky ones that
prompted this doc are the header pair:

- `web/src/views/ChannelsView.tsx:100` and `:131` (the header selects — the actual complaint)
- `web/src/components/Toolbar.tsx:174`
- `web/src/components/SelectionBar.tsx:41`
- `web/src/components/SetModal.tsx:171`
- `web/src/components/StartModal.tsx:308,344,372`
- `web/src/components/DynModal.tsx:355,458`
- `web/src/views/PlayView.tsx:109`
- `web/src/views/QueueView.tsx:275,408`

Migrate them **per the skin-deletion rule**
(`docs/decisions/2026-08-02-adopting-a-component-means-deleting-its-skin.md` in plex-channels):
adopting a component means deleting the app's `background`/`border`/`border-radius`/`padding`/
`font`/`color` for it, not merging. `web/src/styles/app.css` there is unlayered and silently
outranks every Tailwind utility, so a kept declaration makes the component's props a no-op with
the build green.

~~Note that several of these should probably **stay** `Select` — the season/episode pickers in
`StartModal` are short numeric lists and get real value from the native mobile wheel. Migration
is per-call-site judgement, not a sweep.~~
**↑ DID NOT HAPPEN, deliberately.** It was a sweep: `start-series`, `start-season` and
`start-episode` are `SelectListbox` like everything else, and the app has no touch surface
where the wheel picker would have been the point.

---

## Why not a local copy in plex-channels

`docs/decisions/2026-08-02-components-that-cannot-be-adopted-yet.md` (plex-channels) sets the
rule: **a library gap is reported as a requirement, not worked around downstream.** A local
`PortalDropdown` in plex-channels would be the fleet's *second* copy of a component that already
exists once and is already duplicated five times inside mux-magic. That is how a fleet ends up
with six divergent listboxes and no owner.

In the meantime plex-channels ships the one thing it legitimately can: `data-density="compact"`
on `#tools`, which takes the 44 px touch floor down over `--control-height-md` and de-chunkifies
the header selects using the token axis rather than an override. That is a stopgap, and this
document is the real fix.

# A class name is not a style — a borrowed one ships unstyled markup, silently

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** UI / CSS architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

**A class name carries no style. The RULE does, and a rule scoped to a container only
styles elements inside that container.** So:

1. Copying a class name from one view to another does **not** copy its appearance. If the
   rule reads `.results .addto` and the new markup has no `.results` ancestor, the new
   element is unstyled — and it looks styled in the source, in review and in the diff.
2. A class used by a **shared component** must have a **container-independent** rule. A
   shared component whose CSS needs one particular ancestor is not shared; it works in one
   place and paints nothing everywhere else.
3. A control that needs a look is a **Charcuterie component**, not a class name plus a hope.
   `Button`, `Menu`, `Picker` bring their own appearance and cannot be un-styled by where
   they are mounted.

Concretely, on the Pending page: **Dismiss** and the **Add-to trigger** become Charcuterie
`Button`s, `.editionbadge` becomes the shared `EditionBadge` component, and both
`.editionbadge` and `.y` lose their `.results` prefix.

`e2e/borrowed-class-audit.ts` is the tool that finds the rest. It **reports and does not
gate** — see "Five more, on other pages" below.

## Context

The owner, looking at the live Pending page (2026-08-21):

> *"In the image, that page still doesn't use Charcuterie. Dismiss isn't a button, the
> dropdown isn't valid, and the edition is directly next to the text without a space."*

His screenshot showed a tile reading **"Duel 1971Original TV Version"** — the year running
straight into the edition label with no separator — over two controls rendering as bare
text.

Three complaints, and they are **one defect wearing three hats**. `PendingView.tsx` borrowed
three class names from views it does not live in:

| Element | Class it wore | The only rules for it | The Pending tile has |
| --- | --- | --- | --- |
| The edition label | `editionbadge` | `.results .editionbadge` | no `.results` |
| The Add-to trigger | `addto` | `.results .addto` | no `.results` |
| Dismiss | `exclude` | `.tile .exclude` | `.pendingtile`, not `.tile` |

A fourth was found while fixing them and is in the same class: the **year** wore `y`, whose
only rule is `.results .y { color: muted }`. So it rendered at full contrast inside
`.pendingtile .ptitle { font-weight: 600 }` — bold, dark, welded to the title. That is the
first half of what the owner saw; the missing `margin-left: 6px` on the badge is the second.

`.pendingtile .pendingactions` sets `display: flex; gap: 6px; margin-top: 4px` and nothing
else, so **nothing in the stylesheet styled either control on that page at all.**

⚠️ **The `Menu` conversion was not the fix, and it was not wrong either.** #157 replaced the
hand-rolled `.qmenu` `<div>` with a Charcuterie `Menu` and that is verified correct — panel,
roles, arrow keys, Escape, outside press. The owner was still looking at unstyled markup
afterwards because the **trigger** was never converted: `Menu` clones whatever element it is
handed, and it was handed a raw `<button className="addto">`. A correct panel behind a
trigger that paints as text reads, from the outside, as "that page still doesn't use
Charcuterie".

## Why

### Nothing in this repo could have caught it

- **Biome cannot.** A class name is a string. The picker ban added in #152 looks for a native
  `<select>`; `className="addto"` trips no rule that exists or could exist.
- **tsc cannot.** The stylesheet is not in the program.
- **The unit tests cannot.** 121 of them, none of which loads CSS.
- **axe cannot.** Unstyled markup is perfectly accessible. So is a button that looks like a
  paragraph.
- **A screenshot review would have**, and none was taken of this page after #157 — the
  before/after frames on that PR were of the **open menu**, which was the part that got
  fixed.

That is the same shape as the lesson in
[the Add-to menu record](2026-08-21-an-add-to-menu-is-a-menu-not-a-picker.md): *"a
hand-rolled overlay is invisible to the picker rule by construction."* This is its sibling —
a **borrowed class name is invisible to every rule by construction**, because the thing that
is wrong is a relationship between two files, in two languages, that no tool reads together.

So the countermeasure is a tool that asks the **browser**, which is the only thing that knows
both halves. `e2e/borrowed-class-audit.ts` loads each route, and for every element and every
class token it wears, collects every selector in the loaded stylesheets mentioning that
class and asserts the element matches at least one. Matching none means the name is
decoration.

### `Button`, and why the trigger could take one

`Menu` **clones its trigger, it does not wrap it** — so the trigger must forward
`aria-haspopup`, `aria-expanded`, `aria-controls`, an `id`, a `ref` and floating-ui's
handlers, or the menu silently loses its anchor. Charcuterie's `Button` does, and this was
checked in the source rather than assumed:

- `ButtonProps` is `Omit<ComponentPropsWithRef<"button">, "disabled"> & {…}`, and everything
  it does not destructure is spread straight onto the native `<button>` — `ref` included,
  React 19 style.
- `useClonedChild` **composes rather than replaces** for the two props that are not values:
  a `ref` is a subscription and an `on*` is a listener. So the caller's `onClick` and
  floating-ui's both fire, and floating-ui's `setReference` is not dropped on the floor.

The `▾` moves to `iconEnd` and stays `aria-hidden`: `useRole` already announces the popup,
and a glyph in the accessible name would only say it twice.

### The appearance each control got, and why

| Control | Choice | Why not the alternative |
| --- | --- | --- |
| **Add to** | `outline` / `accent` | `solid` is the affirmative-action default, and this page is a **grid** — twenty solid accent buttons is a wall of indigo, and the tile's own title stops being the loudest thing on it. `outline` is what every other secondary control in this app wears and what `Picker`'s trigger wears. |
| **Dismiss** | `outline` / `neutral` | **Not `ghost`**, though `Mark all as seen` in the same header is: ghost is transparent until hovered, which is the reported defect rather than a fix for it. That header button is a page-level action sitting alone in whitespace; this one has to read as a control while standing next to Add to. **Not `danger`**: dismissing writes one ratingKey to `pending.yaml`, deletes nothing and adds nothing, and red on every tile of a full grid would claim otherwise. |

`Mark all as seen` keeps `ghost` — it is the one control in the header, it is destructive of
the whole list, and it is deliberately quieter than the per-item affordances it wipes out.

### `EditionBadge`, and the rule that had to move with it

The shared `EditionBadge` component (#153) renders exactly the `<span className="editionbadge">`
this file already had by hand — so **adopting the component alone would have fixed nothing.**
The bug is in the stylesheet, not the markup.

Both are done, and the pairing is the point: the component is adopted so there is one badge,
and `.results .editionbadge` becomes `.editionbadge` so the component is genuinely
reusable. Nothing in that rule (margin, padding, border, radius, colour, size, wrapping)
reads its container, so nothing in it ever wanted the ancestor. `.y` is un-scoped for the
same reason and its declaration is one colour.

**Neither un-scoping changes any other page**, verified by capture: the Home toolbar's search
rows are byte-for-byte the same shape before and after.

## Five more, on other pages — reported, not fixed

`e2e/borrowed-class-audit.ts` over `/`, `/queues`, `/pending`, `/channels`, `/q/<id>` and
four editors returns 23 class/element pairs. Most are **state classes on an ancestor**
(`body.play-view`, `body.queue-view`, `ul.editable`, Tailwind's `peer`) which exist to be
someone else's ancestor and legitimately match nothing themselves. Five are real:

| Where | Class | Only rules | Effect |
| --- | --- | --- | --- |
| `ChannelsView` `#newdyn`, `#newcurated` | `accent` | `#tools button.accent`, `.playlinks button.accent` | `＋ Filtered pool` / `＋ Curated pool` never get the accent border and colour that `＋ New queue` gets in the toolbar and on the Play landing |
| `ChannelFilters` `#ch-alllibs` | `subhint` | `#startmodal/#setmodal/#dynmodal .subhint` | a hint paragraph renders at body size and full contrast instead of 0.8rem muted |
| `DynModal` `#dyn-lineup` | `flags` | `#setmodal .flags` | the Lineup fieldset loses its flex column, its 2px gap and its 14px bottom margin |
| `DynModal`, two `Picker` triggers | `fieldselect` | `#setmodal .fieldselect` | no 10px inline-start margin |
| `SelectionBar` `#bulkapply` | `primary` | `#entrymodal`/`#groupsmodal` `.modalbtns button.primary` | Apply is not emphasised; `#selbar button` catches it, so it is not naked |

**Deliberately left for their own changes.** Each is a visible change on a page this PR does
not otherwise touch, and this repo's rule is that a visual PR carries before/after frames of
what it changed — four of these are also a *design* question ("should `＋ Filtered pool` be
accented?") rather than a restoration, because unlike Pending they have never had the look
their class name asks for. Bundling them would make one PR nobody can review by picture.

The auditor is **not wired into CI** for the same reason it is worth having: it needs a human
to separate a state class from a finding, and it would start red. A gate that starts red
teaches people to ignore it.

## Found in passing, and fixed: `PlayView.tsx` was invisible to `grep`

`web/src/views/PlayView.tsx` contained a **literal NUL byte** — a raw U+0000 inside
`next.join("…") === full.join("…")`, written as the character rather than as the escape.
`grep`/`ripgrep` classify a file containing a NUL as **binary and skip it**, so every
search across this repo silently omitted that file. The first pass of the audit above
"proved" `.playlinks` was dead CSS with no element carrying it; `<p className="playlinks">`
is on line 519 of the file grep would not read.

The separator is now spelled with the six-character escape `\u0000` inside the string
literal — the identical string at runtime, and readable text on disk. This is the repo-local instance of the workspace rule that a search which
cannot see a file returns a **false negative indistinguishable from a real answer**.

## Evidence

- Owner's report, quoted above (2026-08-21), with a screenshot of the live Pending page
  showing "Duel 1971Original TV Version".
- The stylesheet, at the commit that shipped it (7569496): `app.css:3540` is the only
  `.editionbadge` rule and it is `.results .editionbadge`; `:1561`/`:1570` are the only
  `.addto` rules and both are `.results .addto`; `:1874`/`:1882` are the only `.exclude`
  rules and both are `.tile .exclude`; `:920` is the only `.y` rule and it is `.results .y`.
  `.pendingtile .pendingactions` (`:3636`) sets layout and nothing else.
- Before/after captures from `e2e/shot-addto-menus.ts`, fixture data only — the fixture
  gained an `editionTitle` so the caption reproduces the reported shape. The **before** frame
  reads "Night of the Living Dead 1968Restored Cut" with two bare-text controls; the
  **after** frame has a muted year, a pill badge with a 6px gap, and two bordered buttons.
- Charcuterie 2.18.0 source read rather than assumed: `Button.tsx` (`ComponentPropsWithRef`
  + `{...buttonProps}`), `useAnchoredOverlay.ts` (what `useRole` injects into the clone),
  `useClonedChild.ts` / `mergeClonedProps.ts` (ref and `on*` compose).
- `e2e/borrowed-class-audit.ts`, self-testing on every route with a deliberately-borrowed
  probe element. Its first draft returned **zero findings on every page**, which was a bug
  and not a clean bill of health: CSS nesting gives every `CSSStyleRule` a truthy (empty)
  `cssRules`, so `if (rule.cssRules) { recurse; continue }` skipped the entire stylesheet.
  The self-test exists because that failure looks exactly like success.
- All CI gates green locally: Biome, both typechecks, 121 unit tests, both builds,
  `pick-contract`, `narrow-scroll`, `routing`, `play-reorder`, `pool-editor-keeps-blocked`,
  `shelf-remove`, `drag-stability`.

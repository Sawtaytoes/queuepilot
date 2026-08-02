# M6d phase 2 — plex-channels consumes `@charcuterie/ui`

**Date:** 2026-08-02
**Branch:** `feat/m6d-charcuterie-ui` · **PR:** #23
**Milestone:** charcuterie M6d, phase 2 of 2. Phase 1 is
[`2026-07-31-m6d-react-tailwind-frontend.md`](2026-07-31-m6d-react-tailwind-frontend.md).
**Ends on:** `@charcuterie/ui@^1.0.0`, `@charcuterie/tokens@^1.0.0`.
**Gates:** typecheck clean · `vite build` green · **28 web unit tests** ·
**125 e2e assertions across 8 suites, `suites failed: 0`** · plus four suites
outside `run.sh` (below).

---

## Where this started

A prior session was killed mid-edit by a usage limit and checkpointed at
`94467fd`, marked INCOMPLETE and never gated. It was **kept**. It had migrated
five selects (`#chchannel` with its `<optgroup>`s, `#chprofile`, `.rowtier`,
`#addpos`, the per-tile `.eps`) and the reasoning in its comments — the keying
rule below — was right.

What it was missing was one line: `QueueView.tsx` used `<Select>` twice with no
import. Three typecheck errors, and every gate downstream of the build was
blocked on them. With the import, its own gates were green: 125 assertions,
0 suites failed.

---

## What migrated

| Component | Sites | Notes |
| --- | --- | --- |
| **`Select`** | **12** | Every native `<select>` in the app. |
| **`Badge`** | **7** | `Series` / `Movie` / `Collection`, `Not in library`, `N watches`, `Completed`, `Now playing`/`Paused`, `N unwatched`, `Next-pick sample`. |
| **`EmptyState`** | **2** | The shelf strip and the queue grid. |
| **`Accordion`** | **1** | `#dynmodal`'s Advanced disclosure, was a `<details>`. |

And what did not, each because of a library API gap rather than effort —
`Field`, `Menu` (both menus), `Modal`, `Toast`/`ToastRegion`, and two of the nine
badge shapes. Full reasoning, with the measurement behind each:
[`decisions/2026-08-02-components-that-cannot-be-adopted-yet.md`](decisions/2026-08-02-components-that-cannot-be-adopted-yet.md).
None is worked around here; `charcuterie` was not touched.

---

## The two findings

### 1. The app's stylesheet was silently beating every component it adopted

`app.css` is **unlayered**; Tailwind's utilities are in `@layer utilities`; and
unlayered CSS beats every layer regardless of specificity. So the app's
hand-rolled skin and the component's own styling are not a close call — the app
wins, silently, with the build green.

`.playrow .rowtier { padding: 6px 8px }` outranked `Select`'s `pe-9`, which is
the padding reserving room for the chevron `Select` draws in an absolutely
positioned overlay. **The chevron printed on top of the label text.** Measured:
`padding-right: 8px`, chevron `<svg>` at x=413–430 inside a control ending at
x=442. Four more selects carried the same declaration; seven badge rules would
have made `intent` a prop that renders and does nothing.

Nothing caught it. Typecheck, the 28 unit tests and all 125 e2e assertions
passed with the chevron sitting on the text. **Only a screenshot found it** —
which is the concrete version of
`2026-07-31-never-claim-you-cannot-see-the-ui`.

Rule now recorded:
[`adopting-a-component-means-deleting-its-skin`](decisions/2026-08-02-adopting-a-component-means-deleting-its-skin.md).

### 2. An uncontrolled control needs a key, and keying it on its value is the wrong fix

`Select` and `Accordion` are uncontrolled by design — `value` / `expandedKeys`
seed a default and the DOM owns it after. That is correct, and it moves the
problem to the caller: a control seeded once at mount cannot hear a value that
arrives from a fetch, from the router, or from a modal re-seed.

The rule that works is **key on the second writer, never on the value** — because
keying on the value remounts the control under the user's own pick and takes
their focus with it. Every site, with the writer that justifies its key, is
tabulated in
[`uncontrolled-components-are-keyed-on-their-second-writer`](decisions/2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer.md).

The case that proves it: `.b-profile`'s binding stores
`user_uuid: 1111111111111111`, and the Plex profile list arrives a beat after the
modal opens. Without `key={profiles.length}` the control stays on the
placeholder — **a channel that has a profile looks like a channel that does
not**, and `readForm()` reads React state, so the DOM and the saved value would
diverge with nothing reporting it.

---

## The DOM contract: what changed, and what it cost

Phase 1's rule was that the seventeen Playwright suites gate the port because
they select on semantic ids and classes. **Not one selector was changed.** Every
class the suites read is still on the element — `Select` and `Badge` both pass
`className` through — and every id survives, which is exactly why `Field` could
not be adopted (it replaces the control's `id`).

Three CSS changes were needed to make the components sit correctly, all of them
about layout rather than about selectors:

| Rule | Why |
| --- | --- |
| `.addpos / .chhead label / .playrow / .tile .eps / #selbar label :has(> select) { flex: 0 0 auto; width: auto }` | `Select` wraps its `<select>` in a `w-full inline-grid` div so it can fill a `Field`. As a flex item that resolves against the whole row: `.rowtier` measured **403px on a 190px row** and dropped to its own line, and `.addpos`'s "Add to" was squeezed into a two-line wrap. `:has(> select)` names that wrapper by the select it holds — the only stable handle it has. |
| `.strip .empty { flex: 1 0 100% }` | The strip is a flex row; the placeholder had collapsed to **4px wide** — present in the DOM, invisible on screen. |
| `ul.grid .empty { grid-column: 1 / -1 }` | `ul.grid` is a real CSS grid, where a flex property means nothing; the item took one poster-wide track and wrapped the sentence into a 178px column. |

One deliberate visual change: the per-tile `.eps` picker is now ~44px tall rather
than a ~20px inline chip, because `Select` applies `MIN_TOUCH_TARGET_CLASS`
unconditionally. This app is used on a tablet, so it is an improvement rather
than a regression — but it is the most visible difference in the whole phase and
is called out here rather than left to be noticed.

---

## Evidence

Screenshots in [`images/`](images/) (`__screenshots__/` is gitignored fleet-wide),
all taken on `@charcuterie/ui@1.0.0`:

- `2026-08-02-m6d-ph2-badges.png` — the anime grid. Seven `Badge`s at their real
  sizes beside the two that could not migrate: the amber `Start E4` button and
  the two-part `[Collection][Chaika: The C…]` chip, both intact.
- `2026-08-02-m6d-ph2-play-landing-selects.png` — `.rowtier` back to 151px and
  inline on the title row, with its chevron.
- `2026-08-02-m6d-ph2-accordion-and-profile-select.png` — `#dynmodal` editing
  `younger`: the profile `Select` resolved to **Younger Kids** (the keyed
  remount) and the Advanced `Accordion` correctly collapsed under it.
- `2026-08-02-m6d-ph2-start-modal-season.png` — a five-season show at Season 11 ·
  E32, reached by driving the season picker; the dialog still centred, so
  preflight's `* { margin: 0 }` fix is intact.
- `2026-08-02-m6d-ph2-emptystate-shelf.png` / `-grid.png` — the two `EmptyState`s
  filling their row.
- `2026-08-02-m6d-ph2-light-scheme.png` — the amber accent override still flows
  into the library components with no prop: the `Series` badge computes
  `#7A5300` on `#C08A2A`, which is the light row of phase 1's contrast table.

### Behaviours driven end-to-end

| | |
| --- | --- |
| Collection start, member switch | 3 → 1 → 2 repaints the episode list (10 → 12 → 1 options), preselects E1 each time |
| Show start, multi-season | opens S7·E6; Season 11 → E32 |
| Save + clear | `Starts at E4`, chip `Start E4`, cleared from YAML |
| Binding profile preselect | `1111111111111111` — the value an unkeyed select misses |
| Advanced accordion | collapsed panel is `hidden`, not unmounted, so `.b-plexuser` is still reachable |
| **FLIP, optimistic add** | 21ms; new tile `opacity 0→1, scale(0.92)→none` over **180ms**; **11 siblings** `translate(-195.7px, 0)→none` over **240ms** — one tile-width, exactly one slot |
| **FLIP, optimistic remove** | 11 siblings glide `+195.7px`, 240ms |
| The three drags | `homedrag-test` green: intra-shelf, `.drop-target` highlight, cross-shelf move persisted |

FLIP was measured the way phase 1 measured it — by monkey-patching
`Element.animate` and reading the keyframes back — so the numbers are the ones
the browser actually ran.

---

## Gate numbers

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `vite build` | green |
| `vitest run` | **28 passed** |
| `e2e/run.sh` | **125 assertions, `suites failed: 0`** |
| `verify-profile-bindings.mjs` | **16/16** |
| `verify-members.mjs` | **20/20** |
| `verify-start-modal.mjs` | **15/15** |
| `verify-shorts-pool.mjs` | **4/4** |

The last four are not in `run.sh` and so are not CI-gated, but all four cover
surfaces this phase changed, so they were run by hand.

### Two failures that are NOT this branch's

Both were reproduced on `main` in a worktree before being called pre-existing.

1. **`ui-test` → "A: heading shows the new label"** — reads `#heading`'s
   textContent immediately after the status toast says "Renamed", racing the
   refetch that repaints the heading. Isolated and run repeatedly on both sides:
   **1 failure in 8 on `main`, 1 failure in 10 on this branch** — the same rate,
   so the extra ~10 KB of components has not widened the race. It shows up more
   often inside a full `run.sh` (a busier machine) on either side. Worth fixing
   in the test: wait for the heading, not for the toast.
2. **`verify-member-optimistic` → "second remove kept the other member"** — a
   second optimistic member remove deletes a shifted neighbour's slot rather than
   its own. **2/2 failures on `main`, 2/2 here** — reproducible, not a flake. A
   real latent bug, and it is invisible to CI because that suite is not in
   `run.sh`. Worth its own fix; out of scope for a component migration.

---

## For phase 3 / M6f

Ranked by how much they unblock here:

1. **`FieldGroup` for the ~7 checkbox groups — do this first, it is unblocked.**
   New in 1.0.0, and it fits: `<fieldset>` + `<legend>`, children rendered
   **as-is rather than cloned**, and the ids the suites read (`#ch-ratings`,
   `#set-libs`, `#ch-movielibs`, `#ch-otherlibs`) are on the inner `.libs` div,
   not the `<fieldset>` — so nothing is renamed.

   Two things make it bigger than the seven sites suggest, which is why it is
   its own PR rather than the tail of this one:

   - **`FieldGroupProps` has no rest-props passthrough**, and three fieldsets
     carry their own `id`/`hidden` (`#ch-otherbox`, `#dyn-otherbox`,
     `#dyn-profilesbox`). Either the library takes a passthrough or those need a
     wrapper element.
   - **It is all-or-nothing per panel.** `#chfilters fieldset` and
     `#setmodal, #dynmodal fieldset` style *every* fieldset in those containers,
     and not all of them are checkbox groups — `#dyn-profilesbox` holds the whole
     bindings sub-editor, and two in the filters panel hold a search box and a
     list. Migrating only the checkbox ones leaves two differently-styled box
     treatments stacked in one 300px panel. Convert a whole container at a time.
2. **`Field` must not overwrite the control's `id`.** It blocks the ~10
   single-control fields. Re-verified against the installed **1.0.0** — M6f fixed
   `Field`↔`Tooltip` slot merging between two library components, not this.
3. **`Menu` needs a point anchor** (a virtual reference) and an `id`, for the
   right-click `TileMenu`; and **a way to render non-item content** (loading,
   empty, error) for `PlayMenu`.
4. **`Modal` needs a form story** — the three dialogs here are `<form>`s whose
   footer buttons are `type="submit"`, and the app's own `Modal` also owns the
   `busy.openModals` guard that keeps an SSE refetch off an in-flight drag.
5. **`Badge` needs `asChild`** (two of the nine shapes are buttons) and **a
   two-part shape** for the collection chip — M6a predicted this one.
6. **`ToastRegion` vs `#status`.** Not attempted: `#status` lives in the header
   and is polled by textContent across most suites, so moving it to a fixed
   region is a UX relocation, not a swap. Decide the placement first.

Also still true from phase 1, and untouched here: the symbol glyphs (`▶ ▾ ⚙ ＋`)
still contradict `2026-07-29-ship-no-icons-and-no-symbol-glyphs` and still render
as tofu in this sandbox; `confirm()` is still the destructive-action channel in
two places; and the e2e suites still hardcode mux-magic's Playwright, whose
browser pin (1228) has drifted from `/opt/pw-browsers` (1234) — worked around
again with `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers` plus
`node mux-magic/node_modules/playwright/cli.js install chromium-headless-shell`.

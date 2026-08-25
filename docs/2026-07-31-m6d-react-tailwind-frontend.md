# M6d phase 1 — plex-channels becomes a React + Tailwind consumer

**Date:** 2026-07-31
**Branch:** `feat/m6d-react-tailwind`
**Milestone:** charcuterie M6d, phase 1 of 2. Phase 2 is gated on
`@charcuterie/ui@0.2.0` publishing the nine P1 components.
**Gates:** typecheck clean · `vite build` green · **28 web unit tests** (new) ·
**125 e2e assertions across 8 suites, `suites failed: 0`**.

---

## What this was

charcuterie's M6a (`docs/2026-07-31-m6a-the-p1-components.md`) surveyed the fleet and
found plex-channels in the "cannot consume `@charcuterie/ui`" column:

> | plex-channels | `web/index.html` + `app.js` + `style.css`, no build | no |

One 2,921-line `app.js`, one 695-line `style.css`, no build step, and a hand-rolled
six-hex dark palette with no way to get a light mode. There was no seam a React
component library could enter through.

Phase 1 builds that seam. It is a **framework migration, not a redesign** — same
layout, same copy, same behaviour, same DOM — with `@charcuterie/tokens@0.2.0`
adopted as the colour/type source and the app's own components standing in for the
charcuterie ones until they publish.

Stack decision:
[`decisions/2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens.md`](decisions/2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens.md).

---

## The constraint that shaped everything: the DOM is a contract

This repo has **seventeen Playwright suites**, five of them CI-gated, and they select
on semantic ids and classes — there is not one `data-testid` in the tree. They also
read computed `display` off body-class-driven rules, read `.hidden` off shelves, and
drive real pointer sequences.

So the port preserves the DOM rather than reinventing it:

- Every id (`#grid`, `#chpool`, `#start-episode`, `#dyn-bindings`, …) and every class
  (`.tile`, `.shelf`, `.strip`, `.badge`, `.qmenu`, `.startbadge`, …) still exists.
- The four view containers are **always mounted** and toggle the `hidden` attribute,
  exactly as before. Their *content* only renders for the active view, so a hidden
  pane never holds stale data.
- The body classes (`queue-view`, `play-view`, `channel-mode`, `movies-channel`,
  `gdrag`/`hdrag`/`sdrag`, `name-editable`) still drive CSS on their children.
- `#tools` is still one element physically re-parented between `#gslot-desktop` and
  `#gslot-mobile` at 760px.

That constraint turned out to be a gift: it made the e2e suites a real regression
gate for the port rather than something to be rewritten alongside it.

### What each old file became

| Was | Is |
| --- | --- |
| `web/app.js` (2,921 lines) | 30 modules under `web/src/` |
| `web/style.css` (695 lines) | `web/src/styles/app.css`, every colour a token role |
| `renderPlay` / `renderHome` / `renderQueue` / `renderChannels` | `views/PlayView` `QueuesView` `QueueView` `ChannelsView` + `App`'s `computeChrome` |
| `DATA` / `REG` / `NOW` / `selected` module globals | `state/store.ts` + `state/selection.ts`, read through `useSyncExternalStore` |
| `uiBusy()` reading six globals | `state/busy.ts`, still mutable module flags — see below |
| `flipPaint()` (measure, mutate, measure) | `useFlipList` from `@charcuterie/logic` — render-phase measure + layout-effect animate. Was `hooks/useFlipList.ts` here until 2026-08-25; Docket needed the same shape, so it moved to the library and this app adopts it. |
| `flipMove()` + the three drag gestures | `hooks/useGridDrag.ts`, `hooks/useHomeDrags.ts` — still imperative |
| `wireSearchInput` + `wireListNav`, four call sites | `components/SearchDropdown.tsx` |
| `openSetModal` / `openDynModal` / `openStartModal` / `openTileMenu` / `openPlayMenu` | `state/overlays.ts` + five components on one `<dialog>`-based `Modal` |
| the untyped `/api/*` responses | `lib/types.ts`, hand-written off the routes that emit them |

**3,616 lines of vanilla deleted; ~4,600 lines of TSX + tests added.** That is not a
line-count win and reporting it as one would be dishonest (M5 made the same note).
What it buys is a consumer that can take components at all, plus a typed wire
contract and a light mode.

---

## Four things kept imperative on purpose

### 1. `uiBusy()` is still mutable module flags

The guard that stops a live re-render landing mid-gesture is read from an
`EventSource` listener and a `setInterval` — neither has a component to read state
from, and a stale closure there silently re-opens the bug it exists for (an
SSE refetch replaced the DOM under an in-flight drag, the dragged element was
re-inserted beside its fresh copy, and the drop saved a duplicated order).

### 2. The three drags never re-render

`2026-07-21-ui-interaction-states-standard` records the rule: *use transform-only
FLIP, never a re-render, during drag*. Each gesture moves ONE node with
`insertBefore` and lets `flipMove` glide the siblings via transforms.

React adds exactly one thing: because the gesture mutated the DOM behind React's
back, **the dragged node is put back where React last rendered it** before any state
update. React then performs the reorder itself from a DOM it believes, which is the
only way to avoid a stale-fiber `insertBefore`. The restore is invisible — the
optimistic state update lands in the same tick.

Verified mid-gesture in a live browser: `body.gdrag` set, one `.dragging` tile
carrying the lift transform (`matrix(1.05964, -0.0277476, …)` = `scale(1.06)
rotate(-1.5deg)`), siblings carrying `transition-property: transform`, and on drop
the server order matching the DOM order exactly.

### 3. The empty-shelf placeholder is hidden, not removed

The vanilla `onHomeMove` did `target.querySelector('.empty')?.remove()` when dragging
into an empty queue. Removing a React-owned node makes React's next commit throw
`NotFoundError` on `removeChild`. It is now `display: none`d for the duration and
restored on drop — visually identical, tree intact.

### 4. FLIP's "First" is measured during render

> **Since 2026-08-25 this lives in `@charcuterie/logic`, not here.** Docket's phase
> list needed the same animation, and a second copy is how two implementations drift,
> so `useFlipList` moved to the library and both apps call it. The reasoning below is
> why it is shaped the way it is, and still applies — the library hook carries the
> same note. What stayed in `lib/flip.ts` is `flipMove`, which is a DRAG's animation
> and a different thing: it must not re-render, and the library hook animates exactly
> what React re-rendered.

`flipPaint` measured, mutated, then measured again inside one function. React splits
those: the mutation *is* the commit. So the first measurement happens in the render
phase, where the DOM still holds the previous commit, and the last measurement +
animation happen in a layout effect. Reading the DOM during render is impure and is
also the only place those boxes still exist; it is safe here because the read has no
effect on the tree — StrictMode's double render just measures the same DOM twice.

Measured on a real add: the new tile animates `opacity 0→1, scale(0.92)→none` over
180 ms and all six existing tiles animate `translate(-196.25px, 0)→none` over 240 ms —
one tile-width each, which is exactly one slot.

---

## Three defects the browser found that no gate could

All three built, typechecked and looked right in the source.

### 1. The optimistic add was not optimistic — 403 ms, not 6 ms

`QueueView` memoised its item list on the **set object**:

```tsx
const items = useMemo(() => (isChannel ? [...q.items].sort(byTitle) : q.items), [isChannel, q])
```

An optimistic add mutates that set **in place** and republishes the store snapshot,
so `q`'s identity never changes — the memo returned the stale array, and the tile only
appeared when the background refetch landed. The feature still *worked*; it had just
silently become the freeze it exists to remove.

Measured with a `MutationObserver`: **403 ms → 6.3 ms**. Remove: 3.5 ms.

The memo is gone. Sorting a few dozen entries per render costs nothing; being wrong
costs the whole feature.

### 2. Tailwind's preflight un-centres every `<dialog>`

`* { margin: 0 }` kills the UA's `inset: 0; margin: auto` on a `showModal()` dialog.
All three modals rendered in the top-left corner. Nothing failed — it just rendered
in the wrong place, and only a screenshot showed it.

### 3. The search box stopped re-searching identical text

React installs a value tracker on every `<input>` it renders and **suppresses the
change event when the value is unchanged**. So typing the same query a second time
fired nothing at all and the search silently never ran. The vanilla box used a native
`input` listener, which always fires.

`ui-test` caught this — it fills `#gsearch` with `toy tinkers` twice, before and after
creating a queue. The input is now uncontrolled with a native listener, which is what
it was before.

### And a race the shelf reorder shares with SSE

The order PATCH rewrites `sets.yaml`, which pings SSE; a `liveRefresh` whose GET was
issued *before* that write completes lands afterwards carrying the OLD order and
reverts the shelves. It reproduced about one run in three. The known-good order is now
re-asserted once the PATCH resolves. Three consecutive `ui-test` runs green after.

---

## Preflight, in general

Two more preflight removals had to be put back, both caught by reading it rather than
by a gate:

- **`h1…h6 { font-size: inherit; font-weight: inherit }`.** The old stylesheet sized
  `header h1` and the two `h2`s explicitly but left the three modal `<h3>`s to the UA.
- **`input { background-color: transparent; border-radius: 0 }` + `* { border: 0 }`.**
  Harmless for a text input; a **checkbox** still paints its native widget and the
  reset leaves it a hollow, cornerless box. The library/ratings pickers are ~40
  checkboxes.

One preflight rule made things *easier*: `[hidden] { display: none !important }`
means every `:not([hidden])` display rule in the old stylesheet is now belt-and-braces,
and a `hidden` attribute can never lose to a utility.

---

## The trap from the sibling migration, avoided

gallery-downloader's port shipped this bug and M6e documented it: an inline `<style>`
is **unlayered**, unlayered CSS beats every `@layer`, and Tailwind emits utilities
into `@layer utilities` — so a flat `background-color: #131822` in the anti-flash rule
silently outranks the token and pins the canvas dark forever.

Written here as a `var()` fallback from the start:

```css
html, body { background-color: var(--color-surface-base, #131822); color-scheme: dark; }
```

Measured on a live page under `data-scheme="light"`: `<html>` and `<body>` both
compute `rgb(245, 247, 250)`. Guarded by `src/firstPaintColour.test.ts`, which
asserts the literal matches `daylight.schemes.dark.surface.base` **and** that no
declaration in that inline block lacks a `var(--color-…)`.

---

## Screenshots

Archived in [`images/`](images/) — `__screenshots__/` is gitignored fleet-wide, so
evidence anyone else has to read lives here.

- `2026-07-31-m6d-play-landing.png` — the Play landing, three groups
- `2026-07-31-m6d-queues-shelves.png` — the poster shelves
- `2026-07-31-m6d-collection-tile-member-first.png` — the anime grid. The Chaika tile
  shows the **member's** poster, `Avenging Battle (2014)` with the collection prefix
  stripped, `E1 · The Princess Who Gathers the Remains`, and the two-part
  `[Collection][Chaika: The C…]` badge — the whole of
  `2026-07-31-collection-tiles-are-member-first`, intact.
- `2026-07-31-m6d-start-modal-collection.png` — the picker for a collection entry:
  Series (`3. Chaika… (0/12 watched)`), then Episode, Season row hidden because the
  member is single-season.
- `2026-07-31-m6d-tile-menu-and-start-chip.png` — the context menu's three actions and
  the amber `Start E4` chip, with the yellow line moved to `E4 · The Writhing Island`.
- `2026-07-31-m6d-channels-pool.png` — the eligible pool: five show buckets with
  `N unwatched`, five individual shorts each with its own Exclude, and the
  no-members one-liner.
- `2026-07-31-m6d-light-scheme.png` — **the interesting one.**

### Behaviours driven end-to-end in a real browser

| | |
| --- | --- |
| Start override, show entry | single-season → Episode only, preselected at next-up |
| Start override, collection | Series → Episode; saved `E4`; chip + yellow line both updated; toast `Starts at E4` |
| Clear via the context menu | chip gone, line back to `E1` |
| Optimistic add (queue) | 6.3 ms; new tile fades in, six siblings glide one slot |
| Optimistic remove (queue) | 3.5 ms; six siblings glide |
| Optimistic add / remove (members) | 4.5 ms / 4.1 ms; alphabetical insert; reconciles to `E10 · …` + `Series` |
| Grid drag-reorder | server order == DOM order, `Order saved` |
| Cross-shelf poster move | `.drop-target` highlight mid-gesture, `Moved to Bob & Alice — Movies`, both sets correct server-side |
| Shelf reorder | `Queue order saved`; rotation channels keep their spot at the end |

---

## Phase 2's work order

Written from the code, so the next session starts with it. These are the components
this app now duplicates that `@charcuterie/ui` covers:

| App code | Becomes | Notes |
| --- | --- | --- |
| `components/Modal.tsx` + the three dialogs | **`Modal`** | Ours is a real `<dialog>` + `showModal()`. Whatever `Modal` is built on must keep that, or keep Esc / focus containment / the inert backdrop some other way — and must not re-introduce the `margin: auto` loss. |
| `components/TileMenu.tsx` | **`Menu`** | Already `position: fixed` + viewport clamping + Escape + outside-pointerdown. M6a's finding applies directly: **a menu is named by its trigger** — but this one is opened by a right-click on a tile, so it is the case that *does* need its own name. Worth deciding explicitly. |
| `components/PlayMenu.tsx` | **`Menu`** | Anchored to a button; the M6a rule fits unmodified. |
| every `.badge` (`Series` / `Movie` / `Collection` / `Not in library` / `Completed` / `Now playing` / `N unwatched` / `Start E20`) | **`Badge`** | ~8 shapes. Two are buttons (`.startbadge`, `.exclude`) and want `Badge` + `IconButton` or a `Badge asChild`. The two-part collection chip (`.badgekind` + `.badgename`) has no obvious `Badge` analogue — it may need one. |
| `components/CheckboxGroup.tsx` + the `.libs` grids | **`Field`** + a checkbox group | ~7 sites (set modal libraries, channel ratings, three channel library groups, two per binding). |
| the twelve native `<select>` sites | **`Select`** | `#addpos`, `#gaddpos`, `#set-kind`, `#dyn-behavior`, `#chchannel`, `#chprofile`, `#movetarget`, `#start-series`, `#start-season`, `#start-episode`, `.rowtier`, the per-tile `.eps`. All have a DOM-owned value, which is precisely `Select`'s case. `#chchannel` uses `<optgroup>` — check `Select` supports it before migrating that one. |
| every labelled input (`#set-label`, `#dyn-label`, `#dyn-kind`, `#dyn-audio`, `#ch-audio`, the three `.subfield`s per binding) | **`Field`** | ~10 sites. |
| `#dynmodal .advanced` (`<details>`) | **`Accordion`** | One site. M6a's finding is the reason: `<details>` owns `open`, and a `<summary>` cannot be disabled. |
| `.empty` placeholders (`Empty — open to add.`, `Empty — search above to add.`, `Nothing blocked.`, `Nothing excluded.`) | **`EmptyState`** | Four sites. |
| `#status` | **`Toast` + `ToastRegion`** | The toast machine already exists here by hand: a 4s/10s auto-dismiss keyed on kind, newer message cancels the previous timer. `ToastRegion` is the fleet's first `position: fixed` component — M6a's note about `mountStory` leaking canvases is worth re-reading before writing tests around it. |
| `SearchDropdown` | **not `Select`** — a combobox | Explicitly NOT a `Select` caller, for the same reason M6b's `PortalDropdown`/`CommandPicker` are not. It stays put until P2 ships a combobox. |

### Three things phase 2 must not undo

1. **The DOM contract.** Any component that renames a class or drops an id breaks a
   suite. Migrate one component per PR and run `e2e/run.sh` each time.
2. **The uncontrolled search input.** A `Field`/`Input` that controls its value
   re-introduces defect #3 above.
3. **The imperative drags.** They are the one place a component must not own the DOM.

### Two drifts to reconcile, not port

- **Symbol glyphs.** `▶`, `▾`, `↶`, `↷`, `≡`, `⚙`, `✎`, `›`, `‹`, `＋`, `⏸` all
  survive the port and all contradict charcuterie's
  `2026-07-29-ship-no-icons-and-no-symbol-glyphs`. Not hypothetical: **this sandbox
  has no font containing them at all** (`fc-list` shows only URW/Liberation/Nimbus),
  so every one renders as tofu in the screenshots above. That is a sandbox artifact
  rather than a regression — the vanilla build had the same glyphs — but it is the
  concrete version of the rule.
- **`confirm()` is still the destructive-action channel**, in two places (delete a
  queue, delete a channel). `Modal` exists for both.

---

## Ordinary caveats

- **The app has no linter.** It never has. `typecheck`, `test`, `build` and the e2e
  suites are the gates. Adding Biome here is its own change and was not smuggled into
  this one — but the source follows the fleet's conventions by hand (sorted props,
  `is`/`has` boolean prefixes, no barrel files).
- **No component/DOM tests.** The 28 unit tests cover the pure logic — the tile-face
  rules the recent UX decisions settled, the hash router, and the first-paint guard —
  and run in a Node environment with no jsdom. Rendering tests would need a second
  Vitest project; phase 2 is the natural time, since that is when the components
  arrive with their own guarantees. The real coverage of this UI is `e2e/`.
- **`npm`, not Yarn workspaces.** This repo is not a monorepo; `server/` and `web/`
  are two independent npm projects beside a Python package, and CI already did
  `npm ci --prefix server`.
- **The e2e suites cannot run in this sandbox as shipped.** They hardcode
  `createRequire('/mnt/TrueNAS-Apps/Repos/mux-magic/node_modules/')`, and that
  Playwright pins browser revision **1228** while `/opt/pw-browsers` now carries
  **1234**. Pre-existing drift, unrelated to this work. Workaround used here:
  `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers` plus
  `node mux-magic/node_modules/playwright/cli.js install chromium-headless-shell`.
  Worth fixing properly at some point — either repoint the suites at the repo's own
  `node_modules` or refresh mux-magic's pin.
- **`e2e/dev.sh` and `e2e/run.sh` now build the frontend first.** A stale or missing
  `web/dist` means every browser suite drives an empty page.

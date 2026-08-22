# AGENTS.md

Operational notes for AI agents working in **queuepilot**. What the app is, how it is laid
out and how to run it are in [`README.md`](README.md); every settled decision is in
[`docs/decisions/`](docs/decisions/README.md) (newest first) — **check it before proposing a
change**, a settled decision outranks your default instinct.

## ⚠️ This repo is PUBLIC on GitHub

`Sawtaytoes/queuepilot`. No personal detail of any kind reaches it — not in code, comments,
fixtures, commit messages, PR text or screenshots. People, hosts, IPs and library contents
are placeholders
([decision](docs/decisions/2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders.md));
`e2e/fixtures/` is synthetic and is what a screenshot may show. Secrets live in the app env,
never in the tree.

## UI / Charcuterie

- **Every picker is a `Listbox`, never a native `Select`.** `Listbox` for a short list,
  `Combobox` when it is long enough to want typing. Rich options are what `<option>`
  *cannot* do, not the dividing line: a plain list of strings still gets a `Listbox`,
  because the native `<select>` paints as the OS widget and looks wrong on Windows and
  inconsistent everywhere else. Native `Select` is a compatibility hatch this app has never
  needed, and there is not one call site left — do not add the first one, and do not write
  guidance that recommends it. This app settled it on 2026-08-07
  ([decision](docs/decisions/2026-08-07-plex-channels-pickers-are-listbox-not-native-select.md)),
  and it is now the fleet standard as well. The other two records live in **sibling
  workspace repos, not on GitHub** — so they are named rather than linked, because a link
  from here would 404 for anyone reading this on the public repo:
  - `agentic:docs/decisions/2026-08-20-listbox-is-the-picker-in-every-owned-app-and-native-select-is-a-hatch-we-have-never-needed.md`
  - `charcuterie:docs/decisions/2026-08-10-listbox-and-combobox-are-the-default-and-select-is-demoted.md`
    (on `origin/master`)
- **A menu is not a picker, and the picker rule does not reach it.** `Listbox`/`Picker` is
  for a control that HOLDS a value; a list of *actions* is a Charcuterie **`Menu`**. The test
  is the row: a `menuitem` **does** something, an `option` **is** something. The two Add-to
  menus (`PendingView.tsx`, `Toolbar.tsx`) POST an add and keep no selected value, so they
  are `Menu`s — do **not** "finish the picker migration" by converting them
  ([decision](docs/decisions/2026-08-21-an-add-to-menu-is-a-menu-not-a-picker.md)). The
  Add-to POSITION control one element away in the same toolbar does hold a value and is
  correctly a `SelectListbox`. Two consequences: a `Menu` panel **portals to `<body>`**, so
  `#gresults .addtomenu` is wrong by construction and e2e reads `.addtomenu
  [role="menuitem"]` document-wide; and **no linter can catch a hand-rolled menu** — the ban
  below is on a native `<select>`, and a `<div>` full of `<button>`s trips nothing.
  `PlayMenu.tsx` is the one hand-rolled menu left, on purpose, and says why at the top of the
  file.
- **A class name is not a style — never copy one into a view it was not scoped for.** Most
  rules in `app.css` are descendant rules (`.results .addto`, `.tile .exclude`), so the same
  class on a page without that ancestor renders **unstyled** while looking styled in the
  source, in review and in the diff. It reached the owner three times in one screen
  ([decision](docs/decisions/2026-08-21-a-class-name-is-not-a-style.md)). Two rules follow:
  a control that needs a look is a **Charcuterie component**, not a class name plus a hope;
  and a class used by a **shared component** gets a **container-independent** rule, or the
  component only works where it was born. Nothing automated can catch this — Biome sees a
  string, tsc never reads the CSS, and unstyled markup passes axe — so the check is
  `server/node_modules/.bin/tsx e2e/borrowed-class-audit.ts`, which asks the browser whether
  each element matches any rule for each class it wears. It **reports, it is not a CI gate**
  (a state class on an ancestor matches nothing on purpose). The five findings it left open
  on other pages are **all fixed** as of 2026-08-21, by adopting components rather than by
  un-scoping rules; it now returns **18** pairs. Sixteen are a state class or one of Tailwind's own
  `peer` / `divide-*` primitives; the other two are **`.playbtn`**, which is deliberately a
  DOM handle carrying no rule — `PlayMenu`'s outside-click handler asks
  `t.closest(".playbtn")`, so the class has to exist and must not paint. A rise in this
  number is not automatically a regression, but it needs a reason written down here. ⚠️ Do not trust a zero from it — its first
  draft returned zero on every route, which was a bug (CSS nesting gives every `CSSStyleRule`
  a truthy empty `cssRules`). Confirm the self-test probe fires.
- **A control is a Charcuterie component configured by PROPS, not an app class name.** When
  `@charcuterie/ui` ships the thing, use it: a pressable control is a `Button` /
  `ButtonLink` / `IconButton` with `appearance` / `intent` / `size`, a pill is a `Badge`, a
  label over one control is a `Field` and over several a `FieldGroup`. **A `className` on a
  Charcuterie component is a smell** — `app.css` is unlayered and Tailwind's utilities are in
  `@layer utilities`, so *any* app rule outranks the component it lands on. It is never a
  tweak; it is a silent override. `#selbar button` was the third time this bit, and it
  reached two `Picker` triggers and a `Badge` nobody had thought about: the rule was written
  for hand-rolled buttons and a `Picker`'s trigger IS a `<button>`. This is the stronger half
  of the borrowed-class rule above — it binds a class that **does** match too, which is why
  `borrowed-class-audit.ts` cannot see it
  ([decision](docs/decisions/2026-08-21-a-component-configured-by-props-not-a-borrowed-class.md)).
  Three exceptions, and they are the whole list: **app layout** (page scaffolding, grids, the
  gap between two form blocks) is not a component-library concern and may sit on a
  component's outer element when it sets position and spacing only; **a shape the library
  cannot express yet** (the two-part Collection chip) keeps its app class and says why; and a
  **DOM handle** — `data-testid`, or a class used *only* as a selector and carrying no rule,
  which is what `#dyn-lineup` had to become because `FieldGroupProps` forwards nothing but
  `className`. ✅ The two upstream gaps this file used to warn about are **closed** as of
  `@charcuterie/ui@3.7.0`: `FieldProps` and `FieldGroupProps` now spread their rest props,
  and `Checkbox` takes a `description`. They land on different elements and the difference is
  not a preference — `Field` **clones** onto its one child, so its rest props are that
  **control's** (`name`, `placeholder`, `aria-*`, `ref`) and only `className` stays on the
  wrapping `<div>`; `FieldGroup` **wraps**, so its rest props are the **`<fieldset>`'s**
  (`id`, `hidden`, `data-testid`, `ref`). A box that needs a handle on itself — an `id` for a
  shot script, a `hidden` that takes the label with it — is a `FieldGroup`, even when it
  holds one control.
- **An in-app navigation that looks like a control is a `ButtonLink`, and the app injects its
  router.** `@charcuterie/ui` is router-agnostic: `ButtonLink` renders a plain `<a href>`
  unless the app fills the **link seam**, and a plain `<a>` to an in-app path is a **full
  reload** — the SPA boots again and the query cache goes with it. `main.tsx` wraps the tree
  in `RouterLinkProvider link={ReactRouterLink}` (from `@charcuterie/ui/react-router`, an
  optional peer on its own entry point, so the base package never resolves `react-router`),
  and `getIsRoutedHref` still hands another origin, `mailto:` and a `#fragment` back to the
  browser — which is why the Plex and Kavita launchers keep opening a new tab. The header's
  Narrow-View back row was a bare `<a href>` and **did** full-reload; that is what the seam
  fixed. A `<Link>` in a hand-painted skin is the thing this replaces, not an alternative
  to it.
- **The button migration is finished, and what is still a raw `<button>` is a decision.**
  65 hand-rolled buttons became Charcuterie components over 2026-08-21/22, and the skins
  went with them — `.primary`, `.accent`, `.ghost`, `.tagbtn`, four modal-footer skins and
  five element selectors are all deleted. **Seven** raw `<button>`s are left, and each is
  deliberate, so do not "finish the migration" by converting them:
  - **`Modal`'s `.modalx`** — the app's `Modal` is hand-rolled (a `<form>` plus the
    `busy.openModals` guard), and its round scrim ✕ is part of that shape. Converting the
    MODAL is the change; the close button is not separable from it.
  - **`PosterTile`'s `.tileplay` and `.remove`** — chrome positioned ON the artwork, a
    38px circle centred over a poster and a ✕ in its corner. Neither is a control shape the
    library expresses.
  - **`QueuesView`'s two `.scroll` arrows** — a 44px full-height gradient over the strip's
    edge, revealed on hover. A fade, not a button.
  - **`GroupsModal`'s `.grouppick`** — a master-detail list ROW carrying `aria-current`,
    not a button.
  - **`GroupBar`'s `#groupsedit`** — the only one of these blocked on the LIBRARY rather
    than settled. It is a chip-shaped button among four chip-shaped `<Link>`s, and
    `BadgeButton` would migrate one of five and split the row. It needs a `BadgeLink`,
    which does not exist yet.

  Everything pill-shaped and pressable is a **`BadgeButton`** (`@charcuterie/ui@3.10.0`),
  built for this app's six chips — the setting tags, the Edit chip, two start chips and a
  pool's Exclude. It shares `Badge`'s paint through one hook upstream, so a tag you can
  press and a tag you cannot are now the same pill; they were different sizes before.
- Pickers go through **`SelectListbox`** (`web/src/components/SelectListbox.tsx`), a thin
  adapter over `@charcuterie/ui`'s `Picker`, so a call site is one element with
  `options`/`value`/`onChange`. Two things in it are this app's and must survive any
  refactor: **`data-value` inside every option label** (how `e2e/pick.ts` picks) and the
  **`id` → `data-testid` swap** (how the browser suites find a trigger)
  ([decision](docs/decisions/2026-08-13-selectlistbox-adopts-the-shared-charcuterie-picker.md)).
- The trigger is `Picker`'s default **`appearance="outline"`** — a form control standing
  where a `<select>` used to, so it wears a border and the page surface. Solid neutral reads
  as a filled button, which is obvious in light mode. Don't override it.
- **Key a picker on its second writer, never on its value.** `selectedValue` is a *seed*, so
  a value changed from outside (the router, a reset, a server round-trip) needs a remount to
  keep the panel's checkmark true — but keying on the value itself remounts the control under
  the user's own focus
  ([decision](docs/decisions/2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer.md)).
  The `#chchannel` / `#chprofile` pair in `ChannelsView.tsx` is the worked example.
- **The picker rule is machine-enforced, by Biome, with no second linter.** `web/biome.json`
  extends **both** `@charcuterie/biome-config` and `@charcuterie/biome-config/app`; the
  second is a delta that bans a raw `<select>`, a `<Select>` and the `Select` import via
  `noRestrictedElements` + `noRestrictedImports`. It replaces the note that used to sit
  here saying the rule ran nowhere in this repo — it does now, and it is an error.

  **Both entries, and the order matters.** Biome does not resolve a nested `extends` inside
  an extended config, so a lone `/app` would give you the picker rules and silently revert
  the entire house style — 60 columns, no semicolons, the Tailwind CSS parser — to Biome's
  stock defaults, with no error at all.

  The equivalent ESLint rules (`charcuterie/no-raw-select`,
  `charcuterie/prefer-listbox-over-select`) still do not run here, and do not need to:
  this repo lints with Biome and the ban is expressed natively.

## queues.yaml

**Every entry is a MAPPING** — `{ratingKey, title}` for an item, `{collection: "<name>"}` for a
collection, `{title: "<text>"}` for a title with no key yet. A bare string (`- "Duel (1971)"`,
`- 12345`, `- "Collection: X"`) is the pre-2026-08-21 form: `loadEntries()` refuses it BY ENTRY
and logs the mapping to write, so that one line stops playing and the rest of the queue does not
([decision](docs/decisions/2026-08-21-a-queue-entry-is-an-object-and-carries-its-rating-key.md)).

Three things follow, and each has cost something already:

- **`entryKey()` is PINNED and still keys a scalar.** It is the LINE identity that
  `e2e/fixtures/golden/` records and that remove/reorder/move address a line by. Do not widen it.
- **No writer may emit a scalar.** `queues.toEntryObject()` normalizes at the write boundary
  (the HTTP API still accepts a bare title — only the disk shape changed), and `entryNode()` no
  longer collapses an entry back to a string when its last override is cleared.
- **A fixture with a bare string fails the gate that reads it.** They were all rewritten; a new
  one must be written as a mapping.

The one-shot upgrade is `server/src/tools/migrate-entry-objects.ts` — dry run by default, backup
first, idempotent. **It runs BEFORE the new code deploys**, never after.

## Gates

Everything CI runs is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), and it is
the source of truth. The fast loop, from the repo root (yarn Berry, committed release —
`npm`/`npx` are denied fleet-wide):

```sh
yarn install --immutable
yarn workspace queuepilot-web run lint:biome
yarn workspace queuepilot-web run typecheck && yarn workspace queuepilot-web run test
yarn workspace queuepilot-server run typecheck && yarn workspace queuepilot-e2e run typecheck
yarn workspace queuepilot-web run build && yarn workspace queuepilot-server run build
server/node_modules/.bin/tsx e2e/pick-contract-test.ts   # the picker contract
```

The Playwright browser suites are gated on the `PLEX_TOKEN` secret and are **skipped on every
PR**; the no-Plex browser gates always run, which is why picker/layout/routing claims belong
there rather than in the gated block. All eight of them, in the order `ci.yml` runs them:

| Gate | What it pins |
| --- | --- |
| `narrow-scroll-test.ts` | the Narrow View never scrolls horizontally |
| `drag-stability-test.ts` | a drag's PATH, not its result — reversals, re-inserts, style writes |
| `routing-test.ts` | the client router and the server's SPA fallback, together |
| `pick-contract-test.ts` | the `pick.ts` ↔ `SelectListbox` contract |
| `pool-editor-keeps-blocked-test.ts` | a pool edit does not drop Blocked |
| `shelf-remove-test.ts` | the shelf's remove ✕ |
| `group-create-test.ts` | a new queue joins the group on screen |
| `play-reorder-test.ts` | the play landing's reorder |

Three of them — `drag-stability`, `shelf-remove` and `group-create` — were missing from this
list while running in CI the whole time. A gate this file does not name is a gate nobody
re-runs by hand before claiming a change is safe.

## Working here

- **Commit small, push often**, and never leave a dirty tree behind.
- Work in your own `git worktree` — other agents share this checkout.
- Screenshots go in `__screenshots__/` (gitignored, scratch). Anything meant to survive a
  merge — a PR's before/after — is committed under `docs/images/` and linked by SHA-pinned
  raw URL.

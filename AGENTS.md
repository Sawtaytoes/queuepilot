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
  (a state class on an ancestor matches nothing on purpose), and five real findings were open
  on other pages when it was written.
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
PR**; the no-Plex browser gates (`pick-contract`, `narrow-scroll`, `routing`, `play-reorder`,
`pool-editor-keeps-blocked`) always run, which is why picker/layout/routing claims belong
there rather than in the gated block.

## Working here

- **Commit small, push often**, and never leave a dirty tree behind.
- Work in your own `git worktree` — other agents share this checkout.
- Screenshots go in `__screenshots__/` (gitignored, scratch). Anything meant to survive a
  merge — a PR's before/after — is committed under `docs/images/` and linked by SHA-pinned
  raw URL.

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

**People, plays and known-how do not change that — they are SCHEMA AND CODE here, DATA in
App-Configs.** The absorb gives this app a people table, a play log and per-person
"knows the rules / knows how to play" claims, which reads like the first household data the
repo has held. It is not: `groups.yaml` has had exactly this posture since groups shipped.
`server/src/groups.ts` is the identity layer and lives here; the file that says who is in the
household lives in `/config` and never enters the tree. The new tables inherit that split
unchanged — `store/schema.sql`, the migration, the queries and the views are public; a name,
a birth year, a Plex or Kavita account and a play row are not.

Two things follow, and both have a cheap way to get wrong:

- **A fixture is invented, never captured.** New people fixtures are **Ada, Grace and
  Linus**; the existing group and queue fixtures keep the cast they already have (Bob, Alice,
  Carol, Dave, Erin) and nothing needs renaming. What is banned is the shortcut of seeding a
  test from the live database because the real data was already there.
- **A screenshot is fixture data, and a PNG is opaque to every grep.** A before/after on a
  people or Tonight PR is captured against fixtures, not against the running household app.
  Nobody notices a real name in an image the way they notice one in a diff, and the repo's
  own images live under `docs/images/` forever.

## People

A **person** is a human. A **group** is a SAVED SET OF PEOPLE — a one-tap shortcut, not a
second kind of thing. The group keeps its wire id, its `/g/<id>` URL, its label and its
`sets:` claim list; what it gained in WP-3 is `group_people`
([decision](docs/decisions/2026-08-23-a-group-is-a-saved-set-of-people-and-the-identity-match-is-manual.md)).
Four things bite here, and three of them bite silently.

- **IDENTITY MATCH IS MANUAL, AND THE IMPORT IS GATED.** `store/migrate/people.ts` writes
  nothing until a mapping file in the config directory carries an explicit `confirmed: true`,
  which the generator (`server/src/tools/people-mapping.ts propose`) writes COMMENTED OUT. A
  confirmed file that fails validation also writes nothing — there is **no partial import**.
  Do not add a flag that skips the gate, and do not add name matching anywhere: every match
  the tool proposes is an EXACT, case-insensitive equality between a Board Game Picker display
  name (or its first word) and a group's label or one of its provider account names. The thing
  a fuzzy match corrupts is `player_known_games` — "can this person start this game without the
  rulebook" — which is a fact a person STATES, which a play may renew and must never invent,
  and which **appears on no screen attached to a name**. The play log it would also corrupt is
  two rows.
- **`group_people` has NO foreign key on `group_id`, and that is not an oversight.**
  `store/db/groups.ts writeDoc()` and the YAML importer both replace the whole `groups` table
  with `DELETE` + `INSERT` on EVERY write, so an `ON DELETE CASCADE` would empty every roster
  the next time anybody renamed a group. Do not "fix" it by adding the constraint.
  `orphanGroupIds()` reports the dangling ids; under `STORE_BACKEND=yaml` the `groups` table is
  empty by design, so every id looks orphaned there and the answer is a thing to look at, never
  a thing to delete. The FK to `people` stays — nothing ever replaces that table wholesale.
- **A group's own `accounts:` is not retired by a person's.** They are UNIONED. A group may
  stand for a provider account no household member holds, and a person may hold one no group
  listed; dropping either half loses sets out of a group with no error.
- **`max_weight: null` is "no ceiling stated", which is NOT 5.** The picker treats them
  differently. Same discipline as `pending.libraries`, where `[]` and absent are different
  answers.

The mapping file's format is documented by example at
`server/src/store/migrate/people-mapping.example.yaml` — the cast there is Ada, Grace and
Linus, and the real file lives in `/config` and never enters this repo. `e2e/people-test.ts`
is the gate: it boots twice over one fixture, once unconfirmed and once confirmed, and compares
the set ids, the group ids, the `requires_profile` membership and the `/g/<id>` status codes as
EXACT STRINGS. A count passes even when every id was replaced.

## A queue is people plus an activity

WP-5. A queue is **required people + optional people + one activity**. It is not a name. The
two product records live in a **sibling workspace repo, not on GitHub**, so they are named
rather than linked — a link from here would 404 for anyone reading this on the public repo:

- `agentic:docs/decisions/2026-08-25-a-queue-is-people-plus-an-activity.md` — the data model
- `agentic:docs/decisions/2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster.md`

This repo's own record is
[the play identity is the group's own account](docs/decisions/2026-08-25-a-group-plays-as-its-own-account-not-its-rosters-union.md).
Five things bite here.

- **THERE IS NO QUEUE NAME. Do not add one back.** Every movies queue is called "Movies"; the
  faces on the card are what tell two of them apart. The mockup drew a "Name it for me" / "I
  will name it" switch, a written-name preview and a revert control in all three of its
  options, and none of them ship. `sets.label` is still on disk and is still what a hand-edit
  writes — it is data WP-5 migrated **from**, and the only place it is still read is the
  shelf FILTER, so that typing "manga" keeps finding the queue somebody named that.
- **Type is the ACTIVITY, never a finer content list.** Four values — `watching`, `reading`,
  `video-games`, `board-games` — and Movies & Shows is ONE of them. Anime is not a type: two
  queues under `watching`, told apart by what is in them. A finer list was rejected on a
  specific failure, not on taste: *"the Older Kids queue would show up under both Shows and
  Shorts, but I don't think of it like that in my head."* The activity is DERIVED from the
  provider (`server/src/activity.ts`) and stored only when overridden, so migrating sixteen
  queues wrote no bytes. ⚠️ The derivation falls back to the provider **id** when the kind is
  blank, because `providerKindForSet()` answers `''` for a provider this build has not
  configured — without it, an unset `KAVITA_URL` moves every reading queue to Movies & Shows.
- **A GROUP MUST RESOLVE TO EXACTLY ONE PROVIDER PROFILE.** This is the constraint the whole
  group model protects. A queue keyed on a group signs into one Plex profile no matter which
  of its people turned up, or `requires_profile` has nothing deterministic to gate on. The
  group's **own** `accounts:` wins, because it does not vary with who is there; the roster
  union is the fallback and answers only when it is unanimous. Anything else is `ambiguous`
  and `PUT /api/sets/:id/people` **refuses** it with both candidates named. ⚠️ Do not merge
  this with `people.ts accountsForGroup()` — that one is MEMBERSHIP (every account a group
  stands for, unioned) and this one is IDENTITY (the one account a session signs in as). A
  group legitimately stands for three and plays as one.
- **The household's own rules arrive through the mapping file, never through this repo.**
  "At least one of them" is `group_membership.min_present` plus `group_people.role`, and both
  are written by the owner-confirmed file in `/config` — `min_present:` and
  `optional_people:` are the two keys it gained. `min_present` ABSENT means **all of the
  required roster**, which is what every group written before WP-5 meant; defaulting the
  absence to 1 would quietly loosen all of them at once.
- **The editor is a Charcuterie `Board`, and the tap fallback is the PRIMARY path.** Three
  lanes — Must be here / Nice to have / Everyone else — and "Everyone else" is the ABSENCE of
  a `queue_people` row, not a third role. The move handle is a button first and a drag second:
  pressing it opens a menu of the other trays, which is the only path that works from a
  tablet, from the keyboard, and in the Narrow View where the other trays are not on screen to
  drop onto. Do not add a drag-and-drop dependency and do not "improve" the handle into a
  drag-only affordance. `PersonFace` is the app's stand-in for an `Avatar`
  `@charcuterie/ui@3.10.0` does not have — a real library gap, and small enough to delete in
  one commit when it is filled.

`queue_people` and `group_people` carry **no foreign key on the parent**, and `queue_people`
cannot carry one at all — `member_id` names a row in `people` OR in `groups`. A person's
deletion therefore calls `forgetMember()` explicitly, and everything else is REPORTED by
`orphanQueueMembers()`. Under `STORE_BACKEND=yaml` those tables are empty by design, so every
member looks orphaned there and the answer is a thing to look at, never a thing to delete.

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
- **A BARE ELEMENT SELECTOR in `app.css` is the same override, aimed at every component at
  once.** `header`, `section`, `article` and `dialog` are landmarks a COMPONENT renders too:
  Charcuterie's `Card` puts its heading in a `<header>`, so `header { position: sticky; top: 0;
  z-index: 10 }` — written for the page header — reached every card on the page. Each
  board-game card's title stuck to the VIEWPORT top and painted over the real header, same
  z-index and later in the DOM, wearing the page header's background, padding and hairline.
  The page header is **`#apphead`** now and every one of its eleven rules is scoped to it. Two
  bare element rules are left on purpose and say so where they sit: `h3` (Tailwind preflight
  strips the UA heading size and three modal `<h3>`s had nothing left) and `button`
  (`font: inherit; cursor: pointer`). Neither sets position, paint or box. **A new one needs
  the same kind of note, or a scope.** `borrowed-class-audit.ts` cannot see this — it asks
  about CLASS names, and an element selector carries none.
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
  - **`LandingFilterBar`'s `#groupsedit` and `#peopleedit`** — the only ones of these
    blocked on the LIBRARY rather than settled. They are chip-shaped buttons in a row of
    chip-shaped `<Link>`s, and `BadgeButton` would migrate two of a dozen and split the row.
    It needs a `BadgeLink`, which does not exist yet. (`GroupBar` was this file's name for
    that component until 2026-08-26.)

  Everything pill-shaped and pressable is a **`BadgeButton`** (`@charcuterie/ui@3.10.0`),
  built for this app's setting tags, the outline pencil Edit pill, two start chips and a
  pool's Exclude. It shares `Badge`'s paint through one hook upstream, so a tag you can
  press and a tag you cannot are now the same pill; they were different sizes before.
  **✕ and ✓ share one trailing stack** (✕ on top); Edit sits with the labels, not next to ✕
  ([decision](docs/decisions/2026-08-25-checkmark-under-x-edit-by-the-labels.md)).
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

## The store

**`/config/queuepilot.sqlite` is the book of record.** Sets, queues, entries, groups, pending
and the lead cooldowns are ROWS as of WP-2
([storage](docs/decisions/2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived.md),
[driver](docs/decisions/2026-08-23-the-data-layer-is-node-sqlite-not-better-sqlite3.md),
[the fold](docs/decisions/2026-08-23-promote-sqlite-folds-into-the-book-of-record.md)). Six
things bite here and each has already cost something:

- **The derived cache validates on Plex's `updatedAt`, NOT on a clock — do not "adopt" a TTL
  over it.** `@charcuterie/server/http` (0.4.0) offers `createHttpCache` + `createThrottle`,
  and four other apps in the fleet are candidates. This one is **partial at best**: the two
  tables that cache a Plex read — `leaves` and `collection_children` — prove a row current
  with `LeavesValidator` / `CollectionValidator` — an identity test on `updatedAt` and `viewedLeafCount`, with `?? -1`
  so an absent field fails instead of matching a 0. That is a stronger freshness signal than
  any lifetime, because Plex tells us the item did not change. The library has **no validator
  hook**, so adopting the lifetime policy here would trade a correct answer for a timer. Wait
  for the hook. The smaller tables could adopt today, which is churn for very little.
  Background and the measured numbers from the one app that did adopt:
  `agentic/docs/runbooks/charcuterie-server-http-cache-adoption.md`.
- **`/config/cache.sqlite` is a DIFFERENT FILE and stays deletable.** Two files, never one.
  Merging them makes the deletable file undeletable — a schema bump would delete the
  household's queues without asking. `server/src/cache.ts` is untouched by WP-2 and should stay
  that way. `/config/promote.sqlite` no longer exists; do not reintroduce a third durable file.
- **A wire id is the primary key TEXT and is migrated verbatim.** `sets.id`, `queues.set_id`
  and `groups.id` are what an NFC card carries and what Home Assistant puts in
  `{"set": "<id>"}`. A surrogate INTEGER key would put a translation table between a piece of
  cardboard and the queue it plays. Never rename, trim, case-fold or re-slug one, and prove a
  migration by asserting the EXACT strings — a count of twenty passes even if all twenty were
  replaced.
- **YAML is a bridge for one release.** `STORE_BACKEND=sqlite` (default) reads rows;
  `STORE_BACKEND=yaml` is the rollback and is WP-1's implementation, untouched.
  `STORE_YAML_MIRROR` (default on) is what makes that rollback real — the SQLite store writes
  the four files on every mutation. When the mirror goes, so does the rollback, `sse.ts`'s
  watcher and the SMB hand-edit path.
- **A row keeps its whole mapping as JSON in `data`; the queryable columns are
  `GENERATED ALWAYS … VIRTUAL` over it.** They are real columns — index them, filter on them —
  and they cannot drift from the payload. Do NOT add a hand-maintained duplicate column, and do
  not promote a field into a stored column until its shape is settled (that is WP-3's and
  WP-5's job). ⚠️ `PRAGMA table_info` **omits** a generated column; it is `table_xinfo` that
  lists them, and reading the wrong one makes `addMissingColumns()` re-add every generated
  column and throw `duplicate column name` on the second boot.
- **Every write goes through `prepareChecked`.** node:sqlite binds NULL for a named parameter
  the caller FORGOT, where better-sqlite3 throws (WP-4a driver difference #6). An UNKNOWN key
  still throws, so a typo is caught; an omission is silent data loss. Do not call
  `db.prepare(...)` directly for a write under `store/db/`.
- **`store/schema.sql` is the reviewable artifact and `schema.generated.ts` is its compiled
  twin.** Run `node server/scripts/generate-schema.mjs` after every schema edit;
  `store/schema.test.ts` fails when it is stale. The production image ships only
  `server/dist/index.js`, so a schema read off disk at boot works everywhere except the
  container.

Undo/redo still works and did not need a redesign: `readRawSnapshot()` serializes the store's
own rows to their YAML projection, so `history.ts` is unchanged — and the projection is
**byte-identical** to the file it came from, measured on the live 309-line `sets.yaml` and
782-line `queues.yaml`. That is what the `presentation` column on each row buys: a comment
attached to a key inside a mapping, a blank line between two queues, a hand-typed
`- {title: "X"}` still flow, a quote mark. **So the cutover reformats nothing.** If you add a
field to a row and the YAML starts churning on save, that column is where to look.

## The collection

Board Game Picker's fifteen tables absorbed into the book of record in WP-4b. **Twelve of them
are here under a `board_game_` prefix; `players`, `groups` and `group_players` are not** — they
merged into `people` / `groups` / `group_people` rather than arriving as a second identity
system. There is exactly one people table and one groups table, and there is no
`STORE_BACKEND=yaml` half of this: the absorb skips that backend entirely.

Same public/private split as everywhere else in this file. The schema, the algorithm and the
queries are here; the collection, the rulings and the play log are in App-Configs. Five things
bite, and four of them bite silently.

- **The grouping rules are ROWS, not source**
  ([decision](docs/decisions/2026-08-23-the-collections-grouping-rules-are-rows-not-source.md)).
  The absorbed app kept a hand-curated table of the owner's rulings about his own shelf inside
  `import/grouping.ts`. They are answers about one household, so they are data: they seed from
  `<config>/board-game-grouping-seed.yaml` and are edited from a screen after that. The shape
  is documented by `server/src/store/migrate/board-game-grouping-seed.example.yaml`, whose
  titles are invented. **Do not vendor the real table into this repo**, and do not add a
  `reason` column — each ruling has a dated decision record in the private workspace repo, and
  a column would be a second, worse copy of the argument.
- **A `prefix` is a LITERAL and the store never compiles a pattern out of a text column.** The
  seed reader REFUSES a prefix carrying regular-expression punctuation, because a rule that
  looks like a pattern is a rule somebody expected to be executed. The match is a word boundary
  so a one-word rule does not swallow a longer word that starts the same way.
- **`is_excluded_source` is the column the whole migration was shaped around.** `'owner'` means
  a human took the title off the shelf; `'sync'` means an upstream refresh removed it. A sync
  may take back its own removal and must never take back the owner's. It is **present in the
  live database and absent from the source repo's `schema.sql`**, so the copy was built from
  `PRAGMA table_xinfo` rather than from the file — and every table was, because the class of
  bug matters more than the one instance. Losing it merges 22 hand-excluded titles with 116
  sync-removed ones and the next sync re-offers all 22.
- **`board_game_known_how` and `board_game_play_people` hold the SOURCE app's player ids until
  the gated people import re-keys them**, and that is deliberate. Neither has a foreign key,
  for the reason `group_people.group_id` has none: a constraint would refuse every row until
  the gate opens, turning "not yet re-keyed" into "lost". `unresolvedPersonIds()` reports them,
  the way `orphanGroupIds()` does — a thing to look at, never a thing to delete. Absorb-first
  and confirm-first both converge, because the absorb also resolves through `people.source_id`.
  A known-how row is the one that must not be mis-attributed: it is a claim a person STATES,
  which a play may renew and must never invent, and it **appears on no screen attached to a
  name**, so a wrong one is never noticed.
- **A play with NOBODY at the table is normal, and the migration carries it across as it found
  it.** Every play in the live collection arrived through the anonymous landing — the one
  another app hands you when you are already standing at a table — so `board_game_play_people`
  is EMPTY while `board_game_plays` is not. **Do not invent a participant row to make the data
  look consistent, and never back-fill one from the roster, the known-how table or the previous
  play.** A play may RENEW a known-how claim and must never CREATE one; a claim on the wrong
  person shows up beside no name and is therefore never caught. The empty table is the correct
  result, and `boardgames.test.ts` pins it as one.
- **✅ THERE IS ONE BOOK OF RECORD, AND IT IS THIS ONE. The absorb is a ONE-WAY DOOR (WP-4d).**
  It used to REPLACE all twelve tables whenever the source file's fingerprint changed, which was
  safe only while nothing here wrote them. WP-4d landed the writers, so
  `store_meta('boardgames','retired_at')` latches at the end of the boot hook once `board_games`
  holds rows, `importBoardGames()` then refuses — **including under `force`** — and
  `board-game-picker-import.sqlite` is renamed to `.retired-<timestamp>`. Do not add a flag that
  re-opens it. Getting back is two manual steps with the app stopped: rename the file back AND
  delete the meta row.
  ([decision](docs/decisions/2026-08-25-the-collection-absorb-is-a-one-way-door-and-the-source-file-is-retired.md))
- **The grouping SEED is NOT retired with the source file, and the two are not the same kind of
  thing.** The source file carried rows that REPLACED ours; every seed insert is
  `ON CONFLICT DO NOTHING` and can only ADD. `seedGroupingRules()` keeps reading
  `board-game-grouping-seed.yaml` on every start, gated on its own fingerprint, because it is the
  only way to add a grouping rule until the editing screen exists.
- **⚠️ RETIRING THE SOURCE FILE IS NOT RETIRING THE APP.** The sibling app, its host, its
  Homepage tile and its repo are all still running. That transfer is WP-10 and it is behind an
  explicit owner gate. Nothing in this repo may redirect, archive or stop it.
- **THE MQTT TOPICS ARE THE SIBLING APP'S AND DID NOT MOVE.** `board-game-picker/cmd/sync` in,
  `board-game-picker/resp/sync` out, `board-game-picker/status` retained. Home Assistant
  publishes that tick on a schedule and templates `isOk` off that response to decide whether to
  notify, so the handler moved and the contract did not. The base reads wrong and is right;
  changing it means editing the HA package in the same change, and that is WP-10's, never a
  tidy-up. `e2e/board-game-sync-mqtt-test.ts` gates it against a real broker, because every part
  of that contract is a string or a key name that nothing else in this repo reads — rename one
  and typecheck, the unit tests, the build and the startup log all stay happy while the nightly
  silently stops.
- **HA owns the schedule and there is no TrueNAS cron. Do not add one, not even as a side
  effect.**
- **The writers are `store/db/boardgameImport.ts`, `boardgameSync.ts` and `boardgameEnrich.ts`,
  and they run as four MQTT-triggered jobs.** `boardgames/jobs/` holds them —
  `sync-bgg`, `enrich`, `link-rulebooks`, `link-videos`, in that order, and deliberately NOT
  `&&`-chained so an upstream outage does not skip the night's rulebook links. Three judgements
  in them are load-bearing: `sync-bgg` **refuses an empty collection** rather than marking every
  title removed; `link-videos` writes an **explicit empty list** for a title with no teach video,
  which is what removes a dead link; and `enrich` skips edition matching when the title's own
  upstream id is not any owned box's, because a family listing is not a box and matching against
  it picks art for a different game. A terminal runs one step through
  `server/src/tools/board-game-sync.ts`.
- **The provider is fully in process — the write came home in WP-4d.** WP-4e swapped
  `providers/board-game-picker-client.ts` onto `store/db/boardgames.ts`;
  `providers/board-game-picker.ts` did not change, which is the proof the seam was in the right
  place. `logPlay()` was the one call left on the wire and is not any more, because the bullet
  above stopped being true; `boardGamesRepositoryClient` builds no HTTP client at all.
  ⚠️ **A play logged from a TILE records `personIds: []`, stated rather than defaulted, and that
  is correct** — whoever pressed it is not filling in a form, and a play may RENEW a known-how
  claim but must never INVENT one. The screen that asks who was at the table is the Collection
  screen, through `POST /api/board-games/plays`. Do not "improve" the tile path by guessing the
  roster. Covers come off `board-game-images/`, whose directory is `imagesDirectory()` — ONE
  definition, shared by the writer and all three readers, because the enrichment made
  `BOARD_GAME_IMAGES_PATH` load-bearing. `BOARD_GAME_TRANSPORT=http` puts the reads AND the write
  back on the wire the way `STORE_BACKEND=yaml` puts the store back on the files, and keeping the
  HTTP client runnable is what lets `e2e/board-game-transport-parity-test.ts` compare the two on
  every CI run rather than once
  ([decision](docs/decisions/2026-08-25-the-board-game-provider-reads-rows-and-still-posts-a-play-over-http.md)).

Staging the source file is `server/src/tools/stage-board-game-collection.ts`, dry run by
default. **Use it rather than `cp`.** The sibling app runs in WAL mode, so copying the
`.sqlite` alone leaves whatever happened most recently in a `-wal` beside it and produces a
file that opens, queries and is quietly out of date — and plays and known-how are exactly the
tables that get the newest writes. The tool copies the three files together, checkpoints the
COPY (never the live file, which another process owns), leaves the copy out of WAL mode so the
artifact is one file, and prints the row count of all fifteen tables on both sides. **A
disagreement means the copy was torn and nothing is staged.**

⚠️ **The staging tool is SPENT on the live system, and that is not a bug.** It writes
`board-game-picker-import.sqlite`, which the absorb no longer reads once `retired_at` is
latched — so a stage that "works" now changes nothing at all. It is still the right tool for a
FRESH container that has never held a collection, and it is still how the one-time cutover was
done. On a store that already holds the collection, staging again is a no-op and re-absorbing it
is the data loss the latch exists to prevent.

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

## The two lanes inside a Picks queue

A Picks queue is ONE membership list with a **Priority queue** and a **Random pool**
([decision](docs/decisions/2026-08-23-kind-is-picks-or-rules.md) §2/§4, implemented
2026-08-26). The Priority lane plays first, in file order; the pool fills the rest of the
sitting through the existing shuffle/weight path.

- **`add_as` on the SET is the default lane; `placement` on the ENTRY overrides it.**
  `placement` is SPARSE — a queue nobody has promoted anything in stores none at all, and is
  entirely one lane. **That is the property to protect on any edit to `nextQueue`'s
  assembly**: single-lane is not a special case in there, it is the old code path with a
  filter that matches everything. An Ordered Queue is `add_as: priority`, so every one of its
  entries is Priority *by inheritance*.
- **`lead` defaults by HOW the entry got into the lane** — inherited ⇒ `always`, promoted ⇒
  `once`. Read the ADR's "sparse → once" literally and every ordered queue reshuffles its own
  head on the second sitting of the day
  ([decision](docs/decisions/2026-08-26-the-lead-window-belongs-to-a-promote-not-to-an-ordered-queue.md)).
  `kind.normalizeLead()` is the one place that decides it.
- **The engine never touches the lead ledger.** `nextQueue` takes an injected
  `resolve.LeadGate` and REPORTS `led` / `suppressed`; `session.startSession` stamps the
  window after the handoff succeeds, so a lineup that never plays keeps its promise
  ([decision](docs/decisions/2026-08-26-the-lead-window-is-stamped-when-playback-starts.md)).
  Keep `engine/` free of `promote.ts` — the duration parser lives in `leadWindow.ts` for
  exactly that reason, and `promote.ts` re-exports it.
- **In-progress still outranks a promote**, and only out of the pool. An ordered queue has
  never hoisted anything and still does not.
- Gate: `e2e/priority-lane-test.ts`. Half of it is not about the feature — cases 1, 2, 5 and
  7 pin that an un-promoted queue comes out exactly as it did before the lanes existed.

### The page is two lanes, and `#grid` is the container

`QueueView` draws a **Priority queue** above a **Random pool**
([decision](docs/decisions/2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote.md)).
Four things to know before touching it:

- **`#grid` is the WRAPPER, not a `<ul>`.** The lanes are `#grid-priority` and `#grid-pool`,
  both `ul.grid[data-lane]`. `#grid li.tile` therefore still means "every tile in this
  queue", which is what a dozen harnesses and `body.gdrag #grid li.tile` (the drag settle
  transition) have always meant by it. Scope that id to one lane and the other lane's tiles
  stop gliding during a promote.
- **`data-lane` is load-bearing, not a style hook.** `useGridDrag` finds the lanes with it
  and reads the landed lane back off it at pointerup.
- **The empty lane renders an `li.dropstrip`.** It must render something with height or the
  first promote has nothing to aim at.
- **The pool saves no order.** A drag that starts and ends in `random` writes nothing —
  deliberate, because the pool is shuffled at playback.

Gate: `e2e/lane-drag-test.ts` (spawns its own server; browser, no Plex). ⚠️ **Run it with
`PLEX_TOKEN=` blank.** It drives the DEGRADED path on purpose, and a workspace shell that has
sourced the root `.env` gives its server a live Plex — the tiles then resolve, the layout
moves, and every drag in the file lands somewhere other than where it aimed. That reads as
six hard failures and is an environment difference, not a regression. `splitLanes` in
`state/queueView.ts` is the pure half and has unit tests.

### The Picks PAGE lists both lanes' queues, in one strip each

**Which screen a queue is on comes from `source`, never from `add_as`**
([decision](docs/decisions/2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to.md)).
`/queues` (**Picks**) lists every `source: queue` set; `/channels` (**Rules**) lists every
`source: rotation` set. Nothing appears on both. The two `add_as` selectors that used to
split them — `queueIds` and `channelSetIds` — are **gone**; there is one, `curatedIds`, and a
new filter on `add_as` in a screen list is a regression, not a feature.

- **A shelf is ONE `.strip` with two RUNS in it**, never two `<ul>`s like `/q/<id>`.
  `useHomeDrags` hit-tests one `.strip` per shelf and rebuilds the queue's file order from
  `strip.querySelectorAll("li.tile")`, so a second list would PATCH an order carrying half
  the keys. The divider between the runs is an `li.lanesplit` — deliberately not a `li.tile`,
  so every one of those queries steps over it.
- **A shelf drag REORDERS; the tile's arrow PROMOTES.** There is no drag-across-the-divider
  here (see above), so a tile dropped in the other run returns to its own lane on the next
  render. `onLane` is offered on every shelf tile because it is the only promote on this page.
- **The heading says the lane in words** — `3 priority · 9 pool`, or `priority queue` /
  `random pool` when a queue is entirely one. The one-lane clause is the contract, not
  decoration: a divider needs two runs to exist between, so without it an all-pooled queue
  and an ordered one are the same row of posters.
- ⚠️ **`/api/shelves` carries `placement`, and must keep carrying it.** The skeleton exists to
  paint at final geometry before `/api/queues` resolves against Plex; the geometry now
  includes the lane split. Drop the field and every entry falls into the set's default lane
  on first paint, so the divider and the tiles either side of it move when the resolved
  payload lands — the exact shift that endpoint was added to prevent. It costs one property
  read and no Plex call. Gate: `e2e/api-v2-test.ts`, always-on.

### A rules row names its ACCOUNT, and the gate is the LABEL

*"Shows" and "Shows & Shorts" are the same words until you know one is Younger Kids and the
other Older Kids.* `channelAccountLabel` is the one place that decides it — the rules picker's
chips, the Play landing card's meta line, and nothing else needs a fourth copy.

⚠️ **Do not gate it on `has_explicit_profiles`.** `PlayView` did, on the belief that a legacy
flat set's SYNTHESIZED binding reports the channel's own label. It does not — the synthesized
binding carries the real `plex_user`, and `/api/sets` says so:
`younger | Shows & Shorts | explicit: false | profiles: ["Younger Kids"]`. That belief reads as
true against the live `sets.yaml` only because those two pools are named after the accounts
they play as. The gate is a comparison with the row's own label, which is the check the flag
was reaching for.

**"Plays as `<account>`" is gone from the Rules header** — the picker beside it says the
account on every row, so the sentence said it twice. The 2026-08-17 rule stands: the account
is a fact, not a choice, and must never wear a chevron of its own.

**A chip on a picker TRIGGER shrinks; a chip on a list ROW does not.** `.optionbadge` is
`flex: none` for a row (as wide as the panel) and `flex: 0 1 auto` on `.qppicker > span >`,
and the option's text lives in `.optionlabel` so it can ellipsise beside it — a bare text node
next to a `Badge` becomes an anonymous flex item, which takes no `min-width: 0`. Skip either
half and the Rules header scrolls sideways at 390px. `narrow-scroll-test` is the gate.

### A list of queues names its PEOPLE

A queue's displayed name is its ACTIVITY
([decision](docs/decisions/2026-08-25-a-queue-is-people-plus-an-activity.md)), so any control
that lists queues by name reads "Movies & Shows", "Movies & Shows 2", "Movies & Shows 3" and
names nothing. Shelves and landing cards answer that with `PeopleRow`; a **menu row or a
picker option** cannot hold 26px faces, so it gets `queuePeopleLabel` instead — as a
`SelectListbox` option `badge`, or as `<QueuePeopleBadge>` inside a `MenuItem`'s `label`.
Three call sites today: both Add-to menus (`Toolbar`, `PendingView`) and the selection bar's
Move-to picker. **Add a fourth list of queues and it gets the chip too** — fixing one of three
is how a rule becomes folklore. Required members only, three names then `+n`, `Anybody` for a
queue nobody has filed.

### The tile menu, and the long press that opens it

Two rules, both settled 2026-08-26 after the owner met them on a tablet
([menu](docs/decisions/2026-08-26-the-tile-menu-carries-what-the-card-cannot.md),
[long press](docs/decisions/2026-08-26-a-long-press-is-the-menu-or-the-drag-never-both.md)):

- **The menu carries only what the CARD cannot.** Play this next, the two lane moves, the
  manual start point, Skip. **Never Remove** — every editable grid puts a ✕ on the tile, so
  a Remove row repeats a control six pixels away. The test for a new row is not "is this
  useful", it is "can the card already do it". An entry with no rows opens **no menu**:
  `openTileMenu` no-ops (`hasTileMenuActions`) rather than painting an empty box.
- **A long press is the menu OR the drag, never both.** The 200 ms hold timer only ARMS the
  gesture; `beginDrag()` runs on the first move past the threshold. Move a `beginDrag()`
  back into that timer and the tile is picked up under a stationary finger, the browser's
  own long-press menu opens on top of it, and the card it came from is left empty. The
  grid's `contextmenu` handler **ends the press**, which is also what stops the `pointerup`
  behind it settling as a tap and opening the entry sheet under the menu.
- Two smaller rules in the same gesture: `onPointerDown` takes the **primary button only**
  (a right-click used to open a press whose `pointerup` opened the entry sheet), and
  `TileMenu` closes on a scroll that **moves the page**, not on the zero-delta `scroll`
  Chromium fires in the frame the menu opens.
- A promote from the menu, the selection bar **or the tile's arrow** lands at the **end** of
  its new lane (`state/queueView.orderAfterLaneMove`, unit-tested) — one function for all
  three, so they cannot drift. `moveEntryLane` is a toggle wrapper over `setEntryLane` and
  computes nothing; `promotedOrder` is deleted, and a second order helper is a regression.
- **Every lane change writes `placement` and THEN the order**, the demote included. The file
  is one sequence, so an entry that leaves the Priority queue has to leave the priority run of
  the file with it — and the next promote would re-sequence it anyway, since
  `orderAfterLaneMove` rebuilds priority-then-random from the placements it reads. The arrow
  used to skip the order on a demote, which is what let the two gates assert opposite things
  about one operation (decision
  `2026-08-27-a-lane-change-writes-the-order-too-because-the-file-is-one-sequence`).

Gate: `e2e/tile-menu-test.ts` (spawns its own server; browser, no Plex).

## Reading the log when a queue plays the wrong thing

`[lineup]` (every curated scan) names the lane split, the head, the first ten titles in
order, and anything a lead window held back. `[play]` names the keys sent, then **reads the
playQueue back** and WARNs when Plex leads with a different item or keeps fewer than it was
given ([decision](docs/decisions/2026-08-26-a-scan-logs-the-lineup-it-built.md)). Those two
groups exist to separate three failures that used to look identical in the log: a lineup
built wrong, a lineup Plex reordered, and something else already on screen. Both are
unconditional — a scan is a button press, and the report always arrives the morning after a
redeploy has thrown the evidence away.

## People on a queue

A queue's audience is three trays — **Must be here**, **Nice to have**, **Everyone else** —
stored in `queue_people` and drawn by `PeopleTrays`
([decision](docs/decisions/2026-08-25-a-queue-is-people-plus-an-activity.md)).

**Both kinds carry them.** A `source: rotation` pool (Rules) has the same trays a
`source: queue` queue (Picks) has, in the same component, written by the same endpoint —
`#dyn-people` in `DynModal` beside `#set-people` in `SetModal`
([decision](docs/decisions/2026-08-26-a-rules-queue-carries-people-too.md)). Three things
follow:

- **The server has no kind check and must not grow one.** `PUT /api/sets/:id/people` and
  `store/migrate/queuePeople.ts` have never consulted a set's kind; `e2e/queue-people-test.ts`
  gates a rotation pool through both so neither learns to.
- **The trays are EDIT ONLY, in both editors.** `queue_people` is keyed on the set id and a
  set being created has not got one. A new queue is created, then filed.
- **A pool's provider ACCOUNT is not its audience.** The account in the card's meta line is
  which Plex profile the Shield signs in as; the faces beside it are who the pool is for. Both
  belong on the card, and folding either into the other is what made the Rules pools
  unreachable from every people-shaped control in the app.
- **The move handle says "Move", and NEVER `≡`.** `≡` in this app means DRAG ME — the shelf
  grip, the card grip, `useHomeDrags`' own wording. The tray handle is a MENU BUTTON first
  (that is the keyboard, screen-reader and narrow-board path), which is why the library's
  default is the word. Passing `moveIcon` here taught the one gesture that cannot work, and
  the owner reported it as "how do I move these?"
  ([decision](docs/decisions/2026-08-27-the-tray-move-handle-says-move-it-does-not-wear-the-drag-glyph.md)).
- **A modal that holds the trays is `min(920px, 92vw)`, and that number is not a taste call.**
  The board picks three-lanes-across versus one-lane-plus-a-segmented-control from a CONTAINER
  query at `cq-lg` (48rem / 768px) on its own box. Below it there is ONE tray on screen and
  nowhere to drop, at any window width. `#setmodal` learned this on 2026-08-25; `#dynmodal`
  shipped trays on 2026-08-26 at 520px and had to learn it again. **A new modal that gains
  `PeopleTrays` gains this width in the same change.**

## A queue's name

**Optional.** A queue with a name is called that everywhere; a queue without one is called
after its **activity** — "Movies & Shows", numbered only when two nameless ones would read
identically — and the faces beside it say which one it is
([decision](docs/decisions/2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in.md)).
`queueTitle(set, number)` is the one function that answers this, and the Admin grid, the Picks
shelves and What to Watch/Play all call it.

Four traps, each of which has a comment at its site:

- **Read `has_explicit_label`, never `label`.** The registry makes `label` printable by
  falling back to the **id**, so a nameless queue's `label` is `movies_shows`. Trusting it
  puts a slug on the card, and it is why the flag exists at all (same shape as
  `has_explicit_profiles`).
- **The Name input seeds from the TYPED name only.** Seeding from `label` pre-fills a nameless
  queue's field with its id, and the next Save stores that slug as a name.
- **The id is still slugged at create, from the ACTIVITY when nothing is typed.** It is a WIRE
  ID an NFC card carries. It is NOT derived from the provider there — the body is a half-built
  set, and a wrong id is permanent in a way a wrong display is not.
- **Clearing a name DELETES the `label:` line**, never stores a blank. `PATCH /api/sets/:id`
  with `label: ""` is a legitimate edit; it used to be a 400.

Gate: `e2e/queue-name-test.ts`, 18 assertions, in CI.

## The Admin landing's filter

`/admin` filters by **people** and by **provider**, both in the QUERY STRING
(`?people=ada,grace&only=kavita`), and every chip is a real `<a href>` that keeps the other
filter as it changes its own
([decision](docs/decisions/2026-08-26-the-landing-filters-by-people-and-the-group-chips-go.md)).
Four things that look like leftovers and are not:

- **There is no group chip and no `/g/<id>`.** A group is still a real object with a real
  editor (`⚙ Edit groups`, same row) — it holds "at least one of the kids", it is what a
  Must-be-here tray points at, and it resolves the one provider profile a queue signs in as.
  It just is not a shelf label or an address any more. `/g/<id>` redirects to `/admin`.
- **`membersMatchPeople` has TWO callers and must keep exactly one implementation.** This
  page and What to Watch/Play ask the same question of the same rows; a second copy drifts,
  and the way it drifts is that one screen offers a queue the other hides. It mirrors
  `server/src/queuePeople.ts queueMatchesSelection` statement for statement, and
  `tonight-routing-test.ts` §5 is what stops THAT pair drifting.
- **Two empties, both load-bearing.** Nobody ticked is no filter at all; a queue nobody is
  filed on is never filtered out. Either branch removed makes most of the app unreachable
  from one tick.
- **A chip's count is "with this person INCLUDED", not "what you get if you click".** The
  two agree on an unticked chip and disagree on a ticked one, because clicking a ticked chip
  REMOVES that person — which put the unfiltered total on the one chip doing the filtering.

Nothing about the landing is remembered in `localStorage`. `state/group.ts` did remember the
last group, because a group was a PLACE; a remembered filter is a search field that comes
back pre-typed.

## Skipping one item

A **queue** set (`source: queue` — both pool kinds) carries `skipped:` in `sets.yaml`: a flat
list of LEAF ids it never plays. It is the curated twin of a filtered pool's `blocklist`
([decision](docs/decisions/2026-08-22-a-curated-queue-skips-items-the-way-a-filtered-pool-blocks-them.md)).
Four things to know before touching it:

- **It addresses the LEAF, never the member.** One episode of a show entry; one child of a
  `{collection: X}` entry. A MOVIE entry is its own leaf and is deliberately NOT skippable —
  Remove is its answer, and `resolveMember`'s movie branch says so at the top. Do not
  "finish the feature" by making it skippable.
- **A skipped item COUNTS as dealt with, so the entry can complete.** Watch a show's first
  nine episodes and skip the tenth and the show is over; the entry is marked done. The rule is
  "nothing left", not "something was skipped" — an entry with E3/E4 still to play is not
  completed by skipping E2. The first cut of this feature carved an exception here and it was
  **reversed the next day**
  ([decision](docs/decisions/2026-08-23-a-skipped-item-counts-as-dealt-with-so-the-entry-can-complete.md)):
  it protected an undo that `nextQueue`'s stale-done revival already provided, and in exchange
  created an entry that could never complete and never leave the queue. Do not reintroduce it.
  ⚠️ On a queue with `remove_completed_after` the line IS deleted once the window passes, and
  Restore then has nothing to bring back — the same thing that TTL already means for every
  other completion there. `e2e/skipped-items-test.ts` gates the rule, the control and the
  Restore round trip.
- **The filter runs BEFORE `applyBatch`**, so an `episodes: 2` entry with E2 skipped queues
  E3 + E4 rather than E3 alone. Also gated.
- **The keys are the PROVIDER's**, not universally Plex ratingKeys — safe only because a queue
  draws from exactly one provider. This is why `GET /api/sets/:id/skipped` does not Plex-resolve
  a PULL set's keys: the id spaces overlap, and that lookup would sometimes succeed and name a
  completely unrelated film. Plex and Kavita both honour the list; board games, Steam and MiSTer
  have no shared leaf id, so their tiles carry no `nextEp.ratingKey` and the menu row is
  not offered.

`PATCH /api/sets/:id` rejects `skipped` on a rotation channel: `blocklist` is the same feature
there, and one set never carries two exclude lists.

## The page loads from CACHE, and phase 3 re-reads the providers

**`GET /api/queues` makes no provider call.** Every entry resolves out of three tables —
`item_meta`, `section_collections`, `kavita_item` — and they have **no TTL**: a row is served
whatever its age. The browser is what re-reads. `store.load()` ends with `revalidate()`, which
asks for **`/api/queues?fresh=1`** and swaps the answer in, with a thin indeterminate
`ProgressBar` on the header's bottom edge for as long as it runs
([decision](docs/decisions/2026-08-26-a-provider-read-is-cached-and-the-page-revalidates-after-it-paints.md)).

Five things to know before touching any of it:

- **A new provider read belongs in a cache.** A warm page load was **566 calls and 5.1 s**, and
  339 of them were one `/library/metadata/<rk>` per queue entry. It is now about 0.1 s. Adding
  an uncached per-entry read puts it straight back.
- **`isFresh` rides on `AccountScope` and on `ProviderTileOpts`**, so it reaches the four levels
  between the route and the provider without a new parameter at each one. Only `?fresh=1` sets
  it.
- **The revalidation pass must never 304.** The ETag is two file revisions plus the cache
  generation, and none of them move when a PROVIDER's data changes — which is the whole thing
  the pass exists to notice. The `if-none-match` short-circuit is skipped when `isFresh`.
- ⚠️ **Do NOT skip the leaves validator on the cached read.** It is one Plex call per show and
  it looks like free money. It was tried on 2026-08-26 and reverted within the hour: the
  browser's first paint and the ENGINE building a lineup read through `allLeaves` with the same
  flag, and there a stale episode is queued and PLAYED rather than merely displayed
  ([2026-08-07](docs/decisions/2026-08-07-leaves-cache-revalidates-on-read.md) still stands).
  `e2e/leaves-revalidate-test.ts` fails if you do.
- **`_memo` in `providers/kavita.ts` is load-bearing.** A `series-detail` DTO is the whole
  series; reading 188 of them back out of SQLite cost **17 s of cumulative blocking time**,
  while the walk they feed costs 2 ms. `DatabaseSync` blocks the event loop, so those reads
  never overlap. Delete the memo and the page goes back to 2 s.

**Measure with `plexGet`, never with `globalThis.fetch`.** `plex.ts` uses `undici.request`, so
a `fetch` wrapper reports **zero** Plex traffic on a page making 377 Plex calls. That false
reading is what sent the first pass at this after a CPU cost that did not exist.
`e2e/provider-cache-test.ts` gates the behaviour by COUNTING calls; a wall-clock assertion in
CI would only be a flake.

## A collection's ORDER is Plex's, and a re-order has no signal

**The order is `collectionSort`, read straight off `/library/collections/<rk>/children`. The
app does not sort it and does not let you re-order it**
([decision](docs/decisions/2026-08-26-a-collection-entry-plays-in-plexs-order-and-a-local-override-is-deferred.md)).
A per-entry `order:` override is **deferred at low priority** — do not build it as part of
another task, and do not "fix" a collection by sorting its members here.

⚠️ **A re-order is the one library change nothing reports, so it needs an explicit re-read.**
All three freshness tests miss it, and each one looks like it should work until you check:

- the `(updatedAt, childCount)` validator is **dead code** for this table — `/children` answers
  with a container carrying `size` and NOTHING else, so the stored `updated_at` is always `0`
  and can never equal a real one;
- the collection's OWN `updatedAt` does not move for a re-order (read live: over a year older
  than the change);
- `childCount` is identical on both sides, because a re-order adds and removes nothing.

That leaves the 24 h TTL, and a clock misses it too: the cached copy is not old, it is wrong.
So **opening "What plays" re-reads Plex** — cached rows paint first, `?fresh=1` corrects them,
and a **Checking Plex… / Updated from Plex** chip says so, because a list that silently
re-orders itself under somebody mid-edit is worse than a slow one. A changed order also bumps
the cache generation, since the tile names the next member BY POSITION
([decision](docs/decisions/2026-08-26-a-collection-re-order-is-invisible-so-the-panel-re-reads.md)).
`cache.dropCollectionChildren` is the `dropLeaves` twin and is the only thing that can bust
this table. `e2e/collection-reorder-test.ts` gates it.

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
server/node_modules/.bin/tsx e2e/priority-lane-test.ts   # the Priority queue / Random pool lanes
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  server/node_modules/.bin/tsx e2e/lane-drag-test.ts     # dragging across the lane divider
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  server/node_modules/.bin/tsx e2e/tile-menu-test.ts     # the tile menu + the long press
server/node_modules/.bin/tsx e2e/pick-contract-test.ts   # the picker contract
server/node_modules/.bin/tsx e2e/skipped-items-test.ts   # the curated skip rule
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  server/node_modules/.bin/tsx e2e/tile-lane-test.ts     # the tile's three controls
server/node_modules/.bin/tsx e2e/collection-reorder-test.ts  # a re-ordered collection reaches the panel
server/node_modules/.bin/tsx e2e/provider-cache-test.ts  # a warm page makes no provider call
server/node_modules/.bin/tsx e2e/store-backend-parity-test.ts  # both store backends agree
server/node_modules/.bin/tsx e2e/people-test.ts          # the people confirmation gate
server/node_modules/.bin/tsx e2e/tonight-routing-test.ts  # the activity → backend map
server/node_modules/.bin/tsx e2e/board-game-absorb-test.ts  # the collection absorb
server/node_modules/.bin/tsx e2e/queue-people-test.ts    # a queue is people plus an activity
server/node_modules/.bin/tsx e2e/roster-editor-test.ts   # add / rename / remove a person
server/node_modules/.bin/tsx e2e/board-game-transport-parity-test.ts  # both board-game transports agree
server/node_modules/.bin/tsx e2e/board-game-sync-mqtt-test.ts  # the nightly's MQTT topic contract
server/node_modules/.bin/tsx e2e/nfc-wire-contract-test.ts  # the cards' set ids, over a real broker
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  server/node_modules/.bin/tsx e2e/tonight-preset-test.ts  # a preset card lands on the result card
```

The three browser gates that need a SHARED SERVER (`narrow-scroll`, `drag-stability`,
`routing`) start their own in `ci.yml` with their own `WEB_PORT` and fixture paths. Run them by
hand the same way — a bare `tsx e2e/narrow-scroll-test.ts` answers `ERR_CONNECTION_REFUSED`,
which reads exactly like a regression and is not one. Start the server with `setsid` and stop it
with `kill -- -$SRV`; see "Working here" for why `kill $SRV` does not.

⚠️ **`yarn workspace queuepilot-web run build` is not optional before the offline e2e gates.**
Without `web/dist` the server has no SPA fallback, so every deep link answers **404** — and a
gate that compares a status code before against after passes on two 404s while proving nothing.
`people-test.ts` pins the 200 and fails loudly; `board-game-absorb-test.ts` now pins it too, for
exactly this reason.

The Playwright browser suites are gated on the `PLEX_TOKEN` secret and are **skipped on every
PR**; the no-Plex browser gates always run, which is why picker/layout/routing claims belong
there rather than in the gated block. All fourteen of them, in the order `ci.yml` runs them:

| Gate | What it pins |
| --- | --- |
| `narrow-scroll-test.ts` | the Narrow View never scrolls horizontally |
| `drag-stability-test.ts` | a drag's PATH, not its result — reversals, re-inserts, style writes |
| `lane-drag-test.ts` | dragging across the lane divider — the promote and the demote |
| `tile-lane-test.ts` | the tile's three controls: the select mark PAINTS when checked, and the lane button promotes / demotes |
| `routing-test.ts` | the client router and the server's SPA fallback, together |
| `pick-contract-test.ts` | the `pick.ts` ↔ `SelectListbox` contract |
| `pool-editor-keeps-blocked-test.ts` | a pool edit does not drop Blocked |
| `collection-reorder-test.ts` | a collection RE-ORDERED in Plex reaches the "What plays" panel |
| `provider-cache-test.ts` | a warm `/api/queues` makes no provider call, and `?fresh=1` is what re-reads |
| `shelf-remove-test.ts` | the shelf's remove ✕ |
| `play-reorder-test.ts` | the play landing's reorder |
| `tonight-test.ts` | the Tonight surface — the settled tiles, defaults and steps |
| `board-game-play-test.ts` | a logged play records WHO played, never invents a known-how claim, and no card title paints over the page header |

Three of them — `drag-stability`, `lane-drag` and `shelf-remove` — were missing from this
list while running in CI the whole time. A gate this file does not name is a gate nobody
re-runs by hand before claiming a change is safe.

`group-create-test.ts` is **deleted**, not forgotten. It pinned "a new queue joins the group
on screen", and there is no group on screen any more — the landing filters by PEOPLE and a
group is not an address ([decision](docs/decisions/2026-08-26-the-landing-filters-by-people-and-the-group-chips-go.md)).
`groups-test.ts` still pins the WRITE it sat beside, so what is gone with it is a browser
assertion about a control that no longer exists.

> ### The browser gates will not launch in an agent sandbox — that is the container
>
> Every gate in the table above launches a real chromium through `e2e/playwright.ts`. The
> agent container ships browsers for its **own** globally-installed Playwright at a root-owned
> `/opt/pw-browsers` and points `PLAYWRIGHT_BROWSERS_PATH` there. `e2e/package.json` pins its
> own Playwright, which wants a **different** revision, and that directory is not writable by
> the agent user. The launch dies naming a build number that is not there.
>
> Install this repo's build somewhere writable and point the run at it:
>
> ```sh
> PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers yarn workspace queuepilot-e2e run playwright install chromium
> PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers server/node_modules/.bin/tsx e2e/narrow-scroll-test.ts
> ```
>
> Full `chromium`, not `chromium-headless-shell` — these harnesses drive a real browser.
> `--dry-run` on the install prints the exact revision and path without downloading.
>
> ⚠️ **Do not run `yarn install-playwright-browser` in the container.** It passes
> `--with-deps`, which needs root to apt-install system libraries, and the agent has no
> `sudo` — it stalls rather than failing. That is the same `--with-deps` call that stalled CI
> for six hours on 2026-08-19. It is for CI; run `playwright install` directly, as above.
>
> ⚠️ **Never fix this by changing the repo.** Bumping `playwright` in `e2e/package.json` to
> match the container changes what this repo tests against for a reason that has nothing to do
> with the product — and that pin exists precisely so the version stops moving on its own.
>
> ⚠️ **Never report a browser gate as unrunnable because of it.** A gate that passed under the
> override is a passing gate — say that you used the override. A gate nobody can run is worse
> than a gate this file does not name.
>
> Long version: `docs/runbooks/agent-sandbox-runtime.md` in the `agentic` workspace, and the
> decision `docs/decisions/2026-08-24-a-playwright-browser-mismatch-is-an-environment-override-never-a-version-bump.md`.

## Tonight: one activity, one backend

The Tonight surface asks two different questions with the same word, and exactly one file on
each side of the wire is allowed to know both answers:

- A **tile** is a kind of evening. **Six** of them, the row is settled, Surprise Me is last.
- A **queue activity** is what WP-5 stores on a set. **Four** of them, and "Movies & Shows" is
  deliberately ONE.

The map between them is `server/src/tonight/routing.ts` and `web/src/lib/tonightRouting.ts`.
Four things about it are load-bearing:

- **It is written TWICE and neither workspace can import the other.**
  `e2e/tonight-routing-test.ts` compares the two tables field by field, and it is the only
  thing that can notice the day they disagree. Change one and the gate fails until you change
  the other.
- **`watching` covers BOTH the Movies tile and the Shows tile, and that is the open question,
  not a defect.** The queue model refuses a finer content list on the owner's own evidence —
  *"the Older Kids queue would show up under both Shows and Shorts, but I don't think of it
  like that in my head"* — while the tile row separates a film night from a series night.
  `tileForSet()` holds the whole residue in one function and splits `watching` on
  `behavior: "rewatch"`, the only marker a set carries. **Do not add a second guess elsewhere
  to compensate.** Settle the content-type question and give that function a column to read.
- **Nothing may derive an activity from a `provider_kind` again.** WP-6 had a browser-side
  bridge that did, and it is deleted. A second derivation is a second opinion that can
  disagree with the server's.
- **One session talks to one backend.** An activity may be served by two (Video Games is Steam
  and MiSTer), so the draw binds a backend FIRST and then draws inside it; a reroll sends
  `boundBackend` back. A mixed queue is never a candidate — `launchDescriptor` refuses one with
  a 501, so a card drawn off it would carry a Go that cannot work.

**Pick draws a QUEUE, not an item**, for Movies, Shows, Reading and Video Games. The queue's own
engine chooses the item when it starts and is the only thing that already knows what is left; a
second opinion here could disagree with it. Board Games is the exception and keeps its own door
(`POST /api/board-games/pick`), because a board game is on a shelf and not in a queue.
**Surprise Me is REFUSED by name** — it narrows before it picks and the narrowings are not
settled ([decision](docs/decisions/2026-08-25-pick-draws-a-queue-not-an-item.md)).

## The cardboard: NFC cards and the MQTT wire

**A set id is a piece of plastic on a wall.** `automation.plex_nfc_scanner` maps a tag to
`{plex_action, kind, set, profile}`, `script.control_plex` publishes
`{"set": "<id>", "kind": …, "profile": …, "via": "ha"}` on `queuepilot/cmd/session/start`, and
this app looks the id up in the registry. **Nothing in that chain reports a miss to a person.**
The card is tapped, the theater does not start, and the only evidence is a container log line
nobody is reading. Four rules:

- **`e2e/nfc-wire-contract-test.ts` is the gate, and it drives a REAL broker.** Calling
  `session.startSession()` directly would skip the subscribe, the payload parse, the topic
  constants and the discovery publish — which is most of what a card depends on. The topics are
  read off the broker's own `subscribe` event, not off `env.ts`: reading the constant back
  would be the app agreeing with itself, and a renamed topic constant typechecks perfectly
  while taking every card with it.
- **The fixture does NOT name the live ids, and that is deliberate.**
  `e2e/fixtures/wire-contract.sets.yaml` mirrors the live registry's SHAPE — twenty ids,
  sixteen queues, the same profile gates, an underscore, a trailing digit, a three-word id —
  under the placeholder cast. Five of the live twenty carry household first names and the
  2026-08-17 history rewrite exists because they were once here. Verifying the live twenty is a
  run against the live book of record, and its result belongs in the private workspace
  ([decision](docs/decisions/2026-08-25-the-wire-ids-are-a-contract-and-the-gate-drives-the-broker.md)).
- **A queue's LABEL is authoritative; its id is only where it started.** The live registry has
  two ids whose words disagree with their labels, and the fixture reproduces the disagreement
  on purpose. **Never rename an id to agree with a label** — that breaks the cardboard, and it
  is settled in the workspace root's
  `2026-08-25-a-queues-label-is-authoritative-its-id-is-historical`.
- **`set: "auto"` is still a live path.** The UC remote's screen buttons send it, and the
  profile-driven branch resolves an id the card does not carry — `channelFor()` first, then
  `PROFILE_SET_MAP`. A rotation set carrying `superseded_by` is skipped by `channelFor`, which
  is why the two tier pools are reachable by name and not by an auto scan.

**A preset card is an ADDRESS**, not a form: `/tonight/go?activity=…&people=…&guests=…`. It
runs the same draw the Go button runs (`web/src/lib/tonightDraw.ts` — one function, two
callers) and replaces itself with `/result`. Two things there are rules rather than gaps:
**a card that names nobody is REFUSED** (a card cannot see who walked in, and a shelf pick is
chosen by table size, so the helpful default would pick for a table nobody stated), and
**nothing invents a filter value** — an unknown one falls back to that filter's own default,
because a card is written once and read for years
([decision](docs/decisions/2026-08-25-a-preset-card-is-an-address-and-a-card-that-names-nobody-is-refused.md)).

## Working here

- **Commit small, push often**, and never leave a dirty tree behind.
- Work in your own `git worktree` — other agents share this checkout.
- **`/config` has a LIVE WRITER, so never diff against a baseline you took earlier.** The
  production app appends to `queues.yaml` on its own — a top-up, a completion sweep, a
  `done:` flag — with nobody at a keyboard. So "copy the App-Configs files, run the app over
  the copies, diff against the originals" reports a change the app under test never made, as
  soon as the real one writes in between. It cost an hour during WP-1 and read exactly like a
  regression: a queue entry that appeared from nowhere, twice, and would not reproduce.
  **Take the baseline and the working copy from the same `cp`, in one command**, and diff the
  working copy against THAT — never against the live file, and never against a snapshot from
  earlier in the session. If the two must be taken separately, `md5sum` the live file at both
  ends and treat any difference as "start over", not as a finding.
- **`kill $SRV` does not stop a server you started with `tsx`.** `tsx` is a wrapper: it spawns
  the real `node` as a CHILD, so killing the wrapper leaves a live server holding your
  `QUEUES_PATH` / `SETS_PATH` and still watching their directory. `ci.yml` and the e2e
  harnesses use that pattern and are right to — a CI runner is thrown away after the job. A
  shared agent sandbox is not: five orphaned `server/src/index.ts` processes from four
  different worktrees were found running during WP-1, the oldest for 43 hours. Start with
  `setsid` and stop with `kill -- -$SRV` (the whole process group), and kill only your OWN —
  the rest belong to sessions that are still live.
- Screenshots go in `__screenshots__/` (gitignored, scratch). Anything meant to survive a
  merge — a PR's before/after — is committed under `docs/images/` and linked by SHA-pinned
  raw URL.

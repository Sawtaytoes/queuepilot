# Every picker names the edition, and the entry it writes carries it too

- **Status:** Accepted
- **Date:** 2026-08-21
- **Type:** fix / ux
- **Supersedes:** —
- **Superseded by:** —

Extends [2026-08-17 — a search result says which library it is in, which edition it is, and
whether this pool can reach it](2026-08-17-search-results-say-which-library-and-which-edition.md),
which settled the rule but landed it in one picker only.

## Decision

1. **Every `SearchDropdown` result row names the edition** when Plex gave the item one — the
   queue add box, the Home toolbar's add-to-any-queue box, the pool member picker and a pool's
   Blocked picker. It is one shared `EditionBadge` component, not a `<span>` copied per row.
2. **Every pick that writes a queue/member entry names it with `entryTitle()`**, which appends
   the edition. One function, so a title cannot be built correctly at one call site and
   incorrectly at the next three.
3. **The plain edition stays plain.** Plex tags only the non-default item of a pair, so the
   untagged row renders nothing rather than a "Standard" label Plex never wrote.
4. **A COLLECTION keeps its bare name.** Its entry is the literal `Collection: <name>` the
   resolver expands by NAME, so a year or an edition appended to it stops it resolving.
5. **Existing entries are NOT rewritten.** The change is forward-only.

## Context

Owner, 2026-08-21, searching the **queue** add box:

> "I also swear we were supposed to get the edition to display here in this list when
> searching items to add to queues."

He is right, and the miss is exact. The 2026-08-17 fix (#139) touched `SearchDropdown.tsx`,
`searchGroups.ts`, `types.ts`, `app.css` and `views/ChannelMembers.tsx`. It never touched
`views/QueueView.tsx`, `components/Toolbar.tsx` or `views/ChannelFilters.tsx`. So the payload
carried `editionTitle`, the CSS rule `.results .editionbadge` was already written, and three of
the four pickers rendered neither — two rows reading `Ulysses 1954` and `Ulysses 1954`,
identical character for character.

The stored title had the same shape of bug. `QueueView` built `` `${hit.title} (${hit.year})` ``
by hand, so two editions of one film went into `queues.yaml` under one indistinguishable title.
`ChannelMembers` had been fixed to use `hitLabel`; nothing made the other three follow.

## Why

- **The label logic was copied, so it could only be fixed once per copy.** Four call sites each
  built the same string and each drew the same badge. `entryTitle()` and `<EditionBadge>` are
  what make "the row names its edition" a property of the app rather than of one file.
- **The stored title is display text, and only that — so carrying the edition is safe.** An
  entry written by a pick is `{ratingKey, title}`. `plex.resolveValue()` returns on the
  `ratingKey` branch before it ever reads `title`, and `queues.entryKey()` keys the entry
  `rk:<ratingKey>`. The title is read in exactly two places: by a human opening `queues.yaml`,
  and by `tiles.displayFor()` as the fallback caption when the ratingKey no longer resolves.
  Both are better for naming the edition.
- **No migration, because identity never moves.** Existing entries keep their titles and their
  `rk:` keys. Nothing re-keys, nothing duplicates, nothing needs a rewrite pass. An old entry
  and a new one for the same film differ only in how the file reads.
- **The one caveat, recorded rather than fixed.** `plex.parseTitleString()` strips a trailing
  `[guid]` then a trailing `(YYYY)`. `Ulysses (1954) — 3D` therefore parses as the whole string
  with a null year. That path is reached only by a **title-only** entry, so it cannot be reached
  by anything a picker writes — a picker always writes the `ratingKey` as well. It would bite an
  entry whose `ratingKey` had been deleted by hand. Teaching `parseTitleString` to strip a
  trailing ` — <text>` was rejected: a genuine title can contain that separator
  (`Winnie the Pooh — Springtime with Roo`), the function is pinned by the recorded engine-parity
  oracles, and the case it would rescue is one nobody has hit.
- **Blocked needs it as much as the add boxes do.** That list excludes by `ratingKey`, so it
  excludes exactly ONE of the two editions. A row that will not say which one is worse there
  than in an add box, not better.

## Evidence

- Owner quote above, and the #139 quote it repeats: *"There's no 'edition' listed, so I don't
  know which of these is which."*
- `git show --stat 981f035` — the file list that shows which pickers were left behind.
- Gate: `web/src/lib/searchGroups.test.ts`, `entryTitle` — two editions of one film produce
  different strings, the plain one stays plain, a collection keeps its bare name.
- Before/after, all three pickers, from `e2e/shot-queue-search-edition.ts` against a **stub**
  Plex: `docs/images/2026-08-21-queue-search-edition-*.png`,
  `docs/images/2026-08-21-home-search-edition-*.png`,
  `docs/images/2026-08-21-blocked-search-edition-*.png`. The two library items in them are
  invented, because the shot must show one title twice and the real one would be the
  household's.

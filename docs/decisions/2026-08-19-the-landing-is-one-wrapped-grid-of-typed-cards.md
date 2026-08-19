# The landing is ONE wrapped grid of typed cards, not three columns of one kind each

**Status:** Accepted
**Date:** 2026-08-19
**Type:** UX / frontend layout
**Supersedes:** the three-column LAYOUT half of
[2026-08-16 — Filtered Pools, Curated Pools, Ordered Queues](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
(that record's three NAMES are reaffirmed and now render on the cards; only "three groups
side by side as columns" is replaced)
**Superseded by:** —

## Decision

The Play landing renders **every pool and queue in one wrapped grid**, in file order, and
**each card says which kind it is** — `FILTERED POOL`, `CURATED POOL`, `ORDERED QUEUE`, in a
quiet outlined badge beside the name.

| Was | Is |
| --- | --- |
| Three fixed columns, one per kind | One `repeat(auto-fill, minmax(320px, 1fr))` grid |
| Three `<h2>` headings carry the kind | The card's own badge carries the kind |
| Three `Configure ›` links, one per heading | One quiet link row: Pending, Configure pools, Configure ordered queues |
| Three `<ul>`s, three independent drags | One `<ul id="playgrid">`, one drag |

The **kind badge is monochrome on purpose.** On this page colour already means *provider*
([2026-08-15](2026-08-15-a-queue-wears-its-providers-colour.md)); a first cut gave each kind
a coloured dot and it put an amber dot beside an amber Plex button and a green dot beside a
green Kavita button — a second colour system teaching the eye a rule the page then breaks.
The kind is a word; the colour stays the provider's.

**`auto-fill`, not `auto-fit`.** With `auto-fit` a landing holding two cards stretches them
to half the page each, which is the same "the taxonomy decides the layout" failure in a new
costume. `auto-fill` keeps a card a card.

## Context

Reported from two screenshots of the live app, 2026-08-19:

> "As I said before, I really don't like this layout. I want it all combined in a way that
> makes a lot of sense, and the card itself shows you the type of queue it is. This 3-column
> model really doesn't work."

> "Image 3 is the worst one. Lots of stuff, but I think we can make it work. We can probably
> make these in a wrapped grid instead."

Four candidate layouts were mocked at the true width against the app's own tokens and served
for the owner to pick from (the
[mock-then-pick loop](../../../agentic/docs/runbooks/ui-design-previews.md)); he chose the
combined grid with the kind as a badge over the same grid with the kind folded into the meta
line, and over a conservative "keep the headings, wrap each band" option.

## Why

- **The layout answered to the taxonomy instead of to the data.** Three columns are three
  columns whether you own 2 sets or 17. One install rendered with two of the three columns
  empty — two thirds of the page blank; the household's own install ran the Ordered Queues
  column eight cards deep beside a column of three, so the page was both crowded and mostly
  empty at once.
- **A group filter made it worse, not better.** Picking a group is exactly when a kind
  empties out, so the shape the owner saw most often was the broken one.
- **The kinds did not need to be headings to be legible.** They are a property of each set,
  and putting them on the set is what frees the layout — nothing was lost, and the words are
  now visible next to the thing they describe rather than at the top of a column that may
  have scrolled away.
- **The Narrow View gets simpler for free**: one column of cards instead of three headings
  to scroll past to reach the queue you wanted.
- **One order, one drag.** The three shelves were three slices of one `sets.yaml` order, and
  reordering could only ever move a card within its own kind. One grid means a card can be
  dragged anywhere — the household's most-used queue can sit first regardless of what kind it
  is. `spliceOrder` is unchanged and still earns its keep: under a group or provider filter
  the grid is still a slice, and the PATCH still sends the full order so hidden sets keep
  their slots.

## Consequences

- **The reorder gesture had to learn a second axis.** `useRowReorder` compared the dragged
  row's Y midpoint against each neighbour's — correct for a column, silently wrong for a
  grid, where every card in a row shares a Y midpoint. The test is **containment** now (which
  card is the pointer inside), which is unambiguous in both layouts and needs no special case
  for the one-column Narrow View. `e2e/play-reorder-test.ts` drives both axes and fails 4
  assertions against the old hook.
- **DOM contract changes**, and seventeen suites read this page: `.playrow` → `.playcard`,
  and `#playdynamic` / `#playcurated` / `#playqueues` → one `#playgrid`, with the kind
  legible per card as `li[data-kind="filtered|curated|ordered"]`. `#gochannels` and
  `#goqueues` survive with their ids; `#gocurated` is gone (it pointed at the same `/channels`
  as `#gochannels`).
- `overflow-wrap: anywhere` moved from the row's name+meta wrapper onto `.playcard`, where it
  covers both. Scoping it to the name alone shipped a 390px viewport measuring **643px** —
  a long unbroken token in the *meta* overflows exactly as one in the name does.
  `narrow-scroll-test` caught it.
- An **empty grid** is now a real state with nothing to stand in for it, so it renders an
  `EmptyState`. The link row stays visible either way: those links are the only way to create
  a first pool or queue, and a fresh install must not be a dead end.
- The landing's sub-line no longer says "Configure › opens each shelf's editor" — there are
  no shelves. It says what the page's one non-obvious gesture is: drag a card by its ≡.

## Evidence

- Owner, 2026-08-19, with screenshots of the live app (quoted above).
- Mockups served for the pick, 2026-08-19: four candidates at 1420px in the dark scheme
  against 17 fixture sets.
- Reproducible before/after: `server/node_modules/.bin/tsx e2e/shot-landing.ts --tag=<t>`
  against `e2e/fixtures/landing.*.yaml` — 17 sets, three kinds, six groups, all anonymized.
- Gates on this change: `play-reorder-test` 11/11 (and 4 red against the old hook),
  `narrow-scroll-test` 58/58, `ui-test` 41/41, `routing-test` 18/18, vitest 117/117,
  typecheck clean, biome unchanged. `channels-test` and `drag-stability-test` fail
  identically on unmodified `main` in this environment (no MQTT broker), verified by
  stashing.

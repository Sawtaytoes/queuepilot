# The Play landing creates a queue from its own link row, and the toolbar stays hidden

**Status:** Accepted
**Date:** 2026-08-21
**Type:** UX / frontend
**Supersedes:** —
**Superseded by:** —
**Builds on:** [2026-08-19 — the landing is one wrapped grid of typed cards](2026-08-19-the-landing-is-one-wrapped-grid-of-typed-cards.md)
(that record already said this row "is the only way to create a first pool or queue"; it was
one hop short of true — the row only *linked* to the editors that hold the buttons)

## Decision

The Play landing's link row gains a **`＋ New queue`** button (`#playnewqueue`) beside
Pending / Configure pools / Configure ordered queues. It calls
`openSetModal(null, "movies")` — the same entry point the Ordered Queues toolbar uses.

Three sub-decisions come with it:

1. **`body.queue-view #tools` is NOT touched.** The landing and Pending both set
   `queue-view` precisely to hide `#tools`, and that hide is load-bearing: un-hiding it
   would put the queue filter, Collapse all, and the "Add to any queue — search all
   libraries…" box into the Play and Pending headers, none of which mean anything there.
   The fix is a local affordance, which is what `ChannelsView` already does with
   `＋ Filtered pool` / `＋ Curated pool`.
2. **Its own id, never a second `#newqueue`.** `narrow-scroll-test` and `ui-test` both
   `click('#newqueue')` after navigating to `/queues`, and `PlayView` renders *before*
   `QueuesView`, so a duplicate id hands both suites the landing's hidden button instead.
3. **It seeds `movies` (an Ordered Queue) and does not ask first.** The modal's second
   field is a Type picker holding **Ordered Queue** and **Curated Pool**, so the kind is
   asked, one control in, on the screen where the rest of the queue is defined. A
   **Filtered Pool** is a different editor (`openDynModal`) and stays behind
   `Configure pools ›` — it is rules, not a member list, and putting a third create button
   on a play-first landing would turn the row into a button bar.

## Context

Owner, 2026-08-21, looking at the live app: *"Also, there's no 'add new' to add a new
queue"*, and then, from a group page: *"Even here, I can't add a new queue."*

He was right, and the path was longer than it looked. `＋ New queue` existed the whole time
— at `Toolbar.tsx:291` — but `#tools` is `display: none` under `body.queue-view`, which the
landing sets on both of its branches (the bare `/` and `/g/<id>`). So the only route to a
new queue was: read the quiet grey link row, follow `Configure ordered queues ›`, then find
the button in the header of *that* page.

## Why

- **The landing is where you find out what you own**, so it is where "I want another one"
  occurs to somebody. Every other create button in this app sits on the screen that lists
  the things it creates; the landing was the one that listed everything and offered nothing.
- **The Narrow View had no path at all until you knew the trick.** `#tools` mounts into
  `#gslot-narrow`, which lives inside `QueuesView` — so below 760px the button is not merely
  hidden on the landing, it is not on the landing's DOM in any form.
- **The link row was already the page's configuration chrome.** It is the row that survives
  an empty grid on purpose. Adding the action there costs no new region and no new concept.
- **"New queue" rather than a new word.** The string, the full-width `＋` and the accent
  treatment are copied from the toolbar's button, so the two read as one control in two
  places. Renaming it here to match the card badge ("Ordered Queue") would have made the
  landing disagree with the page it links to.

## Consequences

- A queue created from a **group page** does not join that group. Group membership is
  explicit-then-derived ([2026-08-17](2026-08-17-a-group-is-who-is-watching-not-a-plex-profile.md)),
  so a new queue that no group names and whose profile matches no group's accounts lands in
  `All` and is invisible under the filter that was on screen when it was made. That is
  pre-existing behaviour rather than something this change introduces — the same is true of
  a queue made from `/queues` — but this change is what makes it easy to hit. Whether
  creating inside a group should file the queue into it is a **product question for the
  owner**, not something to infer.
- `narrow-scroll-test` grows one modal case, `['/', '#playnewqueue', …]`. It belongs in
  that suite because that is the always-on browser gate: the Plex-gated suites are skipped
  on every PR, so a landing that loses its create affordance again would otherwise reach
  `main` unchallenged. 58 assertions → 66.

## Evidence

- Owner quotes above, 2026-08-21.
- `Toolbar.tsx:285-292` (the button that exists), `app.css` `body.queue-view #tools`
  (the hide), `App.tsx` `computeChrome` (both landing branches set `queue-view`).
- Reproducible before/after:
  `server/node_modules/.bin/tsx e2e/shot-new-queue.ts --tag=<before|after>` against
  `e2e/fixtures/landing.*.yaml` — 17 sets, three kinds, six groups, all anonymized.
- Gates: `narrow-scroll-test` 66/66, `routing-test` 22/22, `play-reorder-test` 11/11,
  `pool-editor-keeps-blocked` 5/5, `drag-stability` OK, vitest 117/117, biome clean, four
  typechecks clean, both builds clean, `pick-contract` holds.

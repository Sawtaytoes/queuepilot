# A destructive queue action lives in an Actions menu, behind a confirm

**Status:** Accepted
**Date:** 2026-09-08
**Type:** UI / interaction / safety
**Supersedes:** the toolbar placement of `#qremovedone` (QueueView "Remove all completed")
**Superseded by:** —

## Decision

An action that throws away queue state is **not** a button in the queue toolbar. It sits in
an **Actions** menu on that toolbar, and choosing it opens a confirm step that names what
will be lost.

Two actions live there on day one:

- **Mark all unwatched** — clears every completion the queue owns. The manual twin of
  [the reset date](2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year.md),
  and it clears the same three things.
- **Remove all completed** — the existing `#qremovedone` button, **moved**, not duplicated.

Three constraints.

- **It is a `Menu`, not a `Picker`.** A row that DOES something is a `menuitem`; a row that
  IS something is an `option`. Both rows here perform an action and hold no value, so the
  picker rule does not reach this control
  ([2026-08-21-an-add-to-menu-is-a-menu-not-a-picker](2026-08-21-an-add-to-menu-is-a-menu-not-a-picker.md)).
  A Charcuterie `Menu` panel portals to `<body>`, so an e2e selector scoped under `#qtoolbar`
  will not find these rows.
- **The confirm names the number.** "Clear 12 completions in Halloween?" — not "Are you
  sure?". A count is the only thing that tells the owner he has the queue he thinks he has.
- **The menu itself hides when there is nothing to act on.** `#qremovedone` already hides
  when no entry is `done`; the menu inherits that rule rather than showing two disabled rows.
  ⚠️ It keys on `done`, **not** `isCompleted` — a live-finished entry gets its flag from the
  next reconcile, seconds after playback, and offering to act on it before then would do
  nothing.

## Context

The owner asked for a manual reset, then rejected putting it on the toolbar:

> "I also think Option 2 is good, but I don't want the button right there on the nav where
> you can accidentally click it. It needs to have a confirmation and be behind a dropdown
> actions menu. 'Remove all Completed' can also be in there."

The toolbar already carries a search box, Remove all completed, Configure and Play on. A
mockup with a fifth button wrapped the search field onto two lines at 1106 px, which is the
width the toolbar occupies in a 1440 px window.

## Why

- **A destructive action next to Play is a misclick waiting to happen.** These two throw away
  a season of watching and cannot be undone from the screen that did it.
- **It empties the toolbar rather than filling it.** Moving Remove all completed in means the
  toolbar loses a button on the day it gains a menu.
- **The confirm is where the count belongs.** The toolbar has no room to say how much is
  about to go.

## Evidence

Owner, 2026-09-08, quoted above. The toolbar crowding was measured in the mockup at the live
toolbar width before the decision was taken.

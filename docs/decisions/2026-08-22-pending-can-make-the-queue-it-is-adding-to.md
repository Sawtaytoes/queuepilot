# Pending can make the queue it is adding to

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** UI / behaviour
- **Supersedes:** —
- **Superseded by:** —

## Decision

The Add-to menu ends with a **separator** and a **"New queue…"** row. It opens the ordinary
queue dialog, pre-ticked with the item's own library, and when that dialog creates the queue
the item is added to it.

Three parts:

- **A separator, and the last row.** Choosing an existing queue and making one are different
  kinds of act. `role="separator"` is what says so, and the arrow keys pass straight over it.
- **The item's library is pre-ticked.** A new queue draws from nothing by default, and a
  queue that draws from nothing cannot hold the item that prompted it — the add would land in
  a queue that will never play it.
- **The dialog reports the id it created** (`onCreated`), because the add has to name a queue
  that the registry the view is holding has never seen.

`openSetModal` grew a third argument for the two of these — `presetLibraries` and
`onCreated`. Nothing else passes it, and nothing else changes.

The empty case changed wording with it: "No queue draws from *Films*" used to end with
"— add it to one via its ⚙", which pointed at another screen. It now says "make one below",
because below is where that is now possible.

## Context

> *"I also cannot add a queue from here either. I wanted to create a new one to add one of the
> movies. Not a huge deal, but it would be nice to have that option somewhere. It's not in the
> dropdown."*

## Why

**In the menu, not beside it.** The question the menu answers is "which queue does this go
in?", and "one that does not exist yet" is an answer to that question. A button elsewhere on
the screen would be a second place to look for the same decision.

**Pre-ticking the library is not a shortcut, it is the fix.** Without it, the flow the owner
described — make a queue, add this film to it — ends with a queue the film is not eligible
for, and nothing on screen says why.

**`addTo` takes an id and a label, not a `RegistrySet`.** The queue exists on the server
before it exists in the registry the view is rendering from, so the add cannot wait for a
refresh that has not happened.

## Evidence

- Owner's report, quoted above (2026-08-21), and his answer to the mock-up: *"5A"*.
- Screenshot: `docs/images/2026-08-22-pending-addto-menu.png` — the menu, from the stub-Plex
  fixture.

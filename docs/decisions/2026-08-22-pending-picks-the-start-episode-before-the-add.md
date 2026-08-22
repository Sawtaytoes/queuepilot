# Pending picks the start episode BEFORE the add, and the add writes it

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** UI / behaviour
- **Supersedes:** —
- **Superseded by:** —

## Decision

A pending **show** carries a "Start at…" control (a clock in the poster view). It opens the
same start picker every other start point in this app goes through, and the choice is held in
the view until you add the item to a queue. The add then writes it, as a second call:

1. `POST /api/queues/<set>/items` — the entry, answering its key.
2. `PATCH /api/queues/<set>/items/<key>/start` — the start point, on that key.

Rules that fell out of it:

- **Only on a real add.** `added: false` means the queue already names this item, and its
  existing entry has a start this screen has never seen. Overwriting it would be an edit
  nobody asked for.
- **Only on a show.** A film starts where films start.
- **Never persisted.** A start chosen and not added is a choice abandoned; keeping it would
  write a days-old decision into whatever queue got picked later.
- **The tile says so.** The chosen start renders as an accent line under the library name,
  because it is the one thing on the tile that is a pending edit rather than a fact.

## Context

The owner, on the Pending screen:

> *"I wanna add this show, but I'd like to specify the episode to start on. Doesn't seem to
> be possible from here."*

Three shapes were drawn for it: add-then-the-picker-opens, a separate control that picks
first, and a second step inside the Add-to menu. He rejected all three as drawn, because the
tile had no room for another control — but named the one he wanted once the layout was fixed:

> *"I think 4B is okay. I don't like the second menu in 4C for sure. It's the 'right'
> solution but makes adding a bunch of these cumbersome."*

## Why

**Pick first, write on the add.** The menu-submenu version is the tidiest model and the worst
to use: every add becomes two menu levels, on a screen whose whole job is getting through a
list. A separate control costs one button and only when you want it.

**A second call, not a `start` field on the add.** `PATCH …/items/:key/start` is the one
writer of a start point everywhere else — the tile menu, the start modal, the entry sheet. A
second door into the same write is a second place for the two to disagree.

**The same modal, pointed at a local `save`.** `StartModal` is driven by `EntryActions`, which
already abstracts *how a start is persisted*. A pending item is in no set, so its `save` puts
the choice in component state and the add does the writing. The picker itself — the real
episode list, the watched marks, "picked, never typed" — is unchanged, which is the point of
reusing it.

The one adapter this needs is `asStartEntry()`, which dresses a `PendingItem` as the entry the
modal takes. Its `index: -1` is unreachable: `index` addresses a member inside a channel's
stored array, and this entry's only writer is the local `save`.

## Evidence

- Owner's request and his choice, quoted above (2026-08-21 and 2026-08-22).
- Screenshot: `docs/images/2026-08-22-pending-views-start.png` — the control on a page of
  shows, from the stub-Plex fixture.

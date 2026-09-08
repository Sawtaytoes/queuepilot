# The Actions menu hides on what each ROW can do, not on the `done` flag

**Status:** Accepted
**Date:** 2026-09-08
**Type:** UI / correction / product rule
**Supersedes:** in part —
  [2026-09-08-a-destructive-queue-action-lives-in-an-actions-menu-behind-a-confirm](2026-09-08-a-destructive-queue-action-lives-in-an-actions-menu-behind-a-confirm.md)
  (the HIDE clause only — "the menu itself hides when there is nothing to act on … `#qremovedone`
  already hides when no entry is `done`; the menu inherits that rule". Everything else in that
  record stands unchanged: the menu placement, the `Menu`-not-`Picker` call, the confirm that
  names the count, and the move of `#qremovedone` off the toolbar.)
**Superseded by:** —

## Decision

**A row is offered on what THAT row can do, and the menu is present when any row is.**

| Row | Offered when |
| --- | --- |
| **Remove all completed** | any entry carries a `done` flag |
| **Mark all unwatched** | any entry carries a `done` flag **or** the queue owns any completion in `queue_entry_history` |

An unavailable row is **disabled inside an open menu, and says why** — it is not removed. When
NO row is available the menu itself is absent, so two disabled rows never appear together. Since
"Remove all completed is available" implies "Mark all unwatched is available", exactly one
disabled row is reachable and it is always `Remove all completed`.

Three things from the superseded record are kept, because they were right for reasons that have
not changed:

- **The `done` test reads `allItems`, never the filtered `items`.** A view filter narrows what
  is on screen and changes nothing about what either endpoint acts on, so a filter must not hide
  the control while the file still holds completions.
- **It keys on `done`, not `isCompleted`.** A live-finished entry gets its flag from the next
  reconcile, seconds after playback, and `remove-completed` can only remove what the FILE has
  flagged. Offering to act on it earlier would do nothing.
- **The confirm still names a number**, and the number is still what the page can see.

**Lead cooldowns are NOT a third signal here, because the browser cannot see them.** A reset also
clears `lead_cooldown` rows, and a spent cooldown can outlive every flag and every history row —
so a queue can, in principle, have something to reset that this rule does not detect. Nothing in
`/api/queues` carries lead cooldowns and nothing in `web/src` reads them. Adding that signal
means adding a field or an endpoint, which is a separate change; inventing one here would have
been a guess wearing a number.

## Context

The first implementation hid the whole menu when no entry carried a `done` flag. That rule was
inherited from `#qremovedone`, the button `Mark all unwatched` moved in beside — and for THAT
button it is exactly right, because a `done` flag is the only thing `POST /queues/:set/remove-completed`
can act on.

It is wrong for the row that arrived with the menu. **`Mark all unwatched` has work to do when
nothing is flagged.** On a queue carrying `watch_history: queue`, completions live in
`queue_entry_history` rather than on the entry, and a **part-watched series** is exactly the
shape that has history rows and no `done` flag: nine episodes finished, the tenth still to play,
so the entry is not done and never will be until the run ends.

So the case where a manual reset helps most — *this series is stuck halfway, start it over* —
was precisely the case where the menu was not offered. The motivating configuration is the
household **Halloween queue**, which is `watch_history: queue`: the queue the seasonal reset was
built for is the queue whose manual twin was unreachable.

The defect was reported by the agent that built the feature, in the same report that delivered
it, and confirmed before this record was written.

## Why

- **A control is offered on what it can DO.** Two rows that call two different endpoints have
  two different availability questions, and answering both with one flag is how the newer row
  inherited a rule written for the older one.
- **Disabled and stating a reason, rather than absent.** A row that silently is not there
  teaches nobody why it is not there, and the owner's next move is to look for it somewhere
  else. This is not a new judgement in this app: the two Add-to menus already render their
  no-compatible-queue state as **one disabled `menuitem` carrying the sentence**, for the reason
  written down on 2026-08-21 — *it announces as unavailable rather than as absent, "you cannot
  do this right now" rather than "this does not exist"*. `MenuAction` never registers a disabled
  item with `RovingFocus`, so the arrow keys skip it and the keyboard is not made worse by it.
- **The whole menu still disappears when nothing can be done**, which is what the superseded
  record was protecting. A trigger that opens a panel of dead rows is worse than no trigger.
- **The reset's count is the FINER of two granularities, never their sum.** `done` counts
  ENTRIES and `queue_history_completed_count` counts LEAVES, and on a queue-history queue a
  finished movie has both — one `done` flag and one history row for the same film. Adding them
  doubles every number the owner can check against the screen, so the confirm names
  `max(entries flagged, leaves completed)`: 12 for a movie queue where both say 12, 9 for the
  part-watched series where only the history knows, and 5 for a provider-history queue where
  only the flags do. The status line afterwards still reconciles against what the route actually
  cleared.

## Evidence

- `server/src/routes/queuesRoutes.ts:136` already puts `queue_history_completed_count` on every
  item, and `web/src/lib/types.ts:200` already types it. No new endpoint was needed, and none
  was added.
- `server/src/store/db/queueEntryHistory.ts clearSet()` deletes **every** row for the set, not
  only the completed ones — so a queue holding nothing but saved positions also has something to
  clear. `queue_history_completed_count` counts `is_completed` rows only, so that narrower case
  is not detected either; it is named here rather than papered over.
- Gate: `e2e/actions-menu-test.ts`. It stages the motivating shape — a queue on
  `watch_history: queue` with a completed leaf and **no** `done` flag — and asserts the menu is
  offered, `Mark all unwatched` is enabled, `Remove all completed` is disabled and says why, and
  the reset still writes.

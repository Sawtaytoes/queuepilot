# Any tile in an editable grid gets the ✕

**Status:** Accepted
**Date:** 2026-08-21
**Type:** UX / frontend interaction
**Supersedes:** —
**Superseded by:** —

## Decision

**If a grid can write to a queue at all, every tile in it carries the ✕.** "Editable" is not a
per-page judgement call: a grid that can reorder an entry, move it to another queue, or change
where it starts is a grid that can remove it. There is no read-only-but-draggable state.

Concretely:

1. The Ordered Queues shelf passes `onRemove` and `onContextMenu` to `PosterTile`, the same two
   the queue grid and the channel member grid pass.
2. The removal itself is **one implementation** — `removeQueueItem` in
   `web/src/state/queueEntry.ts`. A second call site costs a prop, never a second copy.
3. The ✕'s CSS **keys on the button being in the DOM**, not on an `.editable` ancestor.
   `PosterTile` renders the button only when a call site passes `onRemove`, so its presence
   already says everything the ancestor class said. The multi-select ✓ keeps its `.editable`
   gate, because that control belongs to the queue page's selection mode and nowhere else.

A genuinely read-only grid — the channel eligible pool — passes no `onRemove` and renders no
button, which is the only way to opt out.

## Context

> "From the Ordered Queues view, I can't remove items either." (owner, 2026-08-21)

"Either" because he had just reported the same gap elsewhere. The Ordered Queues page renders
the identical `PosterTile` as `/q/<id>`, and had done since the React rewrite — it simply passed
none of the write props. So the only route to a removal was to open the queue first, and the ✕
he was looking for was two clicks away on a different page.

The page was never read-only. `useHomeDrags` gives the shelf two write gestures already:
reorder within a shelf, and drop onto another shelf to MOVE the title between queues. A page
that can move a title into a different queue but cannot take it out of this one is incoherent,
and no decision record ever made it read-only. `2026-07-21-shelf-ui-conventions` already refers
to "the remove ×" as ordinary tile chrome.

## Why

- **Two independent gates had to line up, and only one of them was visible in review.** The
  shelf passed no `onRemove` AND sat outside `.editable`. Restore only the prop and the button
  renders `display: none` — found by `querySelector`, invisible to the owner. Keying the CSS on
  the element's presence collapses the two gates into one, so the next call site cannot get it
  half right.
- **`removeTile` was a closure inside a component**, which is why nobody reused it: reaching
  the removal meant reaching into `QueueView`. It is ~20 lines of optimistic mutation plus a
  DELETE and a failure re-sync — exactly the kind of thing that gets copied and then drifts.
  Lifting it was a precondition for the fix, not a tidy-up alongside it.
- **Undo needed no client work, and asserting that is the point.** `undoSnapshot` middleware
  snapshots the YAML before every mutating request, so a removal joins the undo stack by being
  a DELETE. The e2e suite drives `#undo` and checks the file, so a future "optimistic-only"
  shortcut that skips the request cannot look correct on screen.
- **The context menu was a dead gesture, not a missing one.** `useHomeDrags` already
  `preventDefault`s the browser's native menu over a shelf poster, because a touch long-press
  arms a drag there. So a right-click on a shelf poster did nothing whatsoever. Wiring
  `onContextMenu` costs one prop, reuses the globally-mounted `TileMenu`, and also gives the
  shelf the start-point actions, which had no route from that page at all.
- **What was deliberately NOT switched on.** The shelf does not become `.editable`. That class
  also carries `touch-action: pan-y` on `.thumb`, which would stop a finger from panning the
  horizontal strip, and it restyles finished tiles. The change is one control, not a mode — the
  shelf still has no ✓ multi-select and no per-tile ▶, and the suite asserts both absences.

## Consequences

- `web/src/state/queueEntry.ts` is new: `removeQueueItem` and `queueEntryActions`, lifted out of
  `QueueView` unchanged. `QueueView` keeps two one-line wrappers so its call sites read the same.
- `app.css`: `.tile .check` keeps `display: none` + the `.editable` reveal; the ✕'s rules
  (`display`, the absolute inset, the quiet-until-hover opacity, the coarse-pointer override)
  drop the ancestor. `.tile { position: relative }` is now unconditional — the positioning
  context the chrome resolves against.
- `e2e/shelf-remove-test.ts` is a new always-on, no-Plex browser gate. It asserts the COMPUTED
  style of the ✕, the optimistic removal, what `queues.yaml` holds afterwards, survival across a
  reload, undo through the header button, the context-menu route, and that the queue grid still
  removes after the lift. Against the pre-change build it fails on assertion three.
- `e2e/shot-shelf-remove.ts` shoots the before/after pair. It runs a stub Plex rather than the
  unroutable one the browser suites use: with no Plex every entry resolves to nothing and the
  shelf paints a row of red "Not in library" boxes, which is a picture of a broken app rather
  than of the control under discussion.

## Evidence

`e2e/shelf-remove-test.ts` 21/21 PASS on the branch. On `main` (the same file, the pre-change
`web/dist`) it prints `FAIL every shelf tile carries a ✕` and then times out waiting for
`.shelf li.tile .remove` — the button is not in the DOM at all.

Before/after, same frame, first tile hovered, fixture data:
`docs/images/2026-08-21-shelf-remove-before.png` / `-after.png`, and the per-entry menu in
`-menu-before.png` / `-menu-after.png`.

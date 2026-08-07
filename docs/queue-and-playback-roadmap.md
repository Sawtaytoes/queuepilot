# Roadmap: queue lifecycle + playback state machine

Requested by the owner during the 2026-08-06/07 reliability session. Grouped so related
changes ship together. Pairs with `playback-state-machine-design.md` (the FSM detail).

## 1. Playback as a state machine (the big one)
See `playback-state-machine-design.md`. Sample real state (device on, foreground app, Plex
state, active profile, now-playing) → drive **verified, retried** transitions to `playing`,
instead of the current fire-and-forget sequence that errors with no retry. Fold the items
below into it where they fit.

## 2. Resume-in-queue (partial watch → resume)
**Ask:** if I started a *queued* item and didn't finish it, the next scan of that queue
resumes **that** item from where I left off — not the next item, not from 0. Queued items
only; general Plex playback already resumes on its own.

- On selection, an in-progress entry (Plex `viewOffset > 0`, not watched) is chosen over
  advancing, and `playMedia` is sent **with that offset** so it resumes.
- Applies to episodes and movies. A finished item still advances as today.
- Interaction with #3: an in-progress item is NOT "completed", so the TTL clock hasn't
  started; it just waits to be resumed.

## 3. Auto-remove completed entries after a TTL (configurable)
**Ask:** completed items shouldn't stay in the queue forever (they do today — marked
`done: true`, kept, manual-× only; decision `2026-07-21-finished-entries-marked-done-not-pruned`).
Remove them after a reasonable time, configurable, sensible default.

- Stamp `done_at` (ISO/epoch) when an entry is marked done (today `done: true` has no time).
- A periodic sweep prunes entries whose `done_at` is older than `remove_completed_after`.
- Config: a global default (propose **24h**) overridable per set in `sets.yaml`
  (`remove_completed_after: 24h` / `0` or `never` to disable).
- **Exempt** playlist/reel queues (#4) — they never remove.
- Grey "Completed" tiles stay until the sweep, so a re-watch within the window is easy.

## 4. Non-consuming / playlist queue (never remove when played)
**Ask:** the Theater Demo Reel is a playlist I show repeatedly — finishing an item must NOT
remove it; it stays in the queue.

- Note: `reel: true` **already implies never-marked-done / never-removed** (the demo set is
  `source: queue` + `reel: true`). So the demo reel already keeps its items. This request is
  really: make that a **clearly-named, general** per-queue option decoupled from reel's other
  behavior (reel also plays the WHOLE lineup in order every scan).
- Propose an explicit flag, e.g. `keep_completed: true` (or `consume: false`), that any queue
  can set to opt out of both mark-done and the #3 TTL sweep, independent of `reel`.
- **Open decision (ask the owner):** should the demo reel keep playing the entire lineup every
  scan (current `reel`), or advance one clip per scan like a normal queue but never remove
  (a "loop playlist")? That choice decides whether `keep_completed` replaces or complements
  `reel`.

## 5. SSE now-playing re-sync on reconnect (web UI)
**Ask/confirmed bug:** the phone sleeps the browser, the SSE connection drops and misses the
`now` event, and on return the tile shows the stale page-load value until a full refresh or
the next update (observed: "Shutter Island" lingering).

- Server: on a new `/api/events` connection, immediately emit the current retained
  now-playing + state snapshot (don't wait for the next change).
- Client (`web/src/state/live.ts`): refetch `/api/now` on `visibilitychange` → visible and on
  EventSource re-open, so a resumed tab reconciles instantly.

## Sequencing (proposed)
- **PR A (this branch, feat/queue-lifecycle-fsm):** #5 (small, isolated web fix) + #3 + #4
  (queue-lifecycle config; self-contained in queues/config) + #2 resume. These are concrete
  and testable without the full FSM.
- **PR B:** the #1 FSM refactor of the play path, absorbing the transition/retry work.
Confirm with owner before building — grouping and the #4 open decision are his calls.

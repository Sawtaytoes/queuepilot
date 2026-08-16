# Kavita progress is read on demand — it is not pushed

- **Status:** Accepted
- **Date:** 2026-08-16
- **Type:** bug / architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

**QueuePilot does not subscribe to Kavita.** Kavita has no webhooks and no
cast (feasibility §4). A tile's next chapter is computed when
`GET /api/queues` actually runs: `series-detail`, then unread =
`pagesRead < pages`. "In Progress" is `pagesRead > 0` on that next
chapter.

There is no poll, no SignalR listener, and no cache of chapter progress.
The only thing that *looked* like a cache was the `/api/queues` ETag,
keyed on `queues.yaml` + `sets.yaml` + SQLite generation. Marking a
chapter read in Kavita changes none of those, so a refresh that sent
`If-None-Match` got **304** and kept showing Ch 35.

Two fixes, both required:

1. **`Cache-Control: no-store`** on `/api/queues`. `must-revalidate` made
   the *browser* attach If-None-Match on F5, so a full reload 304'd too.
   The JS `apiConditional` path still uses the ETag for SSE storms.
2. **Tab-focus / SSE reconnect / `refreshData` force a real GET.** Those
   are the moments the owner is looking at the grid after reading in
   Kavita. An SSE `data` tick (YAML/generation actually moved) stays
   conditional.

Launch (`GET /go/<set>`) was already live — it hits `continue-point` /
`orderedUnread` at that moment. The tile was the stale half.

## Context

The owner, 2026-08-16, on Bad Born Blood sitting at Ch 35 In Progress
after he marked Ch 35 and 62 read in Kavita (they had been left a few
pages short — a Kavita-side bug, later fixed; he finished them by hand):

> "I went ahead and marked them read, but they didn't update here nor
> did a refresh fix it. How is it syncing these?"

## Why

- **Kavita cannot push.** SignalR `UserProgressUpdate` is admin-only
  (`onlyAdmins` defaults true) and was deliberately not wired: it would
  load-bear on this account being admin. Progress is polled, and the
  only poll that existed was "whenever we rebuild the tile grid".
- **The ETag was honest about YAML and a lie about progress.** It was
  built for Plex, where MQTT now-playing bumps `generation` and busts
  the tag. Kavita never bumps it.
- **F5 was not a bypass.** `private, max-age=0, must-revalidate` is
  "always revalidate", which *sends* If-None-Match, which *is* the 304.

## Evidence

- Owner quote above, with a screenshot of Bad Born Blood at Ch 35 /
  In Progress after the chapters were marked read in Kavita.
- `/api/queues` ETag construction in `queuesRoutes.ts` (file mtimes +
  generation only). `refreshData` / `visibilitychange` used
  `apiConditional`.
- Kavita `tiles()` already called `series-detail` live — it just never
  ran on a 304.

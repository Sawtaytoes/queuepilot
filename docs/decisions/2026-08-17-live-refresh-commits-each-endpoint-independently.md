# A live refresh commits each endpoint independently, and a failed one retries

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** bug / architecture
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [2026-07-21-real-webapp-sse-yaml-not-sqlite](2026-07-21-real-webapp-sse-yaml-not-sqlite.md)

## Decision

**`liveRefresh()` no longer joins `/api/sets` and `/api/queues` in one `Promise.all` whose
result is committed together.** Each endpoint is fetched and committed on its own, and a
fetch that THROWS sets `livePending = true` so the existing 2 s timer comes back for it.

The undo/redo counters are re-read once, if either half actually committed.

## Context

The owner, 2026-08-17:

> "Don't we have SSE on QueuePilot? I'm wondering why, if I make a change on a tab, it
> doesn't get reflected on another tab. Like I removed 'Older Kids' from 'Shows', and the
> dropdown still shows 'Older Kids' in another tab. I thought we were syncing settings
> across tabs and devices without the need to refresh."

**The SSE machinery was fine.** Reproduced against a local server pointed at a copy of the
live config, two tabs in one browser: the `data` frame arrived in ~300 ms and the receiving
tab really did re-`GET` both endpoints. What was wrong was when the result became visible.

Measured on that server, warm cache, against the live library:

| endpoint | what it does | time |
| --- | --- | --- |
| `/api/sets` | reads `sets.yaml` | **~10 ms** |
| `/api/queues` | resolves every entry of every queue against Plex + Kavita | **7–9 s** |

Joined, the fast half waited for the slow one. Renaming a set in tab A and timing tab B:

- before — **6.9 s**
- after — **0.8 s**

## Why

- **The two endpoints answer different questions at different speeds.** `/api/sets` is the
  registry — labels, profile bindings, filters, everything the owner means by "a setting".
  `/api/queues` is *content*, and it is slow because it is doing real work against two
  backends. Gating the first on the second means a settings change is invisible for the
  length of a Plex round-trip, which is precisely the experience reported.
- **The failure mode was worse than the latency.** `livePending` is cleared at the top of
  `liveRefresh()`, and the retry timer only fires while it is set — so ONE thrown fetch
  (Plex asleep, Kavita restarting, a socket dropped on a phone) discarded both halves and
  left the tab stale **until the next SSE event or a tab focus**. A config edit produces
  exactly one `data` event, so for a second window sitting visible beside the first there
  was no next event and no focus change: it stayed wrong indefinitely. The old comment said
  *"the next event retries"*, and there was no next event.
- **The 304 path is untouched.** Conditional GET (B8 layer 1) still makes an SSE storm
  nearly free and still prevents a `now-playing` tick from clobbering an optimistic edit;
  it just applies per endpoint now. `/api/sets` sends no ETag, which is why it was always
  the cheap half and always the one worth committing early.
- **`uiBusy()` is still checked twice per endpoint** — before the fetch and after it — so a
  refresh still cannot land under an in-flight drag.

## Evidence

- Reproduction + timings, 2026-08-17, local server against a copy of
  `App-Configs/queuepilot/`: `/tmp/qp-sync-latency.mjs` (rename in tab A, wait for tab B).
- `curl -w %{time_total}` × 3 on each endpoint, warm cache.

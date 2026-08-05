# The editor is a real live webapp: SSE updates, no Refresh button, monorepo split; YAML stays (no SQLite)

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** Architecture
- **Supersedes:** —
- **Superseded by:** — *(clarified, not reversed, by
  [2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store](2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store.md):
  YAML remains the source of truth; SQLite enters strictly as a deletable cache of Plex reads.)*

## Decision

1. The web editor is a **live webapp**: the server pushes SSE (`/api/events`) whenever
   `queues.yaml`/`sets.yaml` change (any writer — another tab, the Python prune, an SMB
   hand-edit) or MQTT state lands; the UI re-fetches itself. The **Refresh button was
   removed**. Background refreshes defer while a drag/selection/menu is mid-flight and
   re-check after their fetch completes (rendering under a gesture corrupts it).
2. The monorepo is split **`server/`** (Node API + MQTT bridge, serves the frontend) +
   **`web/`** (static frontend) + **`queue_builder/`** (Python playback/MQTT engine).
   One container, two processes, unchanged.
3. **Storage stays YAML** (`queues.yaml` + `sets.yaml`), not SQLite. Hand-editability
   over SMB, comment-preserving round-trips, git-friendly diffs, and title-string
   entries (decision 2026-07-20-queue-entries-are-title-strings) are designed features;
   the data is tiny and the two writers already coordinate via the mkdir lock.
   Revisit only if real relational needs appear (multi-user, watch stats).
4. **Python keeps playback.** Porting `queue_builder` to Node was considered and
   declined for now: the cast stack (plexapi + pychromecast's PlexController for
   correct-account attribution) and PMS-log profile sniffing have no solid Node
   equivalent, and the physical-card path works today. If the user still wants a full
   JS port after living with the split, it is a contained follow-up.

## Context

Captured mid-session 2026-07-21 while the user drove the live editor and the agent
shipped queue CRUD + the sets registry.

## Why

Live updates + undo + CRUD make the web UI a first-class management surface (the user:
"I don't wanna only go to AI to manage this") without giving up the hand-edit paths.

## Evidence

User, 2026-07-21: "Do we wanna change these YAML files into a SQLite DB? … I feel like,
since you added a CRUD API, we should separate that in the Monorepo. Both can be the
same monorepo and same Docker container … `queue_builder/` Python … and then `web/` and
`server/`. That way, the server will work and auto-update when making changes without
having to manually click 'refresh'. We can then remove that button. We'd make this into
a real webapp, something I hadn't planned, but now I want it." (agent recommended
keeping YAML + Python playback; user did not object). Undo/redo: "It would also be good
to have undo/redo buttons as well when changes are made to the queue."

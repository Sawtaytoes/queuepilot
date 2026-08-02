# The queue config web UI is a Node.js app (like mux-magic), not embedded Flask

- **Status:** Accepted
- **Date:** 2026-07-20
- **Type:** reversal / stack
- **Amends:** [2026-07-16-config-web-app-embedded-in-plex-channels.md](2026-07-16-config-web-app-embedded-in-plex-channels.md)
  (keeps that decision's *intent* — a web editor for `queues.yaml` — but changes the stack +
  process model) and `docs/config-web-app-design.md` (Flask/embedded shape is superseded).
- **Superseded by:** —
- **Amended by:** [2026-07-20-queue-web-ui-monorepo-single-container.md](2026-07-20-queue-web-ui-monorepo-single-container.md)
  — the "separate app/container" preference below is REVERSED: it ships in the same repo +
  container as the Python service (monorepo, one image). The Node.js + mux-magic choice stands.

## Decision

The `queues.yaml` editor is a **Node.js** application modeled on **`mux-magic`**
(`/srv/repos/mux-magic`: its own repo, Dockerfile, TrueNAS custom-app deploy). It is
**not** the embedded Python/Flask thread inside the `plex-channels` container that
`config-web-app-design.md` and the 2026-07-16 embedded decision assumed.

- Preferred shape: a **separate app/container** that mounts the same
  `/srv/app-configs/plex-channels/queues.yaml` (rw) and edits it, keeping the Python
  MQTT service and the editor independent.
- Because the editor and the Python prune (`queues.prune`) now write the same file from **different
  processes**, the current in-process `threading` lock is insufficient: use an OS-level `flock` on
  `queues.yaml` in both writers (or funnel edits through the service). Resolve before shipping.
- Everything else in `config-web-app-design.md` (routes, per-section search, drag-to-reorder,
  proxy thumbs, Authelia at `plex-channels.example.com`) still holds.

## Context

The web UI was greenlit this session and handed to another agent. When the build was described as
"Flask editor inside the container," the user corrected the stack.

## Why

- **Matches the user's stack.** He builds Node.js apps; `mux-magic` was explicitly offered as the
  template. A Python/Flask editor would be an outlier he'd have to maintain against the grain.
- **Process isolation is cleaner** than bolting a Node runtime into the Python image, at the cost
  of a cross-process file-write lock (a solved problem via `flock`).

## Evidence

- User (chat 2026-07-20): *"I believe Flask is Python right? I do Node.js apps. Mux-Magic was
  supposed to be one of the 'here's an example'."*

# plex-channels — master roadmap / workstream index

The single index of everything in flight or planned, so any agent can pick up a stream
without re-deriving state. Each item points at its detail doc; this file is the map, not the
detail. Newest context first.

## A. Shipped — reliability (PR #6, merged `bb40d4e`, 2026-08-07)
The profile-gated cards ("open Plex but nothing plays") fix set:
- Placeholder-IP regression: real host values now resolve `env > /config/config.yaml >
  placeholder`, keeping real IPs out of the public image. (`config._hostval`)
- `adb.ensure_plex_open()` — launch Plex over ADB (`plex://`) at the top of a scan; HA's app
  link was silently failing so Plex stayed closed.
- Join the ADB profile switch before `playMedia` so **play is the last action** (no more
  "started then backed out").
- Detail: `playback-state-machine-design.md`; private incident:
  `agentic/plex-channels-private/docs/2026-08-06-sanitized-placeholder-ips-broke-profile-gated-cards.md`.

## B. Planned — queue lifecycle + playback FSM (PR #7, `feat/queue-lifecycle-fsm`)
Detail: `queue-and-playback-roadmap.md` + `playback-state-machine-design.md`.
1. **Playback state machine** — sample device/Plex/profile/now-playing state → verified,
   retried transitions to `playing`, replacing the fire-and-forget sequence that errors with
   no retry. *(owner's framing)*
2. **Resume-in-queue** — a partially-watched *queued* item resumes from its `viewOffset` on the
   next scan (queued items only), instead of restarting or advancing.
3. **TTL auto-remove of completed entries** — today `done: true` entries are kept forever
   (manual-× only; decision `2026-07-21-finished-entries-marked-done-not-pruned`). Add a
   `done_at` stamp + a sweep that prunes after `remove_completed_after` (global default, per-set
   override; propose 24h). Playlist/reel queues exempt.
4. **Non-consuming / playlist queue flag** — an explicit `keep_completed`/`consume:false`,
   decoupled from `reel` (which also plays the whole lineup every scan). **Open decision:** demo
   reel = play-all-every-scan (current `reel`) or one-per-scan loop? See roadmap doc.
5. **SSE now-playing re-sync on reconnect** — server emits the current now-playing snapshot on a
   new `/api/events` connection; client refetches `/api/now` on `visibilitychange`/reopen. Fixes
   the phone showing a stale tile after the tab sleeps.

## C. Node port / Python removal — D3 through live adapter landed
Plan: `decisions/2026-08-03-retiring-python-except-the-cast-sidecar.md`.
Status: `handoff-python-port-status.md` (start there).
- **D1–D3 done** (routing, selection engine, curated resolve, rotation, **live undici client**,
  `ENGINE=node` preview dual-run + divergence log). Default still `ENGINE=python`.
- **D4–D7 code landed** (`PLAYBACK_ENGINE=node` path: mqttd + session + adb + playback + driver +
  cast_sidecar). **Next:** live soak of node playback on the Shield; full `queue_builder/`
  deletion (D8 remainder) after that soak.
- **Phase E** — file-lock swap; rides with D8.
- **F6** — `app.css` `@layer` reorder: `decisions/2026-08-03-app-css-layer-fix-is-a-separate-screenshot-gated-change.md`.
- **DB / SQLite cache** — shipped (`cache.js`, derived Plex cache only:
  `decisions/2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store.md`). Deletable:
  `rm /config/cache.sqlite*`.

## B′. Shipped — queue lifecycle + playback FSM (was roadmap B)
All merged on `main`: SSE re-sync (#9), TTL (#10), resume-in-queue (#11), `keep_completed` (#8),
Set-editor flags (#36), FSM driver (#15 + #20). **`PLAYBACK_FSM` still defaults off** — enable
and soak on the real Shield to finish that track.

### Scan-regression suspects (for whoever debugs a scan issue)
Per the port handoff: the Python scan path (`queue_builder/`) was **not** touched by the port
commit, so a scan regression more likely came from Node 24→26 (#4), the `@charcuterie/ui` 2.x
cross, or config — or (web-UI symptoms like wrong next-up/stale tiles) the live `cache.js` +
undici rewrite. The reliability set in §A is the confirmed 2026-08-06/07 fix for the
"nothing plays" symptom specifically.

## Shared spec for the parallel §B PRs (so agents stay consistent)
One agent per feature, each in its **own `git worktree` + branch off `main`**, each opening its
**own PR** (CI must be green). Agents implement + unit-test + open the PR; they do **NOT** touch
the live app/Shield (live verification is the orchestrator's, on the real TV). Locked choices so
overlapping edits agree:
- New per-set keys in `sets.yaml` (+ `config.py` `_load_sets_yaml`/cfg): `remove_completed_after`
  (duration string like `24h`/`7d`, `0`/`never` disables; **global default 24h**),
  `keep_completed: true` (never mark-done/sweep; implied by `reel`).
- Queue-entry field: `done_at` (epoch seconds) written next to `done: true` in `mark_done`.
- Node mirror parity: any `queue_builder/queues.py` change gets the same in `web/src/queues.js`.
- Merge order (couple on `queues.py`): SSE (independent) → TTL → resume → playlist. Rebase later
  ones after each merge; flag conflicts to the orchestrator rather than guessing.

## Deploy state
App image currently `docker-registry.example.com/plex-channels:latest` (locally built, = merged
§A code). ghcr rebuilt from the #6 merge (`ghcr.io/sawtaytoes/plex-channels:latest`, Docker
Deploy run success). **TODO: repoint the app image back to ghcr + redeploy** to end the
registry drift (per `decisions/2026-08-02-ci-and-deploy-on-github-actions-to-ghcr.md`).

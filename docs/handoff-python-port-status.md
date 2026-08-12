# Handoff — Python → Node port (Phase D) status

> **CLOSED 2026-08-12. The port is finished and `queue_builder/` is deleted** — see
> [docs/decisions/2026-08-12-python-is-gone-except-the-cast-sidecar.md](decisions/2026-08-12-python-is-gone-except-the-cast-sidecar.md).
> Node is the only implementation; `cast_sidecar/` is the only Python left. The `ENGINE` and
> `PLAYBACK_ENGINE` switches no longer exist. The parity gates live on against the deleted
> engine's recorded answers in `e2e/fixtures/golden/` (see `e2e/fixtures/README.md`), and the
> Python-only engine tests were ported to `.mjs` 1:1.
>
> Everything below is kept as the HISTORY of how the port ran — phase order, blockers, and the
> acceptance bars each phase had to clear. It is no longer a to-do list, and any instruction in
> it to run `python -m queue_builder.…` is now unrunnable.

**As of 2026-08-03.** Companion to
[docs/decisions/2026-08-03-retiring-python-except-the-cast-sidecar.md](decisions/2026-08-03-retiring-python-except-the-cast-sidecar.md),
which is the plan. This file records what is DONE and what each remaining phase is blocked on,
so the port can resume without re-deriving the state.

---

## Resume — 2026-08-07 (start here for D2+)

Re-checked against `origin/main` today. **The port is still parked at D1**: `ENGINE` and
`PLAYBACK_ENGINE` both default `python` (`server/src/env.js`), `queue_builder/` still ships and
runs live (the Dockerfile still builds a Python venv and runs `queue_builder.service`), and only
D1 (`server/src/profiles.js`) is ported as dead-but-correct code behind the switch. Nothing below
D1 has been done. The 2026-08-03 blocker table below is still the map — but **two of its blockers
have dissolved**, which reopens D2 (and the D2/D4 gates):

1. **`ruamel` is no longer a blocker for the parity gates.** `ruamel.yaml` is in
   `requirements.txt`, and CI now installs it (`.github/workflows/ci.yml` → "Install Python deps"
   → `pip install -r requirements.txt`), so any gate that shells `python -m queue_builder.cli
   route …` runs in CI. Locally, `pip install -r requirements.txt` (or just `pip install
   ruamel.yaml`) makes it importable in the sandbox too — the 2026-08-03 "this environment has no
   ruamel" note was a not-installed state, not a hard wall.
2. **Live Plex IS reachable from the sandbox.** The root `.env` has `PLEX_API_SERVER_URL` +
   `PLEX_API_KEY`; this session read live watch-state through them (e.g. `GET
   /library/metadata/<rk>`). So D3's "controlled live-Plex access" for corpus recording is
   available here — what's genuinely missing for D3 is (a) the `PLEX_RECORD_DIR` shim, which does
   **not** exist yet (`grep -r PLEX_RECORD queue_builder` is empty), and (b) the one-week
   dual-engine soak, a calendar constraint, not an access one.

**CI exists now** (workflow name must stay `"CI"` — `docker-deploy.yml` keys off it). It runs:
server `npm ci` + `node --check`, web typecheck/unit/build, `pip install -r requirements.txt`,
Python parse+import smoke, the Python engine tests, and the browserless node e2e. Browser
(Playwright) e2e is gated on the `PLEX_TOKEN` secret. **Any new parity gate must be added to a CI
step to actually guard the port.**

### D2 — LANDED (2026-08-07)

The four read-side functions are ported into **`server/src/engine/routing.js`**
(`bindingFor` / `channelFor` / `setSections` / `rewatchSections`), together with the
routing-relevant slice of `config._load_sets_yaml`'s normalization they read (on-disk
`sections` → `episodic_sections`, the `_binding_from` coercions, `has_explicit_profiles` /
`superseded_by` guards). It is dead-but-correct behind `ENGINE=node`; the default `python` path
is untouched.

- **Consumer seam:** `GET /api/generic/:id/preview` calls `engineRouting.forSet(id, profile)`
  **only when `ENGINE=node`** and attaches it to the response as `routing` (additive — the pool
  is still Python until D3). A startup log announces the mode. This is the seam D3 fills.
- **Parity gate:** `e2e/binding-parity.mjs` diffs the Node port against the Python oracle —
  `python -m queue_builder.cli route <kind> <title>` (channel/binding) and the new
  `python -m queue_builder.cli sections` subcommand (section pools) — over
  `e2e/fixtures/routing.sets.yaml`, which covers every branch: the `enabled`/`superseded_by`
  guards (two decoy channels ahead of the real ones), explicit-`profiles[]` progress vs rewatch,
  empty-`sections` shorts, legacy single-binding + `PROFILE_SET_MAP` fallback, `NO MAPPING`, and
  queue/reel pools. It is a **required CI step** ("D2 routing parity"). Green as of this commit.
- **Gotcha for the next agent:** `set_sections`/`rewatch_sections` aren't printed by `route`, so
  the gate uses the added `sections` subcommand (it calls the real `config` functions, so it can
  never drift). Run locally with `PYTHONPATH=/tmp/pylibs:. node e2e/binding-parity.mjs` after a
  `pip install --target /tmp/pylibs ruamel.yaml` (the sandbox venv is read-only).

**Next: D3.** D2's `forSet` seam is where the ported selection engine plugs in.

### D3 — LANDED through live adapter (2026-08-08); soak remaining

Done and CI-gated:
- **Corpus record/replay oracle** (`PLEX_RECORD_DIR`/`PLEX_REPLAY_DIR` in `plex.py`,
  `e2e/record-corpus.sh`) — see `docs/d3-engine-parity-corpus.md`. Proven byte-identical offline.
- **Engine core (unwatched-buckets pool)** — `server/src/engine/select.js` ports the
  DETERMINISTIC pool (`_watched_for_set`, `episodic_shows`, `section_items`, `show_episodes`,
  `_rating_ok`, `_int0`, `_at_or_after_start`, `_multi_season`, `unwatched_buckets`).
  `server/src/engine/plex-replay.js` is the Node corpus client.
- **Rewatch pool (movie-card counts)** — `rewatch_counts` + `section_kind`/`_movie_films`/
  `_show_films` ported to `select.js`. The weighted `1/n²` PICK is rng → per-language seeded test.
- **Collection-expansion blocklist (follow-on #1, LANDED 2026-08-07)** — `find_collection`,
  `collection_children`, and `_expanded_blocklist` ported to `select.js`, so a `blocklist` entry
  may be a bare ratingKey OR a `"Collection: <name>"` string that expands (searched across the
  set's sections, first match wins) to every member's ratingKey — `episodic_shows`/`section_items`
  then drop the whole collection. Unresolvable names/corpus misses are swallowed (never crash a
  scan), matching Python's `except`. The synthetic corpus now carries a `Blocked Toons` collection
  (section 5 → Epsilon) and a bare-ratingKey block (Zeta); the gate diffs both away.
- **Curated resolver + reel (follow-on #2, LANDED 2026-08-07)** — new module
  **`server/src/engine/resolve.js`** ports the whole read-side that turns a set's `queues.yaml`
  entries into play items: descriptor parsing (`parse_title_string`/`entry_key`/`_describe` +
  `queues.entries`), the **title→ratingKey resolver** (`_resolve_title`/`resolve_queue_entry`/
  `item_type`/`item_view_state`/`resume_offset`/`_head_resume_offset`/`_match_guid_hint`), member
  resolution (`collection_items`/`resolve_member` + `_keep_episode`/`is_extra_or_promo`/
  `_has_real_seasons`/`_in_progress`), and the play-list builders **`build_reel`** (pure) and
  **`next_queue`**'s deterministic classify+order core. **NOT** ported: next_queue's YAML side
  effects (`mark_done`/`clear_done`/`sweep_completed`) — that write-side is **D4**; the Node
  `nextQueue` returns the same dict but persists nothing yet. The anime-channel branch shuffles via
  an injected `rng` (like `build_rotation`), so parity covers the deterministic non-anime queue.
  `select.js` now exports its shared pure helpers (`int0`/`atOrAfterStart`/`multiSeason`/
  `showEpisodes`/`findCollection`/`collectionChildren`) for reuse.
- **Gate:** **`e2e/engine-parity.mjs`** (required CI step "D3 engine parity") diffs both against
  `python -m queue_builder.cli buckets|rewatch-counts` over a **synthetic** corpus regenerated by
  `e2e/gen-synthetic-corpus.py` (owner decision 2026-08-07). Green: `Younger` Alpha[11,13,14,15]/
  Delta[42,43]/Shorts[1501,1502] + MovieA×2/MovieC×1; `Older` Beta[22] + MovieB×3 — exercising
  watched-drop, rating cap, start floor, specials kept, per-account views, rewatch view counts,
  and both blocklist branches (Epsilon/Zeta dropped; a negated-expansion run confirms the gate
  fails without the port).
- **Gate (follow-on #2):** **`e2e/curated-parity.mjs`** (required CI step "D3 curated parity")
  diffs `resolve.js` against `python -m queue_builder.cli next-queue-json bobq` (the real
  `next_queue`, run on a throwaway copy so its mark-done side effect can't skew the read) and
  `reel-json demo` (the real `build_reel`), over the same synthetic corpus (now carrying a `bobq`
  QUEUE + `demo` REEL in `engine.queues.yaml`, a `Queue Picks` collection, title-search results,
  and admin/Bob history). It covers a title-string movie, a ratingKey show (S0 specials dropped by
  keep_episode), a collection member (watched-filtered in the queue, watched-ignored in the reel),
  an UNRESOLVED title, an already-`done` entry, and a fully-watched movie (newly finished). Green:
  `bobq` play=[2001] done=[2002, Movie C] unresolved=[No Such Title] remaining=4; `demo`
  play=[2001,41,2002,2003]. A negated watched-drop confirms the gate fails without the port.
- **Rotation wiring (follow-on #3, LANDED 2026-08-07)** — new module
  **`server/src/engine/rotation.js`** ports `_watched_all`, `member_descs`, `member_buckets`,
  `channel_buckets`, and `build_rotation`. It combines the dynamic rule pool (`unwatchedBuckets`)
  with a channel's explicit `members:` (resolved through `resolve.js` `resolveMember`, reusing
  follow-on #2) into ONE deduped pool (members win), then interleaves it round-robin. `members` is
  now carried onto the Node rotation cfg (`routing.js`) and `iterHistory` is exported from
  `select.js` for `_watched_all`'s no-section scan. The `build_rotation` shuffle+round-robin is rng
  (injected, like next_queue's anime branch), so parity compares the pre-shuffle pool
  (`channelBuckets`), not the interleave.
- **Gate (follow-on #3):** the "D3 engine parity" step now also diffs `channelBuckets` against
  `python -m queue_builder.cli channel-buckets-json kidsplus Younger`. The synthetic corpus adds a
  `kidsplus` channel (rule sections [5] + `members: [1001, 2002]`) exercising member/rule **dedup**
  (member Alpha wins over the rule's Alpha, with a *different* episode list — [11,13] vs the rule's
  [11,13,14,15] — proving the member path applied `keep_episode`+`_watched_all`), a movie member
  **outside** the pool (Movie B, resolved by ratingKey), and the additive combine. Green: `kidsplus
  × Younger` = Alpha[11,13] MovieB[2002] Delta[41,42,43] Epsilon[51] Zeta[61]. A negated dedup
  confirms the gate fails without the port.

- **Live client adapter (follow-on #4, LANDED 2026-08-08)** — engine modules are **async**
  (`await client.container` / `await client.accountToken`) so both the sync corpus replay client
  and the undici live client work. New modules:
  - `server/src/engine/plex-live.js` — `liveClient()` reuses `plex.plexGet` + `plex.accountToken`
  - `server/src/engine/preview.js` — `previewRotation` / `formatBuckets` / divergence signatures
  - `GET /api/generic/:id/preview` behind `ENGINE=node` **serves the Node pool**, keeps Python's
    payload under `python:`, sets `divergence`, logs `[engine] DIVERGENCE …` or a match line, and
    falls back to Python if Node throws. Default `ENGINE=python` is unchanged.
  - Gate: `e2e/live-client-adapter-test.mjs` (required CI step) — async surface over the synthetic
    corpus + formatter/signature checks (no live Plex in CI). Live undici smoke verified against
    the LAN Plex (`/library/sections`).

**Still to port (follow-on PRs), in order:**
1. **One-week dual-engine soak** — set `ENGINE=node` on the deployed app, watch
   `[engine] DIVERGENCE` lines (and Channels view), then cut over. Calendar constraint.
2. **D4** — `queues.py` write-side (`mark_done` / `clear_done` / `sweep_completed`) so Node can
   persist finished curated entries (read-side already in `resolve.js`).
3. **D5–D8** — `adb.js`, MQTT service, Node playback + cast sidecar, then delete Python. D5/D7
   need the Shield; D8 is last. See the table and the decision doc for each bar.

### What actually runs live vs. what is inert (read this first if you're debugging behavior)

`ENGINE=python` (the default) gates the *ported selection/playback engine*. It does **NOT** gate
several changes from the Phase-D commit (`52f7c9b`, now on `main`) that run on every request
regardless of `ENGINE`. If live behavior changed, look here, not at the (inert) port modules:

- **`queue_builder/` (the Python scan/prune) was NOT touched by the port commit** — `git show
  --stat 52f7c9b` lists no `queue_builder/*` file. So a *Python scan* regression is not from this
  work (more likely Node 24→26 in `#4`, the `@charcuterie/ui` 2.x cross, or config/env).
- **`server/src/plex.js` `plexGet` was rewritten onto undici** (keepalive `Agent`, retry on
  network/5xx, single-flight, `connect.rejectUnauthorized:false`). This is **not gated** and
  changes *every* Node→Plex HTTP call (search, resolve, previews, `/api/queues`, posters). First
  suspect for any Node-side Plex behavior change.
- **`server/src/cache.js` opens `/config/cache.sqlite` at boot** and now backs `resolveTitle` /
  `allLeaves` / `collectionChildren`. **Not gated.** It is deletable (`rm /config/cache.sqlite*`)
  and schema-wiped on version mismatch. Invalidations: MQTT now-playing drops the show's `leaves`
  row + bumps generation; `updateSet` drops section listings + bumps generation; and as of
  `2026-08-07-leaves-cache-revalidates-on-read` (#24) `allLeaves` re-validates a show's leaves
  against its live `(updatedAt, viewedLeafCount)` on read, so a watch finished OUTSIDE the app's
  flow self-heals the next-up instead of going stale for up to the 24 h TTL.
- **`server/src/server.js`**: compression + pre-compressed static + cache headers + `/api/shelves`
  + ETag/304 on `/api/queues`. **Not gated.** Web-UI only, not the scan.
- **`queues.js` / `sets.js`**: mtime-keyed memoization of `listAll()` / registry, and
  `setKeepingComment`. **Not gated**, but a Python write to the YAML changes mtime so the memo
  busts correctly.
- **Inert until `ENGINE=node` (or `PLAYBACK_ENGINE=node`)**: `profiles.js` (playback path)
  and the engine modules for scan/play. **Exception:** with `ENGINE=node`, the preview
  endpoint runs `engine/preview.js` live (dual-run vs Python). Default stays `python`.

Net: the scan pipeline is unchanged; the live-affecting surfaces are all Node-web-server-side,
undici `plexGet` and the SQLite cache being the two worth checking first.

---

## Done

- **`server/src/env.js`** — every runtime knob from `queue_builder/config.py`, one place, Python
  defaults reproduced verbatim, so both halves read env identically during the overlap. Includes
  the `ENGINE` / `PLAYBACK_ENGINE` switches (default `python`) each phase ships behind.
- **D1 — `server/src/profiles.js`** — full port of `profiles.py` (PMS-log profile detection:
  `waitForProfile`, `setForProfile`, `LAST_SEEN`). Verified offline by `e2e/profile-gate-test.mjs`
  against a synthetic growing-log fixture: first-signed-in wins, `match` skips the wrong profile
  until the switch, timeout→null, truncation survived, other-IP ignored. **This module is not yet
  wired into anything** — it activates when playback goes Node (D7). It is dead-but-correct code
  behind the switch until then.
- **D2 — `server/src/engine/routing.js`** — full port of the `set:"auto"` routing read-side
  (`binding_for` / `channel_for` / `set_sections` / `rewatch_sections` + the normalization they
  read). Consumed by `/api/generic/:id/preview` behind `ENGINE=node`; verified byte-for-byte
  against the Python oracle by `e2e/binding-parity.mjs` (required CI step). Details in the
  "D2 — LANDED" section above.

## Blocked here, and on what

The rest of Phase D cannot be completed in a headless dev sandbox. The blockers are concrete:

| Phase | What it is | Blocked on |
|---|---|---|
| ~~D2~~ | ~~`config.py` read-side (`binding_for`, `channel_for`, `set_sections`, `rewatch_sections`)~~ | **DONE 2026-08-07** — `server/src/engine/routing.js`, gated `ENGINE=node`, parity-gated in CI (`e2e/binding-parity.mjs`). See the "D2 — LANDED" section above. |
| ~~D3~~ | ~~Selection engine + live preview adapter~~ | **DONE 2026-08-08** through follow-on #4 (async engine, `plex-live.js`, preview dual-run). Remaining: calendar soak with `ENGINE=node`. |
| D4 | `queues.py` **write-side** (`mark_done`/`clear_done`/`sweep_completed` YAML round-trip). Descriptor normalization (`_describe`/`entries`) is already ported read-side in `resolve.js` (follow-on #2). | Small; portable. Gate is a byte-compare against a ruamel-written file — same `ruamel` blocker as D2 for the *comparison*, though `e2e/yaml-roundtrip-test.mjs` (shipped) already covers Node-writer comment fidelity. This is what makes the ported `nextQueue` actually persist finished entries. |
| D5 | `adb.py` → `adb.js` | The XML-fixture unit test is portable, but acceptance is **a manual checklist against the real Shield** (`ADB_ENABLED`, a profile switch on a gated card). Needs the physical TV. |
| D6 | MQTT service → `mqttd.js` | Portable against `e2e/fake-mqtt.mjs`, but it is the load-bearing playback path; sequencing it before D3/D7 soak would be reckless. |
| D7 | Playback minus cast + the `cast_sidecar/` | Acceptance is **the watch landing on the right profile's history** on the real Shield, outside family hours, ~20 successful family plays before further change. Needs the TV and calendar time. |
| D8 | Deletions (`queue_builder/`, CI steps, Dockerfile, `requirements.txt`→2 deps) + the storage lock swap | Only safe once D3–D7 have soaked and Python is actually removable. The Phase E lock→optimistic-concurrency change rides here (see the decision doc). |

## D4–D8 — LANDED (code, 2026-08-10)

| Phase | What shipped |
| --- | --- |
| **D4** | `queues.markDone` / `clearDone` (+ existing `sweepCompleted`); `e2e/mark-done-parity.mjs` CI gate. `nextQueue` returns `newlyDone` keys the session path persists. |
| **D5** | `server/src/adb.js` full port of `adb.py`; `e2e/adb-unit-test.mjs` pure helpers. |
| **D6** | `server/src/mqttd.js` — MQTT session/start, advance, preview, devices, discovery, state when `PLAYBACK_ENGINE=node`. |
| **D7** | `server/src/session.js` (selection + D4 writes + play), `playback.js` (client mode), `driver.js` (PLAYBACK_FSM). Cast delegated via MQTT to the sidecar. |
| **D8 (partial)** | `cast_sidecar/` (pychromecast-only process); dual `entrypoint.sh` (`PLAYBACK_ENGINE=node` → web+mqttd+cast_sidecar; `python` → historic full service). **`queue_builder/` retained** for CI parity oracles + `PLAYBACK_ENGINE=python` rollback — full deletion waits on live soak of node playback. |

**Live cutover:** set app env `PLAYBACK_ENGINE=node` (with `ENGINE=node` + `PLAYBACK_FSM=true` already on). Flip back to `python` if a session path regresses.

## Recommended resume order

1. **Soak (STARTED 2026-08-10):** live app runs `ENGINE=node` + `PLAYBACK_FSM=true` on
   `ghcr.io/sawtaytoes/plex-channels:latest` (#34 + #41). Dual-run samples match
   (`shows`/`shows_shorts`/`movies` for both kid profiles — no real DIVERGENCE after the
   Shorts-`next` signature fix). Watch container logs for `[engine] DIVERGENCE` for ~a week.
   Flip back with `ENGINE=python` on the app env if needed.
2. **D4** write-side queue persistence, then **D6** MQTT, then **D7** playback (+ cast sidecar)
   with real-TV acceptance outside family hours.
3. **D5** ADB port + Shield checklist can parallel D6/D7 once TV time exists.
4. **D8** last — delete `queue_builder/`, shrink deps, storage lock → optimistic concurrency.

Nothing above changes the shipped Phases 0/A/B/C1/E/F, which are engine-independent.

## Also shipped (parallel track, not the port)

Queue lifecycle + playback FSM on `main` (roadmap B): SSE re-sync, TTL, resume-in-queue,
`keep_completed`, `PLAYBACK_FSM` driver (default **off** until Shield soak). SQLite is a
derived Plex cache only (`cache.sqlite`) — YAML stays the store.

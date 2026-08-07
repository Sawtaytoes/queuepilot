# Handoff — Python → Node port (Phase D) status

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

### D2 is fully actionable now (no live Plex, no soak)

The four read-side functions to port live in `queue_builder/config.py`:
`binding_for` (:223), `channel_for` (:240), `set_sections` (:438), `rewatch_sections` (:443).
They are pure config/YAML logic — no Plex. `server/src/config.js` already holds the Node read
side; extend it there.

- **Reference behaviour:** `python -m queue_builder.cli route <args>` (the `route` subcommand,
  `queue_builder/cli.py` `main` → `_route`). It resolves a `set:"auto"` + profile to a channel and
  its sections/binding — exactly what these four functions decide.
- **The gate does not exist yet — write it.** `e2e/binding-parity.mjs` (referenced in the table
  below as if it existed; it does not) must diff the Node port against `python -m queue_builder.cli
  route` over a fixture `sets.yaml` that covers every set × binding × behaviour (progress/rewatch,
  explicit-`profiles[]` vs legacy single-binding, `set:auto` for each tier, a Shorts-only channel
  with empty `sections`). Add it to CI (a Python-present step, since it shells the CLI).
- **Wire behind `ENGINE=node`** with the preview endpoint as the only consumer, logging any
  divergence — same shape the plan prescribes for D3. D2 landing this way is what unblocks D3's
  consumer wiring.

**Recommended first task for the next agent: land D2 end-to-end** (port the four fns + write
`binding-parity.mjs` + green in CI). It is the only phase with zero live/soak dependencies.

### D3+ (shape unchanged; access caveat updated)

Build the `PLEX_RECORD_DIR` recording shim in `cli.py`/`plex.py`, record a corpus off live Plex
(doable from the sandbox now), then port the selection engine (~1,200 lines) with a
**to-be-written** `e2e/engine-parity.mjs`, then the one-week soak behind `ENGINE=node` on the
preview endpoint before anything plays from it. D5 (`adb.js`) needs the real Shield; D6
(`mqttd.js`) is portable but load-bearing; D7 (playback + `cast_sidecar/`) needs the TV + a
family-hours soak; D8 (deletions + the lock→optimistic-concurrency swap) is last. See the table
and the decision doc for the acceptance bar on each.

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
- **Inert until `ENGINE=node` (or `PLAYBACK_ENGINE=node`)**: `profiles.js` and every future
  `server/src/engine/*`. Not wired to anything yet.

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

## Blocked here, and on what

The rest of Phase D cannot be completed in a headless dev sandbox. The blockers are concrete:

| Phase | What it is | Blocked on |
|---|---|---|
| D2 | `config.py` read-side gaps (`binding_for`, `channel_for`, `set_sections`, `rewatch_sections`) | The parity test (`e2e/binding-parity.mjs`) diffs against `python -m queue_builder.cli route`, and **this environment has no `ruamel`** — the Python can't even load `sets.yaml` (`No module named 'ruamel'`). The functions are portable; the *parity gate* the plan requires is not runnable here. |
| D3 | The selection engine (~1,200 lines) + `e2e/engine-parity.mjs` | The harness needs a **recorded Plex corpus** produced by running the real `cli.py` (with the `PLEX_RECORD_DIR` shim) against the live config — needs `ruamel` + controlled live-Plex access — **plus a one-week dual-engine soak with divergence logging** before anything plays from it. Neither the corpus nor the soak is producible in one session. |
| D4 | `queues.py` gaps (`mark_done`, descriptor normalization) | Small; portable. Gate is a byte-compare against a ruamel-written file — same `ruamel` blocker as D2 for the *comparison*, though `e2e/yaml-roundtrip-test.mjs` (shipped) already covers Node-writer comment fidelity. |
| D5 | `adb.py` → `adb.js` | The XML-fixture unit test is portable, but acceptance is **a manual checklist against the real Shield** (`ADB_ENABLED`, a profile switch on a gated card). Needs the physical TV. |
| D6 | MQTT service → `mqttd.js` | Portable against `e2e/fake-mqtt.mjs`, but it is the load-bearing playback path; sequencing it before D3/D7 soak would be reckless. |
| D7 | Playback minus cast + the `cast_sidecar/` | Acceptance is **the watch landing on the right profile's history** on the real Shield, outside family hours, ~20 successful family plays before further change. Needs the TV and calendar time. |
| D8 | Deletions (`queue_builder/`, CI steps, Dockerfile, `requirements.txt`→2 deps) + the storage lock swap | Only safe once D3–D7 have soaked and Python is actually removable. The Phase E lock→optimistic-concurrency change rides here (see the decision doc). |

## Recommended resume order

1. On a box **with `ruamel` and the live config**: run `cli.py` under the `PLEX_RECORD_DIR`
   recording shim across every set/binding/behaviour to produce the corpus. That corpus is the
   thing that unblocks D2 and D3's offline parity.
2. D2, then D3 behind `ENGINE=node`, with the preview endpoint as its only consumer, logging
   divergence for a week.
3. D4, D6, then D7 with the sidecar, soaking on the real TV.
4. D8 last, including the storage lock swap.

Nothing above changes the shipped Phases 0/A/B/C1/E/F, which are engine-independent.

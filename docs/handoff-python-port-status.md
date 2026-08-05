# Handoff — Python → Node port (Phase D) status

**As of 2026-08-03.** Companion to
[docs/decisions/2026-08-03-retiring-python-except-the-cast-sidecar.md](decisions/2026-08-03-retiring-python-except-the-cast-sidecar.md),
which is the plan. This file records what is DONE and what each remaining phase is blocked on,
so the port can resume without re-deriving the state.

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

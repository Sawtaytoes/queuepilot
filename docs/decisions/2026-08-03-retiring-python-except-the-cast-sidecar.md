# Retire `queue_builder/` to Node — keep a minimal Python cast sidecar

- **Status:** Accepted
- **Date:** 2026-08-03
- **Type:** architecture / scope
- **Supersedes (in part):** [2026-07-21-defer-python-to-node-port](2026-07-21-defer-python-to-node-port.md)
- **Superseded by:** — (not superseded; **completed** by [2026-08-12 — Python is deleted, except the cast sidecar](2026-08-12-python-is-gone-except-the-cast-sidecar.md))

## Decision

Port `queue_builder/` (3,865 lines) to Node, phase by phase, and delete it — **except** for
Google-Cast playback, which survives as a new `cast_sidecar/` (~250 lines, `paho-mqtt` +
`PyChromecast` only). The sidecar subscribes to one topic, `plex-channels/cmd/cast/play`, and
replies on `plex-channels/resp/cast`.

MQTT itself **stays**. Home Assistant's automations, the retained device registry and the
discovery sensor are real external consumers. What goes away is the *internal* round trip:
`/api/play` will call `startSession()` in-process instead of publishing a command to a second
process in the same container and waiting for it.

## Context

`docs/decisions/2026-07-21-defer-python-to-node-port.md` deferred this port. Its stated blocker
was: *"reimplementing Plex Cast + account-token minting is high-risk in the one area that must
never break for the family."*

Half of that blocker is already gone. **Account-token minting is ported** — `server/src/plex.js:48`
(`accountToken`) does the plex.tv `home/users/<uuid>/switch` → `/api/v2/resources` exchange and
has been in production use for the per-account ratings facet. The remaining half, casting to
the Shield as each account's token, is preserved rather than reimplemented.

Two further facts changed the calculus:

- **~2,400 of the 3,865 lines have no Node equivalent** — the whole selection engine, the MQTT
  service, playback, ADB, and profile detection. They are not duplicated work; they are the
  reason the interesting logic is invisible from the web app's side.
- **The MQTT round trip is itself the performance problem.** "Eligible pool — first load can
  take a minute" is `mqttc.preview()` waiting on `unwatched_buckets`, which issues **one
  `/allLeaves` per show, strictly sequentially**. Once the engine is in Node, the preview
  endpoint calls it directly and the N+1 collapses (the section listing already carries
  `leafCount`/`viewedLeafCount`, so most shows need no `allLeaves` call at all).

## Phasing

Each phase is independently shippable and revertible, behind a switch (`ENGINE`,
`PLAYBACK_ENGINE`) defaulting to the Python path until soak passes.

| Phase | Scope | Gate |
|---|---|---|
| D1 | `profiles.py` → `server/src/profiles.js` | `e2e/profile-gate-test.mjs` vs the Python on one recorded log fixture |
| D2 | `config.py` read-side gaps (`binding_for`, `channel_for`, `set_sections`, `rewatch_sections`) | `e2e/binding-parity.mjs` vs `python -m queue_builder.cli route` |
| D3 | The selection engine (~1,200 lines) → `server/src/engine/` | `e2e/engine-parity.mjs` against a **recorded Plex corpus**; one-week dual-engine soak with divergence logging |
| D4 | `queues.py` gaps (`mark_done`, descriptor normalization) | `e2e/api-v2-test.mjs` + a YAML byte-compare |
| D5 | `adb.py` → `server/src/adb.js` | recorded `uiautomator dump` fixture + a manual Shield checklist |
| D6 | The MQTT service → `server/src/mqttd.js` | `e2e/fake-mqtt.mjs` retained-topic assertions + the discovery-config byte-compare |
| D7 | Playback minus casting; `cast_sidecar/` created | a live cast smoke — acceptance is **the watch landing on the right profile's history** |
| D8 | Deletions (`queue_builder/`, CI steps, Dockerfile, `requirements.txt` → 2 deps) | full suite |

D3 ships **read-only**, with `/api/generic/:id/preview` as its first and only consumer, before
anything plays from it.

### Storage lock change is gated on D8

The `queues.js`/`sets.js` `mkdir` lock is a **cross-process** lock the Python prune also takes.
Replacing it with an in-process promise chain + optimistic concurrency (Phase E) is only safe
once Python is gone — until D8 removes the prune, the lock is still coordinating two live
writers. So Phase E ships in two parts: the `e2e/yaml-roundtrip-test.mjs` comment-preservation
gate lands **now** (it is writer-agnostic and valuable immediately), and the lock replacement
lands **with D8**. The round-trip test already surfaced and fixed one real regression — an
inline `label:` comment lost on `updateSet` (`setKeepingComment` in `sets.js`).

## Why the sidecar survives

`pychromecast`'s `PlexController` is the only reference implementation of the Plex Chromecast
receiver protocol (`urn:x-cast:com.plexapp.chromecast`) that is known to work. Two properties of
`playback.py` are load-bearing and easy to lose in a rewrite:

- **The module-global `_ACTIVE` cast/browser references.** Dropping the socket stops the
  receiver. Whatever holds the connection must keep holding it after LOAD, plus the heartbeat.
- **Casting as the account's own token**, which is what puts the kids' watches on the right
  profile. Companion/`client` mode was considered and **rejected**: it loses per-profile
  attribution, which is the entire point.

`requirements.txt` shrinks from 4 dependencies to 2 (`paho-mqtt`, `PyChromecast`); `plexapi`
and `ruamel.yaml` go. `entrypoint.sh` keeps its two-process `wait -n` supervision, with the
sidecar in place of the full service — so process isolation is preserved, not lost.

## Follow-up (not this project)

Filed separately: **investigate replacing the sidecar with `castv2-client`** on the
`urn:x-cast:com.plexapp.chromecast` namespace — mDNS discovery by friendly name → TLS to :8009
→ `LAUNCH` the Plex receiver → LOAD with `{contentId, contentType, offset, server:{machineIdentifier,
accessToken, address, port, protocol, version}}`, plus keeping the connection and heartbeat alive
after LOAD. Timebox two days when picked up. **The sidecar is a legitimate permanent end state**
if the Plex receiver's LOAD payload resists.

## Risks

- Engine parity divergence in the 1/n² rewatch weighting and the round-robin interleave.
  Mitigated by the golden-file parity harness, which injects a deterministic seeded RNG into
  both sides for ordered outputs and compares unordered outputs as multisets.
- ADB is not unit-testable end to end. Mitigated by the XML fixture plus a manual TV checklist.
- Losing process isolation is a wash: `entrypoint.sh` already tears the container down when
  either half dies, and the sidecar preserves the split anyway.

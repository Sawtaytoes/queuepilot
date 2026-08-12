# Python is deleted — except the cast sidecar

- **Status:** Accepted
- **Date:** 2026-08-12
- **Type:** Architecture / cleanup
- **Supersedes:** —
- **Superseded by:** —
- **Completes:** [2026-08-03 — retiring Python except the cast sidecar](2026-08-03-retiring-python-except-the-cast-sidecar.md)

## Decision

`queue_builder/` is **deleted**, along with the Python engine tests, the synthetic-corpus
generator, the live-corpus recorder, the `ENGINE` / `PLAYBACK_ENGINE` switches, and the
`PLAYBACK_ENGINE=python` rollback path in `entrypoint.sh`. Node is the only implementation.

**`cast_sidecar/` stays.** It is the one thing Node cannot do: `PLAYBACK_MODE=cast` needs
pychromecast, and `playback.js` deliberately refuses to reimplement it, delegating over
`plex-channels/cmd/cast/play` instead. The image therefore still installs python3 + a venv, now
carrying three packages (paho-mqtt, PlexAPI, PyChromecast) instead of the full engine's deps.

Two things go with the deletion:

- **The soundtrack resolver** (MA → YouTube-Music → Ollama, `cmd/soundtrack/resolve`) was
  Python-only. No live HA automation publishes to that topic — only an idea doc mentions it — so
  it is retired rather than ported; `mqttd` answers the topic with a clear error.
- **The live-corpus recorder** (`e2e/record-corpus.sh` + the `PLEX_RECORD_DIR` shim) went with
  `plex.py`. Node has replay, not record. The committed synthetic corpus is what CI uses.

## Context

The port ran D1–D7 behind two env switches, defaulting to Python until each phase soaked. The
deployed app has run `ENGINE=node` + `PLAYBACK_ENGINE=node` since the D4–D8 code landed
(2026-08-10) and the owner confirms it works. Keeping `queue_builder/` after that bought a
rollback nobody intends to take, at the cost of a second implementation of every selection rule
— exactly the drift the port existed to end.

The owner's call on the sidecar, asked directly before this change: *keep it*. His device
registry has one entry today (the Shield in `client` mode), so the sidecar is inert in practice
— but deleting it would remove cast playback as an option entirely, and that is not what
"remove Python" was meant to cost.

## Why

**The parity gates were Python's last real job, and they survive it.** Four CI gates
(`binding-parity`, `set-passthrough-parity`, `engine-parity`, `curated-parity`) proved Node
matched Python by shelling the Python CLI on every run. Deleting the oracle would have deleted
the gates. Instead the oracle's answers were **recorded** the day it died and committed to
`e2e/fixtures/golden/`; each gate now diffs Node against that frozen contract. The gates keep
their names, their fixtures and their assertions — only the source of the expectation changed.

A golden is a **contract, not a snapshot to refresh**: a failure means Node's behaviour moved
away from the semantics the two engines were proven to share. Fix the engine, or change the
golden deliberately in a commit that says why.

**The Python-only engine tests were ported 1:1, not dropped.** Seven behaviours had no Node
coverage and would have gone dark: the collection start floor, the non-consuming
`keep_completed` flag, resume-in-queue (including the offset reaching Companion's `playMedia`),
in-progress-never-done (the Prison School OAD bug), the playback FSM's six scenarios, the
FSM wake/skip fixes, and the session-level profile gate. Each is now an `.mjs` test naming the
`.py` file it replaces. ESM namespaces are frozen, so where the Python tests monkeypatched a
module, the ports install `node:module` resolve hooks (`e2e/stubs/`) — scoped to the importing
file, so a test can stub `adb.js` for `driver.js` while driving the real `adb.js` itself.

**The synthetic corpus is committed rather than regenerated.** It was rebuilt on every gate run
by a Python script; that script is gone. The corpus is fixture DATA, not code — its last output
is checked in, with `e2e/fixtures/README.md` explaining the hash scheme for hand-edits. Owner
decision 2026-08-07 still holds: CI never sees real library data.

## Evidence

Owner, this session:

> "I just wanna note you created a bunch of python files, but we've moved to Node.js and
> confirmed it's working. let's get a PR up and merged that removes Python entirely. if the
> Node.js code works, there's no reason for the Python to exist any longer."

And on the sidecar, choosing "Keep the sidecar" over deleting it with the rest.

Deployed app config at the time of the change (TrueNAS `plex-channels`): `ENGINE=node`,
`PLAYBACK_ENGINE=node`, `PLAYBACK_MODE=client`, one registered device (`shield`, client mode).

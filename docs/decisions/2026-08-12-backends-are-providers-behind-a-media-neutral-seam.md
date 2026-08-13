# Backends are providers behind a media-neutral seam — `client` widens into `provider`

- **Status:** Accepted
- **Date:** 2026-08-12
- **Type:** architecture
- **Supersedes:** —
- **Superseded by:** —

## Decision

Plex stops being the assumed backend. Each media app — Plex, **Kavita**, later Jellyfin / Emby /
Kodi — becomes a **provider** implementing one media-neutral interface, and the selection engine
talks only to that interface.

The seam already exists in the right place; it is the wrong *shape*. Today the engine takes a
`client` with exactly two methods (`server/src/engine/plex-live.js:10`, mirrored by the corpus
replay client at `server/src/engine/plex-replay.js:27`):

```js
{
  async container(path, token = null) { … },   // → a Plex MediaContainer
  async accountToken(uuid) { … },
}
```

That is **Plex's HTTP wire format as an interface**. Kavita cannot implement `container(path)`
without emulating `MediaContainer`, which would be absurd. So the seam widens at the same
boundary — same injection point, same consumers, higher altitude:

| Method | Plex | Kavita |
| --- | --- | --- |
| `buckets(set, profile)` | `unwatchedBuckets` + `memberBuckets` | per-series `Reader/continue-point` → remaining chapters |
| `progressState(profile)` | `/status/sessions/history/all` | `ReadingList/items` (+ `Reader/get-progress`) |
| `materialize(items)` | `POST /playQueues` | create/refresh a Reading List |
| `handoff(artifact)` | Companion `playMedia` to the Shield | **302 to the reader deep link** |

### `materialize` / `handoff` is the split that makes Kavita fit

This is the load-bearing part of the design. Both methods return a **descriptor of how to start
this**, and neither performs playback itself:

- **Plex** materializes a `playQueue` and then **pushes** it to a device.
- **Kavita** materializes a Reading List and then **returns a URL** — because Kavita has no cast
  and no webhook at all (`Device/send-to` is Send-to-Kindle *email*; see
  [the feasibility record](../kavita-feasibility.md) §4).

Collapsing these into one `play()` would hard-code the push model and lock Kavita out. Keeping
them separate also makes the difference honest at the UI layer: TV is **push** (a card starts
the show on a screen already on), reading is **pull** (you pick up the tablet when you're
ready).

### Already backend-neutral — reused as-is, not rewritten

- `server/src/engine/rotation.js:76` `buildRotation` — pure round-robin over buckets; it never
  touches Plex. Give it chapter buckets and it interleaves series exactly as it interleaves
  shows.
- `server/src/engine/routing.js` — pure `sets.yaml` routing, no I/O.
- The `sets.yaml` / `queues.yaml` schemas, **minus `sections` / `ratingKey`**, which are the two
  genuinely Plex-shaped fields and need a provider-scoped equivalent (a Kavita library id, a
  Kavita series id).

That list is the evidence the seam is cut at the right joint: the parts that would have to
change to support reading are the parts that were always about *Plex*, not about *queues*.

### `buildRotation` gains the `batch` knob at the same time

`buildRotation` emits exactly **one** item per show per round (`rotation.js:88`), because
`memberBuckets` (`rotation.js:43`) passes no batch and each bucket keeps its full ordered list.
The per-entry `episodes:` batch already exists for curated entries — `applyBatch`
(`server/src/engine/resolve.js:413`), clamped to `QUEUE_SERIES_LENGTH`, with `batch_stops_at`
(`resolve.js:388`) forbidding a batch from spanning a member or season boundary.

Wiring that existing knob into the rotation loop is what makes "read 3 chapters, then switch
series" work, and it is the `batch` knob from the
[mode-knobs ADR](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md). `batch_stops_at`
composes with it unchanged.

## Sequencing — the constraint that used to apply is GONE

⚠️ **Read this before acting on any older plan.** The design work for this seam was drafted
against a repo state that no longer exists. It assumed the Python→Node port was *parked at D2*
with `ENGINE`/`PLAYBACK_ENGINE` defaulting to `python`, and concluded that the seam had to be
cut in the Node engine only, at D3, to avoid doubling the porting surface across two engines.

**On `main` at `621534d` (2026-08-12) that is no longer true:**

- The port is **finished**. `queue_builder/` was **deleted** (#60, "Node is the only
  implementation"); D3 landed 2026-08-08 and D4–D8 followed.
- The `ENGINE` and `PLAYBACK_ENGINE` switches **no longer exist** in `server/src/env.js`.
- `cast_sidecar/` is the only Python left.
- Parity is now guarded against the deleted engine's recorded answers in
  `e2e/fixtures/golden/`, not against a live Python oracle.

So the two-engine hazard the constraint existed to prevent **cannot occur**. There is exactly
one engine to widen, and the work is unblocked now rather than gated on a port phase. The
surviving obligation is narrower and purely mechanical:

1. Widen `client` → `provider` **behind the existing golden-corpus gates**, so the Plex
   provider's output stays byte-identical to today's. A refactor at this seam that moves a
   single episode is a family-TV regression.
2. **Do not reintroduce a second engine or a compatibility shim** for the deleted Python path.
   The whole point of #60 was that there is one implementation.
3. Land the Plex provider (a pure rename/rewrap, no behaviour change) **before** the Kavita
   provider, so any diff the golden gates catch is unambiguously the refactor's fault.

## Why

- **The name was the smallest problem.** `plex-channels` was Plex-only in its *interface*, not
  just its name. Any second backend forces this seam regardless of what the app is called (see
  the [rename ADR](2026-08-12-plex-channels-becomes-queuepilot.md)).
- **Kavita is the cheapest possible second provider**, which makes it the right one to prove the
  seam with: it already implements the auto-advancing runtime artifact natively, so only the
  recipe layer — the thing this app *is* — is missing.
- **A Plex-wire-format interface is not an abstraction.** `container(path, token)` returning a
  `MediaContainer` leaks the backend through every consumer. The current shape is a historical
  artifact of extracting the interface from the Plex client rather than from the engine's needs.
- **The replay client proves the seam is real.** `plex-replay.js` already substitutes for
  `plex-live.js` in the parity gates, so the engine genuinely depends on the interface and not
  on Plex-the-service. Widening it is a change of shape, not the introduction of indirection.

## Scope

**Design only. No provider code ships with this ADR**, and no change to `sets.yaml`. The
provider-scoped replacement for `sections` / `ratingKey` is named as necessary work here but is
not specified; it needs its own decision alongside the schema migration from the mode-knobs ADR.

Provider *configuration* — base URLs and tokens — is settled separately in
[provider tokens live in a separate `/config` file](2026-08-12-provider-tokens-live-in-a-separate-config-file.md).

## Evidence

- Interface shape and consumers read from `main` at `621534d`: `plex-live.js:10`,
  `plex-replay.js:27`, `rotation.js:43,76,88`, `resolve.js:388,413`, `routing.js`.
- Port closure: `docs/handoff-python-port-status.md` header ("CLOSED 2026-08-12 … Node is the
  only implementation; the `ENGINE` and `PLAYBACK_ENGINE` switches no longer exist") and
  `2026-08-12-python-is-gone-except-the-cast-sidecar.md`.
- Kavita's side of the mapping verified live and recorded in
  [`docs/kavita-feasibility.md`](../kavita-feasibility.md).

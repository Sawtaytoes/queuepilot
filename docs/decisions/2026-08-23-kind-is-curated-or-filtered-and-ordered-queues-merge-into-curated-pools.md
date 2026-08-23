# `kind` is `curated` or `filtered`; Ordered Queues merge into Curated Pools

- **Status:** Accepted (design; schema + UI migration is separate work)
- **Date:** 2026-08-23
- **Type:** data model / naming / playback semantics
- **Supersedes:**
  - [filtered-pools-curated-pools-ordered-queues](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
    — the **three** Play groups; Ordered Queues stop being a sibling group
  - The remaining `kind: movies` / `kind: anime` discriminator left alive after
    [queues-have-orthogonal-mode-knobs-not-named-types](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
    (that ADR deleted the queue-vs-channel *taxonomy* as design only; this one
    names the stored replacement and the merge)
- **Superseded by:** —
- **Builds on:**
  - [queues-have-orthogonal-mode-knobs-not-named-types](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
  - [weights-are-slots-per-round-not-odds](2026-08-14-weights-are-slots-per-round-not-odds.md)
    — weight stays; promote is a different axis

## Decision

### 1. Two product kinds — Curated Pool and Filtered Pool

| UI name | Stored `kind` | Membership |
| --- | --- | --- |
| **Curated Pool** | `curated` | Hand-picked entries in `queues.yaml` |
| **Filtered Pool** | `filtered` | Computed from rules each scan (`source: rotation`) |

**Ordered Queue is not a third kind.** It is a Curated Pool whose entries live in
the *queued* placement (below). The Play landing has **two** groups, not three.

`movies` and `anime` as `kind` values are **retired**. They named the first sets
that used each playback mode, not what the field does. They must not survive the
migration.

### 2. Inside a Curated Pool: queued vs pull (placement)

A Curated Pool is one membership list with two **placements**:

| Placement | Role |
| --- | --- |
| **`queued`** | Guaranteed, ordered. These lead the sitting, in list order. |
| **`pool`** | Pull set. Drawn by shuffle / rotation / weight after the queued head is done for this window. |

- **Promote** moves an entry `pool` → `queued` (optionally to the head).
- **Demote** moves an entry `queued` → `pool`.
- **Weight** still means likelihood inside the pull set
  ([weights ADR](2026-08-14-weights-are-slots-per-round-not-odds.md)). Weight is
  **not** a promise to play next; placement is.

### 3. Proposed stored fields

#### On the set (`sets.yaml`)

```yaml
kind: curated          # or filtered
add_as: pool           # default placement for NEW entries: queued | pool
promote_window: 24h    # default lead cooldown for queued entries (see below)
```

| Field | Values | Meaning |
| --- | --- | --- |
| `kind` | `curated` · `filtered` | Product type. Replaces `movies` / `anime` on curated sets, and replaces today's filtered leftovers `cartoons` / `movies` (rewatch) — see migration. |
| `add_as` | `queued` · `pool` | Where a newly added entry lands. Sparse: absent on a curated set means `pool` (today's Curated Pool default). A set that wants "only ordered" behaviour sets `add_as: queued` and keeps every entry queued. |
| `promote_window` | duration (`24h`, `7d`, `30d`, …) | Default **lead cooldown** for queued entries that are not sticky. Sparse; suggested product default **24h**. |

`source: queue` / `source: rotation` may remain as the engine's membership wiring
during the migration, but **`kind` is what the product and the editor mean**.
After cutover, `kind: curated` implies hand-picked membership; `kind: filtered`
implies rule membership. Do not invent a third `kind`.

#### On a curated entry (`queues.yaml` mapping)

```yaml
- ratingKey: "12345"
  title: Example Film (2026)
  placement: queued          # queued | pool; sparse → set add_as
  lead: once                 # once | always; sparse → once
  promote_window: 24h        # overrides set default; sparse → set / product default
  weight: 3                  # pull-set only; unchanged meaning
```

| Field | Values | Meaning |
| --- | --- | --- |
| `placement` | `queued` · `pool` | Which portion of the curated pool this entry is in. |
| `lead` | `once` · `always` | Queued only. `always` = sticky head every sitting (still skips when nothing is left to play). `once` = lead at most one contribution per `promote_window`, then yield for the rest of that window. |
| `promote_window` | duration | Cooldown after a `lead: once` contribution before this entry may lead again. Survives a pause-and-resume inside the window (debounce across process starts, not only in-memory session). |
| `weight` | 1–20 | Unchanged. Bias inside the **pull** set only. |

**Show vs film:** a queued show contributes its normal per-visit batch (the
existing `episodes:` / set default) as the lead, then the cooldown / sticky rule
applies. If there is no next episode (nothing left to play), the entry is
**skipped for this lead** and the sitting continues from the rest of the queued
list, then the pull set — it is not an error and it does not consume the
cooldown as a successful lead.

### 4. Sitting assembly (curated)

1. Take `placement: queued` entries in list order.
2. For each, if `lead: always`, or `lead: once` and its cooldown has expired (or
   never started), it may contribute; after a successful `once` contribution,
   record the lead timestamp so the window suppresses it until expiry.
3. Fill the rest of the playback length from `placement: pool` via the existing
   shuffle / weighted path.
4. In-progress resume still leads when it already would today (do not let a
   promote steal an in-progress show mid-watch).

### 5. Migration map

| Today | After |
| --- | --- |
| `source: queue` + `kind: movies` (Ordered Queue) | `kind: curated`, `add_as: queued`, every entry `placement: queued` (or omit entry placement and rely on `add_as`) |
| `source: queue` + `kind: anime` (Curated Pool) | `kind: curated`, `add_as: pool` |
| `source: rotation` + `kind: cartoons` / `movies` | `kind: filtered`; keep `behavior: progress` / `rewatch` (and any mode/library fields). The old filtered `kind` strings are **not** media types and do not become `curated`. |

Read path accepts the old values until the live `sets.yaml` is rewritten; write
path emits only `curated` / `filtered`. Same posture as other one-way schema
cuts in this repo: tolerate on read, refuse to re-write the legacy spellings.

### 6. UI consequences

- Play landing groups: **Filtered Pools** and **Curated Pools** only.
- Create: **＋ Filtered pool** / **＋ Curated pool**. No **＋ Ordered queue**.
- Curated editor: set-level `add_as` (ordered by default vs unordered by
  default); per-entry Promote / Demote; per-entry lead mode + window.
- The Type control that today toggles "Ordered Queue" vs "Curated Pool" on one
  set goes away — both are the same kind; placement is the lever.

### 7. Scope of *this* record

**Design + schema proposal.** No code, no live YAML rewrite, and no UI rename
ships with this file. Implementation is a follow-up (engine lead cooldown store,
editor controls, migration of `sets.yaml`, Play landing group collapse).

## Context

The live discriminator for hand-picked playback is still `kind: movies`
(ordered) vs `kind: anime` (shuffled curated). Those strings are leftover names
from the first movie wishlists and anime rotation sets. The 2026-08-16 UI rename
already called the groups Filtered / Curated / Ordered, and deliberately left
the stored `kind` alone. The owner has now rejected those stored values and the
third group:

> The stored value ABSOLUTELY has to change. … `movies` and `anime` are such
> junky names.

> Curated Pool and Filtered Pool is way better. … in the Curated Pool we're
> configuring it with ordered or unordered additions by default and allowing you
> to promote entries in the ordered queue as well as demote them back to the
> randomly-ordered queue.

The everyday flow is explicit membership plus "play this next in this window,"
not rule filters. Filtered Pools remain for the cases that still want
library + ratings (e.g. a shorts card that must pick up new items). Weight
covers "more often"; it does not cover "guaranteed first tonight, then not again
until tomorrow."

## Why

- **`kind` must name the product.** `movies` / `anime` encode history, not
  behaviour. `curated` / `filtered` match the UI nouns already in use.
- **Ordered vs unordered is placement, not type.** Two create buttons and a
  Type toggle that convert the whole set hide the real ask: one pool, some
  entries guaranteed and ordered, the rest pulled.
- **Promote ≠ weight.** Weight biases a draw. Placement + lead window
  *guarantees* order and presence for a defined period, including across a
  pause-and-resume inside that period.
- **Filtered stays separate.** Rule-built membership is a different object; it
  does not gain queued/pull placements in this decision.

## Evidence

- Owner, 2026-08-23 session: stored `movies` / `anime` "ABSOLUTELY" must change;
  merge Ordered Queue into Curated Pool; default add ordered vs unordered;
  promote / demote between the ordered head and the random pull set; lead once
  per window (24h example) with debounce across a resumed sitting; skip when no
  next episode; weight remains a separate axis.
- Prior design already pointed here:
  [knobs ADR](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
  (one object, modes not type names) and
  [2026-08-16 naming](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
  (pool nouns; Ordered as the third group — now folded in).

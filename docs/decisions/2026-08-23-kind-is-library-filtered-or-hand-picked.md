# `kind` is `library_filtered` or `hand_picked`; Ordered Queues merge into Hand-picked Pools

- **Status:** Accepted (design; schema + UI migration is separate work)
- **Date:** 2026-08-23
- **Type:** data model / naming / playback semantics
- **Supersedes:**
  - [filtered-pools-curated-pools-ordered-queues](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
    — the **three** Play groups; Ordered Queues stop being a sibling group; the
    "Curated" / "Filtered" *nouns* from that rename are replaced here
  - The remaining `kind: movies` / `kind: anime` discriminator left alive after
    [queues-have-orthogonal-mode-knobs-not-named-types](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
    (that ADR deleted the queue-vs-channel *taxonomy* as design only; this one
    names the stored replacement and the merge)
- **Superseded by:** —
- **Builds on:**
  - [queues-have-orthogonal-mode-knobs-not-named-types](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
  - [weights-are-slots-per-round-not-odds](2026-08-14-weights-are-slots-per-round-not-odds.md)
    — weight stays; promote is a different axis
- **Replaces draft naming:** an earlier same-day draft on this branch used
  `curated` / `filtered`. Both kinds are curated in the ordinary sense; the
  real split is *at what level you specify membership*. That draft never merged.

## Decision

### 1. Two product kinds — Library-filtered Pool and Hand-picked Pool

Both are pools you configure on purpose. They differ by **the level at which
you specify what belongs**:

| UI name | Stored `kind` | You specify membership at… |
| --- | --- | --- |
| **Library-filtered Pool** | `library_filtered` | **Library (and ratings) level** — rules over libraries, ratings, and the existing filter knobs; membership is recomputed each scan |
| **Hand-picked Pool** | `hand_picked` | **Individual title level** — each entry is added by hand to `queues.yaml` |

"Library-filtered" is the product name even when ratings (or other rule knobs)
do part of the work — the point is *bulk criteria over the shelf*, not
"libraries only." A shorts card that must pick up new G-rated shorts is the
canonical case.

**Ordered Queue is not a third kind.** It is a Hand-picked Pool whose entries
live in the *queued* placement (below). The Play landing has **two** groups,
not three.

`movies` and `anime` as `kind` values are **retired**. They named the first
sets that used each playback mode, not what the field does. They must not
survive the migration.

**Why not "Curated" / "Filtered":** both kinds are curated. "Filtered" sounds
like leftovers after exclusion; the live behaviour is *inclusion by rule*.
"Hand-picked" vs "Library-filtered" names the specification level.

### 2. Inside a Hand-picked Pool: queued vs pull (placement)

A Hand-picked Pool is one membership list with two **placements**:

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
kind: hand_picked              # or library_filtered
add_as: pool                   # default placement for NEW entries: queued | pool
promote_window: 24h            # default lead cooldown for queued entries (see below)
```

| Field | Values | Meaning |
| --- | --- | --- |
| `kind` | `hand_picked` · `library_filtered` | Product type. Replaces `movies` / `anime` on hand-picked sets, and replaces today's rule-pool leftovers `cartoons` / `movies` (rewatch) — see migration. |
| `add_as` | `queued` · `pool` | Where a newly added entry lands. Sparse: absent on a hand-picked set means `pool` (today's shuffled curated default). A set that wants "only ordered" behaviour sets `add_as: queued` and keeps every entry queued. Hand-picked only. |
| `promote_window` | duration (`24h`, `7d`, `30d`, …) | Default **lead cooldown** for queued entries that are not sticky. Sparse; suggested product default **24h**. Hand-picked only. |

`source: queue` / `source: rotation` may remain as the engine's membership wiring
during the migration, but **`kind` is what the product and the editor mean**.
After cutover, `kind: hand_picked` implies per-title membership; `kind:
library_filtered` implies rule membership. Do not invent a third `kind`.

#### On a hand-picked entry (`queues.yaml` mapping)

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
| `placement` | `queued` · `pool` | Which portion of the hand-picked pool this entry is in. |
| `lead` | `once` · `always` | Queued only. `always` = sticky head every sitting (still skips when nothing is left to play). `once` = lead at most one contribution per `promote_window`, then yield for the rest of that window. |
| `promote_window` | duration | Cooldown after a `lead: once` contribution before this entry may lead again. Survives a pause-and-resume inside the window (debounce across process starts, not only in-memory session). |
| `weight` | 1–20 | Unchanged. Bias inside the **pull** set only. |

**Show vs film:** a queued show contributes its normal per-visit batch (the
existing `episodes:` / set default) as the lead, then the cooldown / sticky rule
applies. If there is no next episode (nothing left to play), the entry is
**skipped for this lead** and the sitting continues from the rest of the queued
list, then the pull set — it is not an error and it does not consume the
cooldown as a successful lead.

### 4. Sitting assembly (hand-picked)

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
| `source: queue` + `kind: movies` (Ordered Queue) | `kind: hand_picked`, `add_as: queued`, every entry `placement: queued` (or omit entry placement and rely on `add_as`) |
| `source: queue` + `kind: anime` (Curated Pool) | `kind: hand_picked`, `add_as: pool` |
| `source: rotation` + `kind: cartoons` / `movies` | `kind: library_filtered`; keep `behavior: progress` / `rewatch` (and any mode/library fields). The old rotation `kind` strings are **not** media types and do not become `hand_picked`. |

Read path accepts the old values until the live `sets.yaml` is rewritten; write
path emits only `hand_picked` / `library_filtered`. Same posture as other
one-way schema cuts in this repo: tolerate on read, refuse to re-write the
legacy spellings.

### 6. UI consequences

- Play landing groups: **Library-filtered Pools** and **Hand-picked Pools** only.
- Create: **＋ Library-filtered pool** / **＋ Hand-picked pool**. No **＋ Ordered queue**.
- Hand-picked editor: set-level `add_as` (ordered by default vs unordered by
  default); per-entry Promote / Demote; per-entry lead mode + window.
- The Type control that today toggles "Ordered Queue" vs "Curated Pool" on one
  set goes away — both are `hand_picked`; placement is the lever.

### 7. Scope of *this* record

**Design + schema proposal.** No code, no live YAML rewrite, and no UI rename
ships with this file. Implementation is a follow-up (engine lead cooldown store,
editor controls, migration of `sets.yaml`, Play landing group collapse).

## Context

The live discriminator for hand-picked playback is still `kind: movies`
(ordered) vs `kind: anime` (shuffled). Those strings are leftover names from
the first movie wishlists and anime rotation sets. The 2026-08-16 UI rename
called the groups Filtered / Curated / Ordered and left the stored `kind`
alone. The owner rejected those stored values, rejected a third group, and
then rejected "Curated" / "Filtered" as the product nouns because **both
kinds are curated** — the split is individual titles vs library/ratings rules:

> Technically, they're both curated, but one is pooled on the library +
> ratings and the other is based on _you_ pooling them in there. You're
> specifying what's added at the individual, not at the library level.

> Library-filtered / Hand-picked.

The everyday flow is per-title membership plus "play this next in this window,"
not rule filters. Library-filtered pools remain for the cases that still want
shelf-level criteria (e.g. a shorts card that must pick up new items). Weight
covers "more often"; it does not cover "guaranteed first tonight, then not again
until tomorrow."

## Why

- **`kind` must name the specification level.** `movies` / `anime` encode
  history. `curated` / `filtered` mis-state the split (both are curated;
  "filtered" undersells inclusion-by-rule). `hand_picked` /
  `library_filtered` match how membership is decided.
- **Ordered vs unordered is placement, not type.** Two create buttons and a
  Type toggle that convert the whole set hide the real ask: one hand-picked
  pool, some entries guaranteed and ordered, the rest pulled.
- **Promote ≠ weight.** Weight biases a draw. Placement + lead window
  *guarantees* order and presence for a defined period, including across a
  pause-and-resume inside that period.
- **Library-filtered stays separate.** Rule-built membership is a different
  object; it does not gain queued/pull placements in this decision.

## Evidence

- Owner, 2026-08-23 session: stored `movies` / `anime` "ABSOLUTELY" must change;
  merge Ordered Queue into the hand-picked pool; default add ordered vs
  unordered; promote / demote between the ordered head and the random pull set;
  lead once per window (24h example) with debounce across a resumed sitting;
  skip when no next episode; weight remains a separate axis.
- Owner, same session, on naming: both kinds are curated; the axis is individual
  vs library+ratings; chose **Library-filtered / Hand-picked** over Curated /
  Filtered, Picked / Rules, and Library / Picked.
- Prior design already pointed at one object with modes:
  [knobs ADR](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
  and [2026-08-16 naming](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
  (pool nouns; Ordered as the third group — now folded into Hand-picked).

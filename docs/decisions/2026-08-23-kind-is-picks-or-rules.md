# `kind` is `picks` or `rules`; Ordered Queues merge into Picks

- **Status:** Accepted (design; schema + UI migration is separate work)
- **Date:** 2026-08-23
- **Type:** data model / naming / playback semantics
- **Supersedes:**
  - [filtered-pools-curated-pools-ordered-queues](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
    — the **three** Play groups; Ordered Queues stop being a sibling group; the
    Curated / Filtered *nouns* from that rename are replaced here
  - The remaining `kind: movies` / `kind: anime` discriminator left alive after
    [queues-have-orthogonal-mode-knobs-not-named-types](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
    (that ADR deleted the queue-vs-channel *taxonomy* as design only; this one
    names the stored replacement and the merge)
- **Superseded by:** —
- **Builds on:**
  - [queues-have-orthogonal-mode-knobs-not-named-types](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
  - [weights-are-slots-per-round-not-odds](2026-08-14-weights-are-slots-per-round-not-odds.md)
    — weight stays; priority is a different axis
- **Replaces draft naming on this branch:** earlier same-day drafts used
  `curated` / `filtered`, then `library_filtered` / `hand_picked`. Neither
  merged. Both kinds are curated in the ordinary sense; the product split is
  **how membership is specified** (titles you pick vs rules that match). The
  product sits under QueuePilot, so both kinds are **queues** — categorised as
  **Picks** and **Rules**.

## Decision

### 1. Two product kinds — Picks and Rules

| UI category | Full name | Stored `kind` | Membership |
| --- | --- | --- | --- |
| **Picks** | Picks queue | `picks` | You add each title by hand (`queues.yaml`) |
| **Rules** | Rules queue | `rules` | A rule set (libraries, ratings, and the existing filter knobs) narrows the shelf; membership is generated each scan |

Play landing groups: **Picks** and **Rules**. Create: **＋ Picks queue** /
**＋ Rules queue**.

**Ordered Queue is not a third kind.** It is a Picks queue whose entries live
in the *Priority queue* lane (below). Two groups on Play, not three.

`movies` and `anime` as `kind` values are **retired**. They named the first
sets that used each playback mode, not what the field does.

**Why these nouns:** QueuePilot plays queues either way — ordered, rotated, or
shuffled, the sitting is still a queue. **Picks** vs **Rules** names the only
split that matters for creation: did you choose the titles, or configure rules
that generate them? "Curated" / "Filtered" / "Library-filtered" /
"Hand-picked" all blurred that (both are curated; "filtered" sounds like
exclusion; the long forms fight button chrome).

### 2. Inside a Picks queue: Priority queue vs Random pool

A Picks queue is one membership list with two **lanes**:

| Lane (UI) | Stored `placement` | Role |
| --- | --- | --- |
| **Priority queue** | `priority` | Guaranteed, ordered. These lead the sitting, in list order. |
| **Random pool** | `random` | Unordered / rotated / weighted pull. Fills the rest of the sitting after the Priority queue has contributed for this window. |

- **Promote** moves an entry `random` → `priority` (optionally to the head of
  the Priority queue).
- **Demote** moves an entry `priority` → `random`.
- **Weight** still means likelihood inside the Random pool
  ([weights ADR](2026-08-14-weights-are-slots-per-round-not-odds.md)). Weight is
  **not** a promise to play next; placement is.

"Random pool" is the product name for the pull lane even when the engine uses
round-robin-with-shuffled-lead (today's curated path) rather than a pure die
roll — the contrast with Priority is *not guaranteed order*, not a claim that
every draw is IID.

Avoid **Mix** (implies combining parts), **queued** as a placement (everything
is queued at playback), and **pool** as both the product type and the lane.

### 3. Proposed stored fields

#### On the set (`sets.yaml`)

```yaml
kind: picks                    # or rules
add_as: random                 # default placement for NEW entries: priority | random
promote_window: 24h            # default lead cooldown for priority entries
```

| Field | Values | Meaning |
| --- | --- | --- |
| `kind` | `picks` · `rules` | Product type. Replaces `movies` / `anime` on hand-picked sets, and replaces today's rule-pool leftovers `cartoons` / `movies` (rewatch) — see migration. |
| `add_as` | `priority` · `random` | Where a newly added entry lands. Sparse: absent on a Picks queue means `random` (today's shuffled curated default). A set that wants "only ordered" behaviour sets `add_as: priority` and keeps every entry in the Priority queue. Picks only. |
| `promote_window` | duration (`24h`, `7d`, `30d`, …) | Default **lead cooldown** for Priority entries that are not sticky. Sparse; suggested product default **24h**. Picks only. |

`source: queue` / `source: rotation` may remain as the engine's membership wiring
during the migration, but **`kind` is what the product and the editor mean**.
After cutover, `kind: picks` implies per-title membership; `kind: rules`
implies rule membership. Do not invent a third `kind`.

#### On a Picks entry (`queues.yaml` mapping)

```yaml
- ratingKey: "12345"
  title: Example Film (2026)
  placement: priority        # priority | random; sparse → set add_as
  lead: once                 # once | always; sparse → once
  promote_window: 24h        # overrides set default; sparse → set / product default
  weight: 3                  # Random pool only; unchanged meaning
```

| Field | Values | Meaning |
| --- | --- | --- |
| `placement` | `priority` · `random` | Which lane of the Picks queue this entry is in. |
| `lead` | `once` · `always` | Priority only. `always` = sticky head every sitting (still skips when nothing is left to play). `once` = lead at most one contribution per `promote_window`, then yield for the rest of that window. |
| `promote_window` | duration | Cooldown after a `lead: once` contribution before this entry may lead again. Survives a pause-and-resume inside the window (debounce across process starts, not only in-memory session). |
| `weight` | 1–20 | Unchanged. Bias inside the **Random pool** only. |

**Show vs film:** a Priority show contributes its normal per-visit batch (the
existing `episodes:` / set default) as the lead, then the cooldown / sticky rule
applies. If there is no next episode (nothing left to play), the entry is
**skipped for this lead** and the sitting continues from the rest of the
Priority queue, then the Random pool — it is not an error and it does not
consume the cooldown as a successful lead.

### 4. Sitting assembly (Picks)

1. Take `placement: priority` entries in list order.
2. For each, if `lead: always`, or `lead: once` and its cooldown has expired (or
   never started), it may contribute; after a successful `once` contribution,
   record the lead timestamp so the window suppresses it until expiry.
3. Fill the rest of the playback length from `placement: random` via the
   existing shuffle / weighted path.
4. In-progress resume still leads when it already would today (do not let a
   promote steal an in-progress show mid-watch).

### 5. Migration map

| Today | After |
| --- | --- |
| `source: queue` + `kind: movies` (Ordered Queue) | `kind: picks`, `add_as: priority`, every entry `placement: priority` (or omit entry placement and rely on `add_as`) |
| `source: queue` + `kind: anime` (Curated Pool) | `kind: picks`, `add_as: random` |
| `source: rotation` + `kind: cartoons` / `movies` | `kind: rules`; keep `behavior: progress` / `rewatch` (and any mode/library fields). The old rotation `kind` strings are **not** media types and do not become `picks`. |

Read path accepts the old values until the live `sets.yaml` is rewritten; write
path emits only `picks` / `rules`. Same posture as other one-way schema cuts in
this repo: tolerate on read, refuse to re-write the legacy spellings.

### 6. UI consequences

- Play landing groups: **Picks** and **Rules** only.
- Create: **＋ Picks queue** / **＋ Rules queue**. No **＋ Ordered queue**.
- Picks editor: set-level `add_as` (Priority by default vs Random by default);
  per-entry Promote / Demote between Priority queue and Random pool; per-entry
  lead mode + window.
- The Type control that today toggles "Ordered Queue" vs "Curated Pool" on one
  set goes away — both are `picks`; placement is the lever.

### 7. Scope of *this* record

**Design + schema proposal.** No code, no live YAML rewrite, and no UI rename
ships with this file. Implementation is a follow-up (engine lead cooldown store,
editor controls, migration of `sets.yaml`, Play landing group collapse).


### 8. Home Assistant — one `kind` on the wire too

MQTT / `script.control_plex` use the **same** vocabulary: `picks` | `rules`.
Do not keep a parallel `cartoons` | `movie` | `anime` wire kind.

- **UI badge rename alone does not break HA** (payloads unchanged until schema cutover).
- **Schema + MQTT cutover is breaking** and must ship with HA: every
  `tag_command_map` / voice / button `kind`, and `script.control_plex`'s selector,
  moves to `picks`|`rules`.
- **AVR volume can no longer key off `kind`.** Kevin's anime and movie queues are
  both `picks`. HA chooses dB from **set-id lists** (quiet ≈ -17 dB, loud ≈ -8 dB),
  same allowlist style as today's `kevin_sets`.

Workspace inventory (not on the public GitHub tree):
`home-assistant/docs/2026-08-23-queuepilot-picks-rules-ha-consumer-inventory.md`.

## Context

The live discriminator for hand-picked playback is still `kind: movies`
(ordered) vs `kind: anime` (shuffled). Those strings are leftover names. The
2026-08-16 UI rename used Filtered / Curated / Ordered. Same-day drafts on this
branch tried Curated/Filtered and Library-filtered/Hand-picked. The owner
settled on QueuePilot-native categories:

> Since it's QueuePilot, I think Picks Queue and Rules Queue would make more
> sense … categorizing them as Picks and Rules is better.

> Rules-based queues are going to be defined by configuring a set of rules that
> narrow down what you want and automatically generate the queue. The Picks are
> hand-picked.

On the lanes inside Picks:

> Priority makes sense. The rest are unordered or rotated or random. The random
> pool and priority queue.

The everyday flow is per-title Picks plus "play this next in this window."
Rules queues remain for shelf-level criteria (e.g. a shorts card that must pick
up new items). Weight covers "more often"; Priority covers "guaranteed first
tonight, then not again until tomorrow."

## Why

- **Categories under QueuePilot should sound like queues.** Picks / Rules are
  short, parallel, and name the specification level without pretending one kind
  is "more curated" than the other.
- **Ordered vs unordered is a lane, not a type.** Priority queue vs Random pool
  inside Picks replaces a third Play group and a Type toggle that rewrote the
  whole set.
- **Promote ≠ weight.** Weight biases the Random pool. Priority + lead window
  *guarantees* order and presence for a defined period, including across a
  pause-and-resume inside that period.
- **Rules stays separate.** Rule-built membership does not gain Priority /
  Random lanes in this decision.

## Evidence

- Owner, 2026-08-23 session: retire `movies` / `anime`; merge Ordered Queue into
  the hand-picked kind; default add ordered vs unordered; promote / demote;
  lead once per window (24h) with debounce across a resumed sitting; skip when
  no next episode; weight separate.
- Owner, same session, naming: categories **Picks** and **Rules**; lanes
  **Priority queue** and **Random pool**; rejected Mix; rejected `queued` as a
  placement name because everything is queued at playback.

# 2026-08-08 — Curated queue flags are editable in the Set editor via Charcuterie Checkbox

Status: Accepted
Date: 2026-08-08
Type: frontend + server (web editor / sets API)
Supersedes: the "Web UI needs no change" clause of
  [2026-08-07-non-consuming-keep-completed-queue-flag](2026-08-07-non-consuming-keep-completed-queue-flag.md)
  (that clause meant the *Completed badge* needed no special case — it did **not**
  forbid exposing the flags as controls; the flags themselves stayed hand-YAML only)
Superseded by: —

## Decision

The Set editor modal (`SetModal`) exposes three curated-queue knobs that already
exist in `sets.yaml` / the engine:

| Control | Field | Primitive |
| --- | --- | --- |
| Playlist mode — don’t mark entries done when played | `keep_completed` | `@charcuterie/ui` **`Checkbox`** |
| Demo reel — play the whole lineup every scan | `reel` | `@charcuterie/ui` **`Checkbox`** |
| Remove finished entries after | `remove_completed_after` | plain text (`24h` / `7d` / blank = forever) |

Rules:

- **Queue-only.** Rotation channels reject these keys on create/update (they have no
  consumption model). The fieldset is only in `SetModal`, never `DynModal`.
- **`reel` ⇒ `keep_completed`.** Checking Demo reel forces playlist mode on (checkbox
  disabled + checked). The engine already implies this; the UI mirrors it so a
  re-open never shows a contradictory pair.
- **Uncontrolled Charcuterie contract.** `Checkbox.isChecked` seeds once; remount on
  modal-open identity (and when reel forces keep_completed) per
  `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`.
- **API.** `normalize` emits the three fields; `createSet` / `updateSet` allow them
  for curated queues. Clearing a boolean drops the YAML key; blank /
  `never`/`0`/`off` drops `remove_completed_after` (keep forever).

Requires **`@charcuterie/ui@^2.6.0`** (boolean family landed in 2.5.0; read-only +
border polish in 2.6.0). The prior agent report that Charcuterie had no `Checkbox`
was wrong — it was looking at a stale local checkout still on `ui@2.2.0` without
fetching `master`.

## Context

`keep_completed` / `reel` / `remove_completed_after` shipped as engine + YAML flags
(2026-08-07). The owner wanted them toggleable from the Edit-queue modal instead of
hand-editing `sets.yaml`, and specifically via Charcuterie rather than more raw
`<input type="checkbox">` (the Libraries multi-select stays raw for now because its
e2e contract keys on `input[value="…"]` and the multi-toggle is controlled state).

## Why

- Hand-YAML for a flag the owner flips while setting up Demo Reel / Betterman QC is
  the friction the web editor exists to remove — same reason
  `requires_profile` moved into this modal the day before.
- The boolean family is the sanctioned primitive: tokenised, scheme-correct, and
  already published. Re-rolling raw checkboxes would recreate the M6 defect
  Charcuterie was adopted to delete.

## Evidence

- Owner: *"Can we add that checkbox via Charcuterie to the UI since it's already
  part of the config? I'd like to get those settings exposed."*
- Owner (on the false "no Checkbox" report): pointed at the prior end-to-end ship
  of Checkbox / Radio / Switch through charcuterie #48 → release #44 →
  `@charcuterie/ui@2.6.0`.
- Verified: `origin/master` of charcuterie exports `Checkbox`, `RadioGroup`,
  `Switch` at `ui@2.6.0` (npm); storybook.example.com was **stale** (charcuterie ref
  last built 2026-08-04, before the boolean family merged) — missing stories there
  do not mean the package lacks the components.

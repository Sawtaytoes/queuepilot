# A tile names the runtime, on its own line

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

A tile says how long the next thing runs, on a **line of its own** under the next-up line:

```
Darker Than Black (2007)
E21 · City Under Crackdown, Moist with…      ← the next-up line (accent, and a control)
24 min                                       ← the runtime line (muted, one size down)
[2 eps] [Edit]
```

Three parts:

1. **Its own line**, not appended to the next-up line and not a chip in the badge row.
2. **Whole minutes**, hours split out past sixty ("24 min", "1 h 47 min", "2 h").
3. **A batch multiplies and says "about"** — "2 x 24 min · about 48 min".

The line renders only when there **is** a runtime. Kavita and Board Game Picker tiles send
`duration: 0` — pages and plays are not milliseconds — so those tiles keep exactly the
geometry they have today.

No server change: `nextEp.duration` has been on the wire since the next-up lookup was
written, and a movie already carries its own `duration`. This is a display change only.

## Context

The owner, on the queue grid:

> *"I'd like to… see the length of that upcoming episode (on this screen if possible or on
> hover or click)."*

"On this screen if possible" ruled out the tooltip-only option before it was drawn. Three
placements were rendered with the real stylesheet and real data, and he chose the separate
line (**3C**).

## Why

**Not on the next-up line.** That line already truncates on a long episode title — "E21 ·
City Under Crackdown, Moist with…" is the owner's own screenshot — so a runtime appended to
it is the first thing to disappear, on exactly the tiles that are hardest to read.

**Not a chip.** The badge row is where the per-entry *overrides* live (a batch, a weight, a
start point) and each one is a button into the editor. A runtime is not an override and is
not editable; a chip would have made it look like both.

**"About", on a batch.** The only runtime known is the next episode's — it is the only leaf
`nextEp` carries. Episodes in a series are near-uniform, so multiplying is useful; presenting
the product as exact would be a number nothing measured.

## Evidence

- Owner's request (2026-08-21 chat), quoted above.
- Owner, choosing from the rendered options (2026-08-22): *"3C"*.
- `runtimeLabel()` in `web/src/lib/tileFace.ts`, with the unit tests that pin the wording.

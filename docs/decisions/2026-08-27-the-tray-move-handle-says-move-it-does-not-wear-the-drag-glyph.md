# The tray move handle says "Move" — it does not wear this app's drag glyph

- **Status:** Accepted
- **Date:** 2026-08-27
- **Type:** UI / affordance
- **Supersedes:** the `moveIcon="≡"` rationale in `web/src/components/PeopleTrays.tsx`, shipped
  2026-08-25 with [the queue editor is two trays](2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster.md)
- **Superseded by:** —

## Decision

**1. `PeopleTrays` passes no `moveIcon`.** The handle keeps `@charcuterie/ui`'s default, which
is the **word "Move"**.

**2. `#dynmodal` is `min(920px, 92vw)`** — the same width, and the same reason, as `#setmodal`.

## Context

The owner, 2026-08-27, on the rules editor for Shorts:

> "I can't seem to drag 'n drop the names from Everyone Else anywhere else. There's no
> right-click or anything. How do I move these?"

Both halves of that sentence were true, and each had its own cause.

## Why

### The glyph taught the one gesture that could not work

`≡` in this app means **drag me**. It is the shelf-reorder grip in `QueuesView`, the card grip
in `PlayView`, and `useHomeDrags` documents it in exactly those words. The tray handle is a
**menu button first** — pressing it lists the other trays, which is the only path that works
from the keyboard, from a screen reader, and in the narrow board where the other trays are not
on screen to drop onto. `@charcuterie/ui` says so in `BoardCard`'s own docstring and ships the
word "Move" as the default for that reason.

The 2026-08-25 comment argued that "this app owns a glyph set and already uses `≡` for its own
drag handles, so the handle reads the same here as it does on a shelf." That is the argument
inverted: reading the same as a drag handle is the defect, because this one is not a drag
handle. The owner tried the two gestures the glyph implies — drag, then right-click — and
neither is what the control does.

The word costs about 55px of row, which the library's own docs price. In a tray whose rows are
a face and a name, that is affordable. A control nobody can find is not.

### The rules editor was too narrow to drop anything into

`#setmodal` was widened to 920px on 2026-08-25, and its CSS comment says why: the board
chooses three-lanes-across versus one-lane-plus-a-segmented-control from a **container query**
at `cq-lg` (48rem / 768px) on its own box, so at 440px it is permanently in its narrow form
and "the whole house at once" is never on screen at any window width.

`#dyn-people` landed on 2026-08-26 and this width did not move with it. So the rules editor
shipped with one tray on screen, the other two behind a segmented control, and **nowhere to
drop** — at any window width. That is not a discoverability problem; the drop target did not
exist. Measured: 520px, one lane. After: 920px, three lanes.

Both are regressions introduced by the two changes that put trays in front of the owner, and
neither was caught, because every screenshot of the rules editor was taken at the width that
hides the problem and every assertion was "the trays render".

## Consequences

- **Drag now works in the rules editor**, because there is a second lane to drop onto. It was
  never the primary path and still is not; the menu is.
- **The Narrow View is unchanged.** `92vw` still wins on a phone, and the board drops back to
  one lane on its own — which is the shape it is designed to have there, and why the menu has
  to be findable in the first place. Asserted: no horizontal scroll, modal 359px at 390px.
- **`#setmodal` is untouched.** It already had both fixes except the glyph, which it shares
  through `PeopleTrays`, so the picks editor gains the word too.

## Evidence

- Owner quote above, 2026-08-27.
- Driven against the LIVE app before the fix: the handle carries `aria-haspopup="menu"` and
  `aria-expanded`, and clicking it does open a menu offering "Must be here" and "Nice to
  have". The mechanism was never broken — nothing on screen said it was a button.
- `e2e/shot-tray-move.ts` — before/after, and it ASSERTS rather than only photographing:
  the lane count actually on screen, the modal's measured width, the handle's visible text,
  the menu's items, and no horizontal scroll at 390px. Before: `520px, 1 tray, ≡`. After:
  `920px, 3 trays, "Move"`.

## Related

- [The queue editor is two trays, not a sentence or a roster](2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster.md) —
  where the trays and the `≡` came from
- [A Rules queue carries people too](2026-08-26-a-rules-queue-carries-people-too.md) — the
  change that put the trays in `#dynmodal` without widening it
- `AGENTS.md` "People on a queue"

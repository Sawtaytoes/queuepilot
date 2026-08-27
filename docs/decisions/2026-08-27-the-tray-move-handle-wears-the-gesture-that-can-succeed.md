# The tray move handle wears the gesture that can succeed

- **Status:** Accepted
- **Date:** 2026-08-27
- **Type:** UI / affordance
- **Supersedes:** [The tray move handle says "Move" — it does not wear this app's drag glyph](2026-08-27-the-tray-move-handle-says-move-it-does-not-wear-the-drag-glyph.md)
  (part 1 only; its part 2, the 920px modal, still stands)
- **Superseded by:** —

## Decision

**1. `PeopleTrays` passes `moveIcon="≡"` again**, and `@charcuterie/ui` decides where it is
painted:

| The board is | The handle shows |
| --- | --- |
| three trays side by side | `≡`, this app's grip |
| one tray and a segmented control | the word **Move** |

**2. The rule lives in the library, not here.** It is
[`2026-08-27-the-move-handle-wears-the-gesture-that-can-succeed`](https://github.com/Sawtaytoes/charcuterie/blob/master/docs/decisions/2026-08-27-the-move-handle-wears-the-gesture-that-can-succeed.md)
in Charcuterie, and this app carries no width logic of its own.

**3. `#dynmodal` stays `min(920px, 92vw)`.** Unchanged from the superseded record. Narrow that
modal again and the trays go back to one lane, where the word is what shows.

## Context

The superseded record read one report and drew a blanket rule from it: never `≡`. The owner
read the result and corrected it the same day.

> *"I think the drag handles were fine, but now you have it in a 3-column mode, so dragging
> would work, but it has this 'move' button instead. The 'move' button would be best in that
> mobile view I showed you in the screenshot."*

So the two reports are not a contradiction. They are two halves of one rule, and the first fix
took only one half.

| | what the handle wore | what the owner said |
| --- | --- | --- |
| before 2026-08-27 | `≡` at every width, modal 520px, one tray | *"There's no right-click or anything. How do I move these?"* |
| after the first fix | "Move" at every width, modal 920px, three trays | *"the drag handles were fine […] but it has this 'move' button instead"* |
| now | `≡` wide, "Move" narrow | — |

## Why

**The glyph is a promise, and the board is what decides whether it can be kept.** With three
trays on screen, `≡` is honest: `useBoardDrag` is listening and dragging a face into "Must be
here" is the fastest thing a pointer can do. With one tray on screen there is nowhere to drop,
so the same glyph teaches the single gesture that cannot work — instead of the one that can.

**Neither half belongs in this app.** Whether another lane is on screen is a fact about the
`Board`, measured against the board's own box, and every consumer of the component has it.
Fixing it here would have been a width check in an app that must not own one, and Docket —
which passes `⋮` — would still have the bug. The house rule is that a shared shape is built in
Charcuterie first; this is that rule applied to a defect rather than to a feature.

**What the superseded record got right, it keeps.** The handle is still a menu button first:
pressing it lists the other trays, and that is still the only path that works from the
keyboard, from a screen reader, and in the narrow board. Nothing here makes drag the primary
path. What changed is only what the control *looks like* where drag is available too.

**The word's price is now ~35px, not ~55px**, because the library keeps the button
control-sized underneath and takes icon sizing back at the wide breakpoint. The wide board
renders pixel-identically to the one that hard-coded the glyph.

## Consequences

- **The rules and picks editors both get both behaviours**, because both mount `PeopleTrays`.
- **A narrow window is unchanged in substance.** `92vw` still wins on a phone, the board is one
  lane there, and the handle says "Move" — which is what the first report asked for.
- **`@charcuterie/ui` moves to `^3.24.0`.** The behaviour needs the library release; passing
  `moveIcon` against an older one puts the glyph back at every width.
- **Do not hard-code either affordance here.** Both have now been shipped and both were
  reported.

## Evidence

- Owner, 2026-08-27: *"I think the drag handles were fine, but now you have it in a 3-column
  mode, so dragging would work, but it has this 'move' button instead. The 'move' button would
  be best in that mobile view I showed you in the screenshot."*
- Owner, 2026-08-27 (the first report): *"For this Rules called 'Shorts', I can't seem to drag
  'n drop the names from Everyone Else anywhere else. There's no right-click or anything. How
  do I move these?"*
- `e2e/shot-tray-move.ts` — asserts the handle's visible text **at both board widths** rather
  than once: `≡` with three trays on screen, "Move" with one.
- Library tests: `Board.test.tsx` — *"a wide board's handle is the app's grip, not the word"*,
  *"a one-lane board's handle says Move, whatever the app passed"*, *"the handle has one name
  at both widths"*.

## Related

- [The tray move handle says "Move"](2026-08-27-the-tray-move-handle-says-move-it-does-not-wear-the-drag-glyph.md) —
  superseded in its first half; its 920px finding still stands
- [The queue editor is two trays](2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster.md)
- [A Rules queue carries people too](2026-08-26-a-rules-queue-carries-people-too.md)
- `AGENTS.md` "People on a queue"

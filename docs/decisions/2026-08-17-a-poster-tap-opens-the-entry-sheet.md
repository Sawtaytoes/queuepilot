# 2026-08-17 — A poster tap opens the entry sheet, and `#entrymodal` becomes that sheet

Status: Accepted
Date: 2026-08-17
Type: frontend (queue editor / tile gesture)
Supersedes: —
Superseded by: —

## Decision

**1. Tapping a poster opens that entry's sheet.**
With no selection running, a press on a tile's artwork that does not move past the drag
threshold opens `#entrymodal` for that entry. The gesture is resolved inside `useGridDrag`,
not by an `onClick` on the tile, because only the hook knows whether the press became a
drag.

The other two gestures on the same surface are unchanged and both still win where they
apply:

| gesture | before | now |
| --- | --- | --- |
| drag the poster | reorder | reorder |
| tap while something is selected | toggle that tile's selection | toggle that tile's selection |
| tap with nothing selected | **nothing** | **open the entry sheet** |
| tap the ▶ | play this entry | play this entry |

The third row is the whole change. That gesture was dead: the largest target on the tile
did less than the 26px ▶ sitting in the middle of it.

**2. `#entrymodal` is a SHEET, not a settings dialog.**
It gains a head — the artwork at 128px, the next-up line, and the two actions that do
something to the world rather than to this entry's settings (**Play on ▾** / **Open now**
on a pull queue, and **Remove**). The four settings it already had (count, weight, batch
stop, start point) follow underneath, unchanged.

The actions are their own full-width row rather than a column beside the poster: at a
390px width the poster leaves 203px, in which "Remove from this queue" wrapped to two
lines while ▶ sat at 110px — two cramped buttons in the panel whose entire reason for
existing is that the control on the tile was too small.

**3. The ▶ keeps its own tap, and is excluded explicitly.**
`.tileplay` is the one tile control that lives *inside* `.thumb`, so unlike `✓` and `✕` it
is not excluded by the "press must start on the poster" test. It is named in
`onPointerDown` alongside them. Its own `stopPropagation` is **not** enough and must not be
relied on: that stops the *click*, while this gesture is built on `pointerdown`/`pointerup`
listeners bound to the window, which a click handler cannot reach. Without the exclusion,
one tap on ▶ opened the device menu *and* the sheet on top of it.

## Context

Reported 2026-08-16 with a screenshot of the `cards` density in the Narrow View: *"I wonder
if it'd be better to have clicking the whole poster play it because the button is so tiny.
That or it zooms in on the poster. Not sure which is best here. I know the experience is
bad right now though."*

The premise was checked before it was acted on. The ▶ is 26px in `cards`/`list`, which
**clears** WCAG 2.2 AA (SC 2.5.8 is 24x24) — the complaint is that it is fiddly, not that
it is non-conforming. An earlier framing of this that called 26px "half the 44px minimum"
was wrong and was corrected: charcuterie explicitly
[dropped the 44px floor](https://github.com/Sawtaytoes/charcuterie/blob/master/docs/decisions/2026-08-05-controls-share-one-height-no-per-component-touch-floor.md),
because touch sizing is the **density axis's** job and 44px is AAA guidance, not an AA
requirement.

Three options were put to the owner: grow the ▶ via the density tokens, make the poster
play, or make the poster open the entry. He chose **open the entry**, which is the "zooms
in on the poster" half of his own instinct.

## Why

- **Play-on-tap collides with the two gestures already on that surface.** Tap-to-select and
  long-press-to-drag both live on the poster, and reordering a queue by hand is the queue
  editor's main job. Making the largest target commit to playback would also make the most
  destructive-feeling action the easiest one to trigger by accident on a phone.
- **The sheet is where everything is already full size.** Play, Start-from, Edit and Remove
  are each a real target there, so one gesture fixes the whole cramped cluster rather than
  just the ▶. The cost is honest and small: playing becomes two taps instead of one, and
  the one-tap path still exists on the ▶ itself.
- **The artwork is worth seeing.** 128px against the tile's 76px in `cards` is the
  "zoom in on the poster" the owner asked about, delivered as part of the sheet instead of
  as a separate lightbox nothing else would use.
- **It fills a gesture that did nothing.** No behaviour was taken away to make room.

## Evidence

- Owner, 2026-08-16 (image 4 of the Narrow View report): quoted above.
- Owner, 2026-08-17, choosing between the three options: **"Tap the poster opens the
  entry"** — described in the prompt as "big art + Play / Edit / Start-from / Remove",
  which is what the head implements.
- Owner, same exchange, rejecting the framing of the first attempt: *"I don't think 44px is
  right. You made that up and found it was wrong."*
- Measured, 390px: poster 128px, actions row full width; `.entrynext` collapses via
  `:empty` on a one-off movie so the head is artwork alone rather than a blank column.

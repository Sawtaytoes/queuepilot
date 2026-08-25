# The choice-tile exception is closed — Charcuterie owns the box

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** UI / component adoption
- **Supersedes:** —
- **Superseded by:** —
- **Extends:** [a control is a Charcuterie component configured by props](2026-08-21-a-component-configured-by-props-not-a-borrowed-class.md)

## Decision

Tonight's activity tiles, its Surprise Me scopes and its queue chooser are a
`RadioGroup` with **`itemShape="tile"`** from `@charcuterie/ui@3.16.0`. The
`.actgrid > [role="radio"]` block in `app.css` is **deleted**, not adjusted, along with
`.actgrid`, `.queuegrid`, `.actlbl`, `.actname` and `.acthint`.

Nothing in `web/src/styles/app.css` paints a Charcuterie control any more.

Two consequences are worth naming before somebody reads them as regressions.

**The hint is bigger: 13.94px → 15.94px.** The app's `.acthint` was `0.82rem` against a
17px root. The library draws a hint at `text-xs`, which is `0.9375rem` — the bottom of
Charcuterie's type ramp. That ramp was rebuilt on 2026-08-10 *specifically* to stop small
text sitting at 13px, so `0.82rem` was the magic number the ramp exists to remove. Do not
put it back with an app override; that is the borrowed-class defect wearing a font size.

**The e2e selectors moved off the deleted classes.** `tonight-test.ts` read `.actname` and
`.qcardname`; it now reads the tile's name structurally, through one `TILE_NAME` constant.
Every assertion is unchanged — six names, in the settled order, Surprise Me last, and no
provider brand anywhere on a tile.

## Context

WP-6 built these tiles and could not find the shape in the library, so it painted one and
said so in the CSS, in the same commit:

> "⚠️ THE ONE PLACE THIS FILE PAINTS A LIBRARY CONTROL … The real fix is a Charcuterie
> `ChoiceTile` (or an `appearance="tile"` on `RadioGroup`), at which point every rule in
> this block is deleted rather than adjusted."

That is the **"a shape the library cannot express yet"** exception the 08-21 record allows,
used exactly as written: the exception names its own end condition, and this is it.

A fleet survey then found four more apps hand-painting the same shape — bambuddy six times,
spoolbuddy, points-market and mux-magic once each, plus two in mail-sifter built on `Card`.
**Not one of the ten carried `aria-checked`.** So the shape was never QueuePilot's to keep,
and the library took it: `charcuterie:docs/decisions/2026-08-25-a-choice-tile-is-a-radiogroup-shape-not-a-third-component.md`,
named rather than linked because that path is not a URL from here.

## Why

- **The exception was time-limited by its own wording.** "Until it lands the app class stays
  and says why" is not a licence; it is a debt with the repayment written on it.
- **`itemShape` is a prop, which is the whole point of the 08-21 rule.** The adoption is
  `className="actgrid"` → `itemShape="tile"` and a composed `<span>` label → `label` +
  `hint`. No class reaches a Charcuterie component on this screen now.
- **The queue tiles came along for free**, because they were the *second* consumer of the
  same painted rule inside this one file. A shape spelled twice in one app was already over
  the library's bar before the fleet survey added eight more.
- **The implied queue card is deliberately NOT a tile.** One match is shown rather than
  asked about, so it is not a control, has no radio and keeps its own small `.qcard`. A
  `RadioGroup` of one would be a question with a single answer.
- **`minTileInlineSize={260}` on the queue chooser**, matching the 260px floor the deleted
  `.queuegrid` rule used: a queue name is a whole title and wants more room across than an
  activity's two words.

## Evidence

`__screenshots__/tonight-{before,after}-*.png`, seven frames each, from
`e2e/shot-tonight.ts` over the `Ada / Grace / Linus` fixtures — Wide View and Narrow View,
driven to a chosen tile, a two-match queue chooser and the implied single match.

Measured off the running page before the change, and reproduced by the library after it:
grid `repeat(auto-fill, minmax(min(200px, 100%), 1fr))` at `gap: 8px`, tile padding
`12px 14px`, `1px` border, `10px` radius, `surface-raised`, selected =
`intent-accent-solid` edge on `surface-overlay`. Everything except the hint's font size is
the same value, now stated as a token instead of a number.

Gates: `tonight-test.ts` and `narrow-scroll-test.ts` both pass.

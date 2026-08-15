# 2026-08-15 — The scrollbar gutter is reserved, so opening a modal cannot reflow the page behind it

Status: Accepted
Date: 2026-08-15
Type: frontend (layout / overlays)
Supersedes: —
Superseded by: —

## Decision

`html { scrollbar-gutter: stable; }` — always, even on a page short enough not to need a
scrollbar.

## Context

The owner opened an entry's panel over the Anime channel and the queue *behind* it silently
re-laid itself out from two columns to three; closing the panel put him somewhere else in
the list than where he had been.

Two mechanisms, one cause:

1. Both `html.modal-open` (this app's own rule) and `@charcuterie/ui`'s `lockScrollBehind`
   freeze the page by setting `overflow: hidden` on `<html>`.
2. On a **classic** (non-overlay) scrollbar that *deletes* the scrollbar and hands its ~15px
   back to the layout viewport.

The grid is `repeat(auto-fill, minmax(340px, 1fr))`. At the wrong window width those 15px
are a whole extra column — and the three-column document is *shorter*, so the scroll position
gets clamped to the new maximum. Restoring the width on close does not restore the clamp.
"The formatting changes" and "the scroll position resets" are the same bug seen twice.

Measured on the real grid: with the toolbar chrome at 48px, two columns hold from a 692px to
a 1043px grid, and three begin at 1044px — so any window between roughly 1092px and 1106px
wide sits close enough to the boundary that the scrollbar's own width crosses it. Confirmed
by stepping the viewport 1091px → 1106px → 1091px: column count went 2 → 3 → 2 and
`scrollHeight` 1345 → 1049 → 1345.

## Why

**Fix the width, not the symptom.** Reserving the gutter makes the layout viewport width
*invariant* under the scroll lock, which kills both symptoms at once and needs no
scroll-position save/restore dance, no ordering assumption about whose effect runs first
(Charcuterie's `Modal` is a child of this app's `Modal`, so its effect fires *before* the
parent's — the app could not reliably snapshot `scrollY` ahead of the lock anyway), and no
patch to a shared library on its own release cycle.

**Not fixed upstream.** `lockScrollBehind` is the honest place for a gutter-compensating
`padding-right`, and arguably belongs there. But that is `@charcuterie/ui`'s call and its
own version bump; one CSS line here is correct for this app today and costs nothing if the
library later compensates too.

**The cost is one always-present gutter** on short pages that would otherwise show none.
Checked against `e2e/narrow-scroll-test.mjs` at 390px and 320px — no horizontal scroll
appears at either width (`scrollWidth` 375 ≤ 390, 305 ≤ 320), which was the real risk.

## ⚠️ For whoever tests this next

**The sandbox's headless Chromium uses OVERLAY scrollbars, which take no layout width — this
bug is invisible there.** Opening a modal in Playwright shows nothing wrong, at any viewport,
with or without the fix; `--disable-features=OverlayScrollbar` does not change it and neither
does `channel: 'chromium'`. Reproduce it by changing the viewport width by 15px and watching
the column count and `scrollHeight`, which is the same physics with a different trigger. The
owner's desktop browser is where the real symptom lives.

## Evidence

Owner, with before/after screenshots of the channel with the start-point modal open
(2026-08-15):

> "When I click the episode, the whole thing changes formatting, and when I close the modal,
> the scroll position resets. That's not how it's supposed to work."

His two screenshots show the same channel at two columns (no modal) and three columns (modal
open), which is the reflow this fixes.

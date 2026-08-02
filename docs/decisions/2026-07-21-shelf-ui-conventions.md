# Shelf/tile UI conventions: reserved scrollbar space, edge shadows, zoom-proof glyphs, 480px posters

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** UI convention
- **Supersedes:** —
- **Superseded by:** —

## Decision

Home-shelf and tile chrome, per live user feedback (2026-07-20/21):

- **Scrollbar**: thin, **always occupying its space** (`scrollbar-width: thin` with a
  transparent `scrollbar-color` until `:hover` paints the thumb). Never toggle the
  scrollbar's existence or swap padding for it — both shift the whole UI ("Right now,
  the whole UI is shifting when it appears and disappears. I don't want that."). Style
  it via the STANDARD `scrollbar-color`, not `::-webkit-scrollbar` — any non-auto
  `scrollbar-width` disables webkit pseudo styling (that produced a stark white bar).
- **Overflow cues**: gradient **edge shadows** per side, shown only when more items lie
  that way; the scroll **arrows hide at their end of travel** and the right arrow gets
  its own gradient direction instead of `rotate(180deg)` (which flipped the glyph).
- **Icon glyphs on tiles are SVG, not text** (the remove ×): font glyphs drift
  off-center at fractional zoom (user hit it at 150%).
- **Posters** transcode at **480x720** via the proxy (300px pixelated at 150% zoom /
  HiDPI); bump the `?v=` cache-buster when changing this.
- **Drag correctness**: strips/grid set `overflow-anchor: none` and disable
  snap/smooth while dragging — scroll anchoring shifted the strip one slot per
  insertion, compounding the drop position far right of the pointer.
- **Search dropdowns** support ↑/↓/Enter/Esc; picks are delegated on the list (a
  per-row listener dies when a late response re-renders mid-click) and stale search
  responses are dropped.

## Context / Why

All items were user-reported regressions or asks against the live editor; recorded so
future UI work doesn't quietly revert them.

## Evidence

User, 2026-07-20/21: shelf-arrow report ("the right-most arrow is a left arrow…
should also disappear"), scrollbar-on-hover ask, "keep space for it… the whole UI is
shifting", "didn't you fix the (X) at 150%?", poster pixelation vs Plex comparison,
"When filtering, I can't use the arrow keys… clicking one doesn't seem to work either."

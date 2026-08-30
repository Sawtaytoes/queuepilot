# The shell has one vertical scroll owner

**Status:** Accepted  
**Date:** 2026-08-30  
**Type:** UI / layout  
**Supersedes:** None  
**Superseded by:** None

## Decision

`Shell` occupies one dynamic viewport. Its `Main` region owns vertical scrolling on every
work page. `html` and `body` do not add height or bottom clearance outside that shell.

The fixed selection bar reserves space only while it is visible, through the selected
view's `.move-mode` padding. It does not reserve permanent space on `body`.

Edge auto-scroll for queue and shelf drags follows the same nearest vertical scroll region.
It does not call `window.scrollBy` when `Main` owns the page.

The always-on browser layout gate measures both document axes on every route. A work page
fails when `documentElement.scrollHeight` exceeds `documentElement.clientHeight`.

## Context

Pending uses a virtual grid inside Charcuterie's scrollable `Main`. The grid previously
observed the window while its spacer enlarged `Main`. After the shared grid followed its
nearest scroll region, an unrelated 80px `body` padding still made the document taller than
the viewport. That obsolete padding came from the layout before `Shell`; `.view.move-mode`
already provides the required clearance when the fixed selection bar is open.

## Why

Two vertical owners provide two scrollbars with different ranges. The document owner also
exposes dead space below the viewport shell. One owner gives the virtualizer the same scroll
event and geometry that the user controls.

## Evidence

The owner reported in this session: “It should be 1 scrollbar with no blank space randomly
padded for tens of thousands of pixels.”

Live measurement after the shared virtual-grid release found the grid reached its final
item with `padding-block-end: 0px`, but the document still measured 857px in a 777px
viewport. The remaining 80px matched `body { padding-bottom: 80px }` exactly.

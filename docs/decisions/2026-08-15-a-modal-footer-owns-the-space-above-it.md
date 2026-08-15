# 2026-08-15 — A modal's footer owns the space above it

Status: Accepted
Date: 2026-08-15
Type: frontend (modal chrome)
Supersedes: —
Superseded by: —

## Decision

`.modalbtns` carries `margin-top: 14px` on all four modals (`#startmodal`, `#setmodal`,
`#dynmodal`, `#entrymodal`). The `.idnote` line gives up its `14px` bottom margin, which was
silently doing that job for three of them.

## Context

Right-aligning `#entrymodal`'s Done button
([2026-08-15 tile controls](2026-08-15-tile-controls-are-quiet-and-sit-beside-the-poster.md))
put it directly beneath the start-point row's "Choose…" button — and they touched. The owner
circled it and asked the right question: *"Don't we have some controls to ensure padding?"*

**No. There was no such control.** Measured across all four modals before the fix:

| modal | last body element | gap to footer | footer `margin-top` | footer `padding-top` |
| --- | --- | --- | --- | --- |
| `#entrymodal` | `.entryfields` | **0px** | 0px | 0px |
| `#setmodal` | `.idnote` | 14px | 0px | 0px |
| `#startmodal` | `.idnote` | (tall) | 0px | 0px |

Nothing in the stylesheet reserved space between a modal's body and its buttons. The three
that looked correct were borrowing `#startmodal .idnote, #setmodal .idnote, #dynmodal .idnote
{ margin: 10px 0 14px }` — the trailing margin of whatever happened to be the last element in
the body. `#entrymodal` has no `.idnote` at all, so its body ended flush against the footer.

That was already true before the Done button moved. It was invisible only because Done sat on
the LEFT, under the short "Automatic — the next unwatched" text, so 0px read as "tight"
rather than "touching". Right-aligning it moved Done underneath "Choose…", where a 0px gap
and a 14px horizontal overlap became an obvious collision.

## Why

**The footer is the one element present in every modal**, so it is the only place the rule
can live and be true for a modal that has no `.idnote`, an empty `.idnote` (`#startmodal`
hides its when empty), or a body element nobody has written yet. Putting spacing on the last
body element means re-deciding it every time a modal's last row changes — which is exactly
the bug.

**14px, and `.idnote` loses its bottom margin**, so the three modals that were already
borrowing that number are pixel-identical rather than gaining a second 14px. Verified after
the change: `#setmodal` still 14/15px, `#startmodal` unchanged, `#entrymodal` 0px → 14px.
Only the broken one moved.

## Evidence

Owner, on the shipped right-aligned Done:

> "These are touching"

> "Yeah, why's that? Don't we have some controls to ensure padding?"

Measured after: `Choose -> Done vertical gap: 14px (footer margin-top 14px)`.
Shot: `docs/images/2026-08-15-entry-modal-footer-gap-after.png`.

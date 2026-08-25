# 2026-08-25 — ✓ stacks under ✕; Edit is a pencil pill by the labels

Status: Accepted
Date: 2026-08-25
Type: frontend (queue editor / tile chrome)
Supersedes:
  [2026-08-25-edit-is-a-pencil-icon-in-the-tile-chrome](2026-08-25-edit-is-a-pencil-icon-in-the-tile-chrome.md)
  (that record put the pencil in the top-right chrome next to ✕; this one moves it)
Superseded by: —

## Decision

**1. ✕ and ✓ share one trailing stack: ✕ on top, ✓ under it.**
`.tilechrome` is a flex column at the top-right of the poster (in-flow on Cards/List).
Select no longer sits across the poster from remove, and the two are no longer three-abreast
with Edit.

**2. Edit is an outline pencil pill in the badge row, next to the setting tags.**
Same `BadgeButton` shape the old text "Edit" chip used; the label is a pencil glyph, not
the word. Always visible with the tags — not quiet chrome. Away from ✕ on purpose.

**3. Why.**
Three icons in a row invited mis-hits on ✕. Stacking select under remove keeps both
reach-ins on one edge without putting a destructive control beside an everyday one; putting
Edit with the labels puts the settings door where the settings already are.

## Context

Owner, on the live `/q/kevin` poster wall after the first pencil-chrome pass:

> I don't like those 3 icons next to each other.
>
> Honestly, I'd put the checkmark under the X and move the edit down by the labels. I wanna
> make it so I don't accidentally click the X.

And on the pencil's shape by the labels: outline pill with a pencil glyph (not bare chrome,
not the old text "Edit").

## Evidence

- Owner, 2026-08-25: quoted above.

# 2026-08-25 — Edit is a pencil icon in the tile chrome, not a text chip in the badge row

Status: Superseded
Date: 2026-08-25
Type: frontend (queue editor / tile chrome)
Supersedes: the quiet text `Edit` chip half of
  [2026-08-14-entry-settings-are-tags-plus-a-panel](2026-08-14-entry-settings-are-tags-plus-a-panel.md)
  (that decision's tags-plus-panel rule stands; only the *door* moves)
Superseded by:
  [2026-08-25-checkmark-under-x-edit-by-the-labels](2026-08-25-checkmark-under-x-edit-by-the-labels.md)

## Decision

**1. Edit is a pencil icon in the top-right tile chrome, left of ✕.**
Same quiet-until-hover / always-on-touch treatment as ✓ and ✕
([2026-08-15](2026-08-15-tile-controls-are-quiet-and-sit-beside-the-poster.md)). On the
poster wall it overlays the artwork's top-right corner; in `cards` / `list` it takes its
own trailing grid column between ✓ and ✕. The accessible name and the tooltip still carry
the words the old chip put on screen ("episodes per turn, weight, …").

**2. The badge row no longer carries a text "Edit" chip.**
Setting tags stay pressable doors into the same sheet. A default entry that shows no tags
still has a door — the pencil — so the panel is never only reachable by right-click.

**3. `.editbtn` stays the e2e / DOM handle.**
It moves off the badge and onto the chrome button. Suites that click `#grid .tile .editbtn`
keep working; the class now paints (with `.remove`), it is no longer a paint-free selector
beside `.weighttag` / `.startbadge`.

## Context

Owner, pointing at a queue poster wall and at Mail Sifter's archive glyph in the top-right
of a mail card:

> "Edit" should be an icon in the top right the same way we do it on Mail Sifter now with
> the archive icon.

Confirmed on the queue posters at `/g/<group>` → `/q/<id>`, not the shelf and not Docket.

## Why

- **A text chip is always on.** The 2026-08-15 quiet-chrome rule already settled that tile
  affordances should not paint a wall of buttons; Edit was the one control that still did,
  on every resolved tile, even at defaults.
- **The corner is the fleet pattern.** Mail Sifter's archive is a ghost icon in the card's
  top-right. Matching that beat inventing a fifth badge look for a door that is not a state.
- **It stays with ✓ and ✕ rather than becoming a Charcuterie `IconButton`.** Those two are
  scrim circles painted by `app.css` so the quiet opacity and the cards/list gutters can
  own them; a library `IconButton` with a `className` would be the smell
  [2026-08-21](2026-08-21-a-component-configured-by-props-not-a-borrowed-class.md) forbids,
  and would not match the pair beside it. The Mail Sifter reference is the *placement and
  the icon-only shape*, not the component.

## Evidence

- Owner, 2026-08-25: quoted above; follow-up clarifying QueuePilot queue posters (URL
  `https://queuepilot.octen.dev/g/sawtaytoes`) and "Edit pencil icon button yes."

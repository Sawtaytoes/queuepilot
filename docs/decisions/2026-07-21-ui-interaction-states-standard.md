# Every interactive element must have obvious hover, focus (keyboard), and motion states

- **Status:** Accepted
- **Date:** 2026-07-21
- **Type:** preference / UI standard
- **Supersedes:** —
- **Superseded by:** —

## Decision

Everything interactive in the plex-channels web UI must have, as a baseline:

1. **An obvious hover state** — a clear visual change on `:hover` (color, background, border,
   elevation). No interactive element may look identical hovered vs. not (e.g. the editable title
   must visibly react when hovered).
2. **A visible keyboard focus state** — a clear `:focus-visible` indicator (outline/ring) on every
   focusable control, so the UI is fully keyboard-navigable and you can always see where focus is.
   Do not remove focus outlines without replacing them with something at least as visible.
3. **Motion / animation feedback** — state changes and actions animate rather than snapping:
   transitions on hover/active, a lift + placeholder while dragging, toasts that animate in/out,
   view/section changes with motion where it aids comprehension. The user's rule: *"everything needs
   to have some sort of animation and obvious hover and keyboard state."* (Motion that would fight a
   live gesture is the documented exception — see the mid-drag re-render Pitfall in
   `web-ui-handoff.md`; use transform-only FLIP, never a re-render, during drag.)

Treat this as a review checklist item: a new control or view isn't done until its hover, focus, and
motion states are present and verified (screenshot-verify per the fake-data harness).

## Context

During the v2/v3 live QA Bob repeatedly hit elements with no feedback: dragging queued items had no
animation (*"hard to tell what's happening"*), and hovering the editable title gave *"no indication
this is being hovered."* Rather than fix these one-off, he asked for a standing standard so every
element carries these states by default.

## Why

- **Discoverability & confidence:** hover/motion feedback tells the user what's interactive and that
  their action registered.
- **Accessibility & power use:** visible focus states make the whole UI keyboard-operable, not just
  mouse-operable.
- **Consistency:** a single standard beats ad-hoc per-element fixes and keeps the app feeling
  cohesive.

## Evidence

Bob, 2026-07-21: *"We need to make a decision doc that everything needs to have some sort of
animation and obvious hover and keyboard state."* · *"There's no animation when dragging around
queued items… hard to tell what's happening."* · *"When hovering the title to edit, there's no
indication this is being hovered."*

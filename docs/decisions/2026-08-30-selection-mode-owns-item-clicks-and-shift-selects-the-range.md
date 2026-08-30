# Selection mode owns item clicks and Shift selects the range

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** Interaction / correction
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:**
  [The queue web UI uses one explicit multi-selection mode](2026-07-20-queue-web-ui-ux-and-write-format.md)

## Decision

After one queue entry is selected, selection mode owns a click on the non-control surface of
every visible item. The click toggles that item. It does not open the entry or follow its title
link. The rule applies in Posters, Cards and Rows density; the artwork is not the only selection
target.

A normal selection click becomes the range anchor. Shift-clicking another item's check control
or non-control surface adds the inclusive range between the anchor and that item. The range uses
the current visible order: Priority first, then Random, after the current filters. It does not
select filtered-out entries. Repeated Shift-clicks keep the original anchor.

The item's own controls remain controls. Remove, Play, Edit, the Priority position and the lane
action do not become selection targets.

## Context

The pointer gesture only listened inside `.thumb`. Its own comment promised that a plain poster
tap toggled an entry after selection started, but Cards and Rows density put most of an item
outside the poster. Clicking that larger surface therefore did nothing for selection. A title
link could navigate away instead.

Selection state also stored only a set of entries. It stored no anchor and the pointer-up handler
discarded the pointer event, so no code could distinguish Shift-click from a normal click or
compute a range.

## Why

- Selection mode must make the item itself the large target.
- Shift-range selection must match the order the person sees.
- Additive range selection keeps earlier deliberate selections intact.
- Explicit controls must keep their own actions during selection mode.

## Evidence

Owner, 2026-08-30, current conversation and attached Queue page image:

> “Queue page, holding SHIFT isn't selecting all in-between QueuePilot.”

> “Also, in \"selection\" mode when you click the checkbox, clicking on other items is supposed
> to check them too, but that's not happening either.”

> “Make sure these decisions are recorded in the repo.”

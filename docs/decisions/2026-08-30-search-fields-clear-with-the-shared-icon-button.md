# Search fields clear with the shared icon button

Status: Accepted
Date: 2026-08-30
Type: UI consistency
Supersedes: None
Superseded by: None

## Decision

Every QueuePilot search and text-filter field uses Charcuterie `SearchInput`. Its clear X is
an app-owned glyph inside the component's labelled `IconButton`. The browser's native cancel
widget and the app's one local implementation are both retired.

## Context

`SearchDropdown` already replaced the browser X with a full control-sized icon button. The
Home queue filter, queue-entry filter, and board-game collection search still used the
platform widget. The same action therefore changed its size and appearance by route.

## Why

The clear action is the same action in every field. Charcuterie now owns its target, focus
return, accessible name, field padding, and native-widget suppression. QueuePilot supplies
only the glyph and query state.

## Evidence

Owner, chat `t3code-95952451`: “All search boxes with an X inside should probably have that
as an icon button. We did it in QueuePilot in one place, but all the other filter boxes don't
use it. I don't like one-offs like that. I like to make changes like that fleet-wide.”

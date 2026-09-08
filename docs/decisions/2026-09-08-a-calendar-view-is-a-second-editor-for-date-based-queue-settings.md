# A calendar view is a second editor for date-based queue settings, not a read-only summary

**Status:** Accepted
**Date:** 2026-09-08
**Type:** UI / product rule / routing
**Supersedes:** —
**Superseded by:** —

## Decision

Date-based queue settings — the reset date and the season window — are editable in **two**
places, and both are first class.

1. **The Set editor**, on the queue itself. This is where a queue's own settings live.
2. **A calendar view**, which shows every queue that has a date and lets the owner change it
   there.

The calendar view **edits**; it does not merely list. A read-only summary was rejected.

- **Neither surface owns the value.** The stored setting on the set is the single source of
  truth, and both editors write it. There is no calendar-only field.
- **A queue with no dates does not appear.** The view is a list of scheduled queues, not a
  roster of every queue with empty columns.
- **It is a text-heavy list, so it is ONE COLUMN at every width.** A row is a queue name, its
  dates and what happens on them. That is prose, and prose is scanned down a column. This is
  the narrowed grid rule, not an exception to it
  (`agentic:docs/decisions/2026-08-25-a-text-heavy-row-list-is-one-column-narrowing-the-grid-rule.md`
  — a sibling workspace repo, so it is named rather than linked).
- **It is a route with a path URL, added to `routePaths.ts` and to the `<Routes>` table in
  the same change.** No `#/`.

## Context

Asked whether the calendar settings should live only on each queue, or also get a view, the
owner chose both:

> "I want both a calendar view, and it being in settings. The calendar view provides
> _another_ mechanism for maintaining it."

The recommendation offered was per-queue only, on the grounds that one seasonal queue exists
today. The owner overrode it. The reasoning holds regardless of today's count: the view is
how somebody answers "what is scheduled this year" without opening every queue in turn, and a
view that can show a wrong date but not fix it sends the reader somewhere else to fix it.

## Why

- **Two editors, one value, is the honest shape.** The alternative is a view that displays a
  setting and then makes the reader navigate away to change it.
- **The cross-queue question is real.** "Which queues come back in October" is not answerable
  from a per-queue modal at all.
- **It scales with the feature.** The first seasonal queue makes the view thin. The third
  makes it the only sensible place to work.

## Evidence

Owner, 2026-09-08, quoted above.

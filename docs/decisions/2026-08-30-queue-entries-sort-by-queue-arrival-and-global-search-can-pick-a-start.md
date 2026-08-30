# Queue entries sort by queue arrival, and global search can pick a start

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** Queue data / UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

Every new queue entry receives `queued_at` when `queues.addItem()` writes it. The queue view's
Sort picker offers **Recently added**, newest first. The explicit sort is stable inside both the
Priority queue and the Random pool. An old entry with no honest stamp follows every stamped entry
and keeps its relative order; no migration invents a date for it.

The global search gives shows and collections the same pre-add **Start at…** control as Pending.
The choice stays in browser state until the person chooses a queue. A real add writes the entry,
then writes its start through the existing start endpoint. A duplicate does not overwrite the
start point of the entry already in the queue.

The entry sheet remains the post-add editing surface. Its **Start point** row and episode count
control use the same writers as before.

## Context

The Random pool always displayed alphabetically. That made lookup easy, but it hid which entries
had joined the queue recently. File order was not a queue-arrival date, and Plex's `addedAt` was
the date an item joined Plex rather than the date it joined this queue.

`EntryExtras.queued_at` already existed as the queue-arrival boundary for providers that count
lifetime progress. Reusing it keeps one date concept on an entry and gives every add path the same
answer.

Pending could choose a start episode or collection member before an add. Global search could only
add. An entry already in a queue could change the same fields from its sheet, but the global entry
path did not expose the pre-add choice.

## Why

- Queue arrival answers the stated question: which entries were added to this queue recently.
- One stamp serves display order and provider progress without two dates that can drift.
- Old entries remain honest. Their exact arrival time is unknown.
- An explicit sort applies consistently to both visible lanes.
- The global and Pending flows share `StartModal` and the same two-write contract.
- The duplicate guard prevents a search choice from becoming an unintended edit.

## Evidence

Owner, chat request, 2026-08-30:

> *"I wanna make it so you can sort the random area (or maybe even the priority one) alphabetically or by date added. That way, I can find which ones I recently added and see if I need to change the episodes or something."*

> *"The only place you can change that info is under Pending when adding them. It'd be nice to have that ability also when searching globally and in the item itself."*

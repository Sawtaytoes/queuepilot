# People groups use explicit rules and the queue audience is one vertical list

- **Status:** Accepted
- **Date:** 2026-08-29
- **Type:** UX / data model
- **Supersedes:** [The Groups editor is retired](2026-08-27-the-groups-editor-is-retired.md)
- **Superseded by:** —

## Decision

1. QueuePilot keeps people groups as saved people rules. A group has required people, optional
   people, and a minimum required count. The rule is shown in plain language wherever the group
   appears.
2. A queue audience is one vertical list. It has three sections in this order: Must be here,
   Nice to have, and Everyone else.
3. Every person and people group has the same visible three-way audience control. Selecting
   Must, Nice, or Exclude moves the row to that section and writes the queue audience.
4. The People editor links to an editable people-group rule editor. It can create, rename,
   edit, and delete groups. Editing a rule does not change the group's provider profile claims
   or set claims.

## Context

The previous change removed the Groups editor while keeping group data because queues still
used group audience rules. That left existing groups visible in queue audiences without a way
to edit them. It also made a group look as if it had the same meaning as a queue's Must or Nice
section, even though a group contains its own people rule.

The owner clarified the intended model:

> "These groups are confusing when you have to place them in one of the \"must be\" or \"nice to have\" sections."

The queue placement and the group's internal people rule are separate decisions. The interface
must show both decisions without making the user infer one from the other.

## Why

- A saved group remains useful for rules such as a minimum number of people from a set, or a
  required pair with an optional person.
- A visible rule summary makes a group understandable before it is placed on a queue.
- One row shape for people and groups removes the special handling that made the old three-tray
  editor hard to scan.
- Deleting a group now removes its group roster and queue audience references. This prevents a
  deleted group from remaining as an unusable queue member.

## Evidence

- Direct user quote: "These groups are confusing when you have to place them in one of the \"must be\" or \"nice to have\" sections."
- Chat id: not exposed in this T3 Code session.

# Changing a queue default preserves every existing lane

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** Queue semantics / correction
- **Supersedes:** —
- **Superseded by:** —
- **Builds on:**
  [A Picks queue lives on the Picks screen, whichever lane it defaults to](2026-08-26-a-picks-queue-lives-on-the-picks-screen-whichever-lane-it-defaults-to.md)

## Decision

`add_as` answers where a NEW entry lands. Changing it never moves an existing entry.

Before the writer changes `add_as`, it gives every existing entry that inherited the old
default an explicit `placement` equal to that old default. Existing explicit placements stay
unchanged. An entry added after the change remains sparse and inherits the new default.

The preservation write happens before the default write. If the second write fails, the queue
has gained redundant explicit placements but its behaviour has not changed. The reverse order
would expose the destructive state this correction removes.

## Context

Queue entries store `placement` sparsely. An absent value means "follow this queue's `add_as`."
That representation made a settings-only edit reinterpret every sparse entry immediately.
Four live queues changed from Priority by default to Random by default, which made their prior
Priority plans appear to become random even though the queue order itself remained on disk.

The persisted undo history held the pre-change snapshots. The recovery compared each affected
queue with its own snapshot and stamped only still-present, still-inherited entries. Later
additions, removals, explicit lane changes and order changes stayed intact.

## Why

- A default describes future assignments. It is not a bulk-edit control.
- Preserving the effective lane keeps a settings edit from changing playback behaviour.
- Explicit placements record the boundary between entries that existed before the change and
  entries that arrive after it.
- One queue-file rewrite preserves the whole lane set under one lock.

## Evidence

Owner, 2026-08-30, current conversation:

> “When you change the queue mode, I thought that only changed the default of where stuff gets
> assigned, not that it suddenly changes my queue.”

The live undo history held four `priority` → `random` set changes. Their queue snapshots showed
95 still-present entries whose absent placement inherited Priority before those changes.

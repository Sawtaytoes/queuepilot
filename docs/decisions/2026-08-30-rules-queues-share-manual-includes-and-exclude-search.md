# Rules queues share manual includes and exclude search

- **Status:** Accepted
- **Date:** 2026-08-30
- **Type:** product / UI / playback correction
- **Supersedes:** the progress-only visibility rule for `ChannelMembers`
- **Superseded by:** —

## Decision

Shows and Movies Rules queues expose the same two direct controls:

- A search field in the eligibility filters adds an item to the queue's exclusion list.
- A Members section adds explicit manual includes on top of the rule-derived pool.

The two exclusion stores keep their existing engine shapes. Shows write `blocklist` on the
set. Movies write `movie_excludes` on the active profile binding. The movie search offers
direct movie leaves because a show-library result names a parent show while the rewatch
engine excludes its playable episode key.

Movies Rules queues accept direct movie members. A movie member joins the rewatch candidate
map at the least-watched floor when the normal rule does not already contain it. A real
history count wins when one exists. A manual include wins over an exclusion for the same key,
matching the Shows path where members are resolved separately from the blocklist and win the
candidate de-duplication.

## Context

The Shows editor already had both controls. The Movies editor listed existing rewatch
exclusions with Un-exclude actions, but it had no way to search for another movie. The shared
Members component was mounted for both behaviors and then hidden for Movies. The rewatch
playback branch also ignored `members`, so removing only the UI gate would have created a
control that saved data which never played.

## Why

Both screens edit the same product kind: a Rules queue. The storage names differ because the
selection engines differ, but that implementation detail does not justify different editing
capabilities. A person must be able to add or remove an exception without finding the title
first in a sampled eligible grid.

## Evidence

The owner said: *"For the Rules queues"* and *"we do have that, but only for shows, not
movies????? It should be consistent."* (T3 Code chat, 2026-08-30.)


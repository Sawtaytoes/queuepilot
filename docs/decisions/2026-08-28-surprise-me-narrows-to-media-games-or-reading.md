# Surprise Me narrows to Media, Games or Reading

- **Status:** Accepted
- **Date:** 2026-08-28
- **Type:** Product / Tonight
- **Supersedes:** the unresolved Surprise Me grouping in the 2026-08-25 Tonight plan
- **Superseded by:** —

## Decision

The Surprise Me second step offers exactly three scopes:

- **Media:** Movies and Shows. YouTube joins this scope when its provider is built.
- **Games:** Video Games and Board Games.
- **Reading:** Reading.

The browser chooses an activity uniformly inside the selected scope and delegates the draw to
that activity's existing engine. Queue activities still use the queue-first engine. Board Games
still uses the shelf picker. If an activity has no eligible result, the draw tries the other
activities in the same scope before it reports that the scope is empty.

The resulting session records the activity that produced the result. Its result card, shortlist
and reroll therefore keep that activity's established rules and backend binding. This does not
add a third picker.

A bare Surprise Me preset remains refused. A fixed preset cannot answer the required scope
question.

## Context

The Surprise Me route and second screen already existed behind an empty `SURPRISE_SCOPES` seam.
The 2026-08-25 plan settled that the grouping must be coarser than the activity tiles, but left
the exact list open rather than guessing it.

Media currently has two implemented activities. Its label and data model deliberately leave room
for the planned YouTube provider without adding a fourth scope later.

## Why

The three scopes match the type of evening a person can choose without repeating the six activity
tiles. They also preserve the app's two authoritative selection engines. The scope selects which
engine to ask; it does not duplicate either engine's eligibility rules.

Trying the remaining activities avoids reporting an empty scope only because the first random
activity had no eligible result.

## Evidence

On 2026-08-28, the owner approved this exact proposed grouping:

> Media — Movies, Shows, future YouTube  
> Games — Video Games, Board Games  
> Reading — Reading

The owner's response was:

> yes

The uniform activity draw, fallback order and backend binding are implementation choices. They
are not attributed to the owner's one-word approval.

## Related

- [`2026-08-25-pick-draws-a-queue-not-an-item.md`](2026-08-25-pick-draws-a-queue-not-an-item.md)
- [`2026-08-23-tonight-is-people-activity-filter-go.md`](2026-08-23-tonight-is-people-activity-filter-go.md)

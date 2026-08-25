# A group PLAYS AS its own account, not as its roster's union

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** Architecture / data model
- **Supersedes:** —
- **Superseded by:** —

## Decision

A group answers **two different questions** about provider accounts, and WP-5 separates them
into two functions that must never be merged.

| Question | Function | Answer |
| --- | --- | --- |
| **MEMBERSHIP** — which sets does this group hold? | `people.ts accountsForGroup()` | the group's own `accounts:` **unioned** with every person's |
| **IDENTITY** — which account does a session sign in as? | `queuePeople.ts groupPlayProfile()` | **exactly one**, or a refusal |

`groupPlayProfile(kind, groupAccounts, roster)` resolves in this order:

1. The group's **own** `accounts[kind]`, when it names exactly **one**.
2. Otherwise the roster's union, when that is **unanimous**.
3. Otherwise `ambiguous`, with every candidate named.

`PUT /api/sets/:id/people` **refuses** a group member whose answer is `ambiguous`, for any
provider kind actually in the registry. It does not choose one, does not sort, and does not
warn-and-write.

## Context

WP-5 made a queue *required people + optional people + one activity*, and a member of a queue
may be a whole group — because "Older Kids" is one card carrying its own **at least one of
them** rule, and flattening it to its people would turn "either of them" into "both".

That put a new load on something that had been true by accident. Two live queues carry
`requires_profile`, which is both a **play gate** (the scan waits, and ADB-switches the Shield,
until that Plex Home profile is signed in) and an **identity** (the queue's next-up and watched
state are read as that account). A queue keyed on a group has to resolve that to one account
**before it knows who turned up**.

## Why

**The union cannot answer it, and the reason is in this repo's own comments.** `groups.ts`
records that the mapping is deliberately N-to-M: *"Carol is two Plex accounts (Older Kids,
Younger Kids) and one Kavita user."* A three-person roster can therefore offer three Plex
accounts, and "at least one of them" means the app cannot know in advance which subset arrived.
A union-based identity would sign into whichever account sorted first — a silent, plausible,
wrong answer, and the failure it produces is a kid's queue reading the owner's watched history.

**The group's own `accounts:` is the right source precisely because it does not vary.** It is a
fixed fact about the group, stated once, and it is what `requires_profile` has always meant. The
roster union survives only as a fallback for a group that never named one, and only when it is
unanimous — which is the case where there is nothing to choose between.

**Merging the two functions is the tempting mistake, so it is called out in both files.**
They look like the same query and they are opposites: membership must be GENEROUS (dropping
either half loses sets out of a group with no error, which `groups.ts` spends a paragraph on),
and identity must be SINGULAR. One function cannot be both.

**Refusing beats resolving.** An ambiguous group is a household configuration question — "which
profile do the Kids play as?" — and the answer is one line in `groups.yaml`. Writing the member
anyway and picking a profile at play time moves the failure from a save button, where somebody
is looking, to a Shield at 8pm, where nobody is.

## Evidence

The rule the owner stated, 2026-08-25, answering the WP-5 mockup's §6 questions:

> "For those queues, none of the kids are required, but at least 1 is."

and the constraint the plan states it must not break:

> "A group still resolves to **exactly one provider profile**, so a queue keyed on Older Kids
> signs into the Older Kids Plex profile no matter which of the kids turned up."

Gated by `e2e/queue-people-test.ts`, which keys a queue on a group holding two Plex accounts and
asserts a **400** naming both, plus that nothing was written.

## Related

- The product records live in a sibling workspace repo, not on GitHub:
  `agentic:docs/decisions/2026-08-25-a-queue-is-people-plus-an-activity.md` and
  `agentic:docs/decisions/2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster.md`
- [A group is a saved set of people, and the identity match is manual](2026-08-23-a-group-is-a-saved-set-of-people-and-the-identity-match-is-manual.md)
- [A curated queue plays as the profile it is gated to](2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to.md)

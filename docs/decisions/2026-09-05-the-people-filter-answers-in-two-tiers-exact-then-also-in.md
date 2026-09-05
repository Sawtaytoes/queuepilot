# The people filter answers in two tiers — exact, then also-in

- **Status:** Accepted
- **Date:** 2026-09-05
- **Type:** UI / product / correction
- **Supersedes:** the one-tier half of [the landing filters by people and the group chips go](2026-08-26-the-landing-filters-by-people-and-the-group-chips-go.md)
- **Superseded by:** —

## Decision

The people filter on `/queues` and `/admin` returns two groups of queues, drawn in this order
and separated by a rule:

1. **Exact.** Every ticked person is on the queue AND every required person is ticked. This is
   the rule that shipped on 2026-08-26, unchanged.
2. **Also in.** Every ticked person is on the queue, but the queue also requires somebody who
   is not ticked.

A queue where a ticked person is not on the roster at all is still not shown. That is the one
thing the second tier does not relax.

The rule between the two names who the queues below it still want, up to three people, then a
count. Nothing below the rule is hidden.

Inside the also-in tier, queues sort by how many required people the selection is short of —
nearest miss first — then by the order the page already had, which is the file order the owner
arranged.

The count on a person's filter control counts **both** tiers.

The server's pick rule does not change. `queuePeople.ts queueMatchesSelection()` is still the
exact rule, and `membersMatchPeople()` in the browser is still its mirror.

## Context

The one-tier filter made a control you had to already know the answer to.

Two separate reports, one cause. A person who never has a queue to herself read `0` on her chip
and produced an empty page, while her queues were plainly on the screen a moment earlier under
Anyone — every queue she is on also requires the other adult, so the strict rule dropped all of
them. And a queue that requires two specific children could only be found by ticking exactly
those two: ticking either one alone hid it, because the filter could not tell "not for these
people" from "for these people and one more".

Both are the same missing distinction. The filter had one way to say no, and it was using it
for two different answers.

## Why

- **A near miss is information, and throwing it away is what made the control unusable.** The
  strict rule is right about what an exact match is and wrong that everything else is nothing.
- **It removes the requirement to know the roster before you can search it.** Ticking one name
  now finds the queues that name is on, which is what somebody ticking one name meant.
- **A chip that says 0 and then shows four cards is worse than no chip.** Counting both tiers
  is what makes the number and the page agree.
- **Everybody ticked must still be ON the queue.** Ticking two people who share nothing keeps
  answering with nothing. That is a true answer and a useful one, and relaxing it to "any of
  them" would make the second name do nothing.
- **The exact rule stays the pick rule.** Playing something is a decision about who is actually
  in the room; browsing is not. The two tiers are a reading affordance, not a change to what a
  queue is for.

## Evidence

Owner, 2026-09-05:

> "I don't like that nothing shows up for my wife only. Maybe we should section this off.
> Before, I didn't like how selecting my name selected every queue with me in it (just about
> all of them). I wanted to filter only to the queues I'm in solo.
>
> Instead, I'd like to show other queues I'm in underneath.
>
> So the first set of results are 100% matched, the rest are 'I'm in there, but not an exact
> match based on the filter criteria'. That would allow selecting my wife only and having her
> queues show up even though I didn't select myself as well.
>
> That way, selecting 'Xander' or 'Darius' without selecting both will show the Halloween
> queue. It removes the need to 'know' everyone who's required to be in a queue.
>
> We could have some sort of divider line to show which are exact matches and which are
> everything else."

And, on the count:

> "it's weird that some folks don't show as having a queue such as my wife, Sheldon, etc when
> 'Anyone' is selected. That's _very_ strange since they _do_ have queues shown especially when
> 'Anyone' is active."

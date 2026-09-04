# A filtered queue is a VIEW of another queue, not a copy

**Status:** Accepted
**Date:** 2026-09-04
**Type:** Product / data model / UI
**Supersedes:** —
**Superseded by:** —

## Decision

A **Filtered queue** is a queue that shows part of another queue. It is a third thing beside
the two kinds — a Picks queue and a Rules queue are both *sources*, and this is a *window* on
one of them.

Its whole record in `sets.yaml` is four keys:

```yaml
- id: strips
  label: Strips
  filtered_from: reading
  filter:
    libraries: [ "5" ]
```

Four rules follow, and each one is a rule about SHARING:

1. **It has no entries of its own.** `queues.entryOwner()` resolves its id to the parent, so
   every read and every per-entry write lands on the parent's line. Adding a series from the
   filtered queue adds it to the parent. Finishing one finishes it in both.
2. **It inherits everything else.** Provider, lanes, per-visit batch, skip list, audience,
   playback length — the parent's record is merged underneath the four keys above before
   either normalizer sees it. A filtered queue can therefore never behave differently from the
   queue it views, because there is nothing to configure differently.
3. **It has its OWN runtime artifact.** A reading list is what the reader walks, and holding
   fewer things is the entire point, so a filtered queue creates and rebuilds its own Kavita
   list titled from its own name. Neither rebuild touches the other.
4. **It cannot set the ORDER.** Every other edit is refused nowhere; this one is refused
   everywhere — in `routes/queuesRoutes.ts` with a 409 that names the queue to open instead,
   and in the UI by not offering the drag at all.

`filter` today understands `libraries`, in the provider's own library ids. It is a mapping
rather than a list so the next filter is a new key and not a second field on every set.

In the UI a filtered queue is drawn **nested under the queue it views**, wherever the two can
appear together: indented behind a rule, badged **Filtered**, with a link naming its parent.
Its own page opens with a line saying what it shows and where the order is set.

## Context

The owner reads the same queue on two devices. A tablet renders both of its libraries
correctly; a phone does not:

> "Take Manga & Webtoons. I have that queue, and it works great on my tablet. On my phone?
> Manga don't show up right, so I'd like to take the existing queue and filter it down to only
> Manga before loading it. The tracking and everything is exactly the same; shared with the
> parent queue. So these are like child queues or sub-queues. They are filtered
> representations of existing queues."

And, on the artifact:

> "It should show up in Kavita differently too. The reading list"

The reading-list half of this is a known Kavita defect, already recorded in
`providers/kavita.ts materialize()`: Kareadita/Kavita#4859 — the manga reader does not remount
on auto-advance, so a manga chapter opened after a webtoon keeps the webtoon's scroll mode and
width. The 2026-08-17 record `the-reading-list-crosses-libraries-again` deliberately chose to
write the whole mixed lineup and let the reader back out and reopen, because cutting the list
at the first library change left it a third of its proper size. A filtered queue is the answer
that record did not have: a **second list** that is format-homogeneous by construction, beside
a parent list that stays whole.

The second case he named is not built and is not implied:

> "Another example might be family movies that I could watch without Ashlee or only with
> Xander."

## Why

**A view, because a copy cannot share progress.** Two entry lists drift the first time either
one is added to, and two sets of done flags are two different answers to "where am I". The
owner asked for the opposite of that in the same sentence he asked for the feature. So nothing
is duplicated and the filter is applied at read time.

**Not a per-launch flag.** `GET /go/<set>?libraries=5` would have been perhaps eighty lines and
no data model at all. It also cannot be seen, named, put on a phone's home screen beside its
parent, given its own reading list with its own cover, or filtered by person on the Queues
page. The owner asked for the UI as much as the behaviour.

**Not a new `kind`.** `kind` is `picks | rules`, and a filtered queue is whatever its parent
is — a view of a Picks queue orders and lanes exactly as that queue does. Spending the kind
axis on it would make "Filtered" exclusive with the two names that describe how a queue is
built.

**Inheritance runs on the RAW entries**, in `filteredQueues.ts`, before either normalizer.
`sets.ts` and `engine/routing.ts` parse this file twice for two different readers, and a view
that resolved in one and not the other would appear on the page and then refuse to launch.

**Order is the one refusal.** A filtered queue shows a subset, so the key list a reorder sends
names only what it can see, and `applyOrder` sorts everything it was not given to the tail —
dragging two webtoons would sweep every manga in the parent to the bottom of the parent's own
queue. Membership is unambiguous in a subset; order is not.

**An item whose library cannot be read is KEPT.** A filter narrows a list the owner curated by
hand. Silently dropping one of his entries because a metadata read hiccuped is worse than
showing him one that does not belong: the second is visible and explains itself.

## Scope — what is NOT built

* **A filtered PUSH queue (Plex).** The read paths are provider-neutral, but a Plex queue also
  records progress on the session / `finished.ts` path, which is keyed on the set id it was
  launched under and does not go through `queues.entryOwner()`. A filtered Plex queue would
  record its watches against itself, which breaks rule 1. Kavita has no such path — the read
  state lives in Kavita and is the same state either way — so the reading case is complete and
  the watching case (the family-movies example) is the follow-up.
* **Creating one from the editor.** `sets.yaml` is hand-editable by design and that is how the
  first one is made. A create/edit surface is its own change, and it needs the filter
  vocabulary to be settled first.
* **Filters other than `libraries`.** People, content rating and format are the obvious next
  ones. The `filter` mapping exists so they cost a key.

## Evidence

* Owner, 2026-09-04, the quotes above.
* `providers/kavita.ts materialize()` and
  `2026-08-17-the-reading-list-crosses-libraries-again.md` — the reader defect this makes
  avoidable, and why the earlier fix was withdrawn.
* `2026-08-23-kind-is-picks-or-rules.md` — the two kind names this does not spend.
* `e2e/filtered-queue-test.ts` pins all four rules end to end, including that both parsers
  inherit identically.

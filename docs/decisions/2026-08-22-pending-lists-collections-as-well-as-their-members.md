# Pending lists collections AS WELL AS their members

- **Status:** Accepted
- **Date:** 2026-08-22
- **Type:** Product / server
- **Supersedes:** —
- **Superseded by:** —

## Decision

A Plex **collection** is a pending row of its own, beside the films inside it — never instead
of them. Adding it writes a `{collection: "<name>"}` entry, which is the entry the engine
expands to the ordered members.

The rule, and it reads off the answers this pass already has rather than asking Plex a second
question:

- at least one child is **itself pending** — new, unwatched, and covered by nothing;
- the collection is not dismissed (by its own ratingKey, like everything else here);
- no queue or pool already **names** it.

`addedAt` is the **newest pending child's**, not the collection's own: Plex's `addedAt` on a
collection is the day someone made it, which is usually years ago and always the wrong answer
for a list ordered by what turned up. The collection **wins the tie** it therefore always has
with that child, so it sits directly above the film that put it there.

Cost: one collections listing per library that has something pending (collections are few),
then one children read per collection, capped at `RESOLVE_CONCURRENCY`. The lister is a
parameter of `pendingItems()`, so it is injectable in the hermetic test and absent means "no
collections at all" — every existing three-argument caller is unchanged.

## Context

> *"Also, there are no collections here. I'd really like those to show up too. Often, I wanna
> add the collection, not a single or set of movies to retain order."*

Asked whether a collection should replace its members on the page, hide behind a separate
shelf, or sit among them, he answered **6A**: listed as well, members still listed.

## Why

**Both, and not either.** The two are different answers to the same arrival: "add the
franchise in order" and "add this one film" are both things he does, and a screen that
decides which one he meant is wrong half the time. Folding the members into the collection
also hides the *reason* the collection is there.

**Something new inside it is what makes it news.** A collection is not an arrival — it is a
grouping that has existed for years. What is new is a film in it, so that is what the rule
tests. A collection whose every member is already in a queue is exactly the case that must not
be offered, and the same test excludes it.

**The order is the feature.** The owner's words are "to retain order" — a collection entry is
the only way to say "these, in the order Plex keeps them", which is why the add writes a
collection entry rather than the collection's rating key. Posting the ratingKey would write
one entry that plays one item.

## Evidence

- Owner's request, quoted above (2026-08-22), and his choice from the rendered options: *"6A"*.
- `e2e/pending-test.ts`, hermetic: 11 new checks covering offered / already-named / all-covered
  / size / member-stays / sort-tie / no-lister / dismissed.
- Screenshot: `docs/images/2026-08-22-pending-collections.png` — collection rows beside their
  members, from the stub-Plex fixture.

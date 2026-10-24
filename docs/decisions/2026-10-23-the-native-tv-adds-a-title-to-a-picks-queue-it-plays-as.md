# The native TV adds a title only to a Picks queue it plays as, through the web's own add

- **Status:** Accepted
- **Date:** 2026-10-23
- **Type:** API / native TV / authorization
- **Supersedes:** —
- **Superseded by:** In part — item 2, by [The native TV plays each queue as its own profile, and locks chosen queues with a PIN](2026-10-23-the-native-tv-plays-each-queue-as-its-own-profile-and-locks-queues-with-a-pin.md)

## Decision

1. **`POST /api/native/queues/:setId/items`**, body `{ratingKey, plexServer?}`, adds one movie
   or show to a Picks queue from the TV's title screen. It answers the web route's shape plus
   the title: `{added, key, duplicateOf?, title}`.
2. **Authorization is `authorizeQueue()`, unchanged.** A profile adds to exactly the queues it
   plays as — the same question a session, the full queue and a watched mark already ask.
   There is no separate "may edit" concept in QueuePilot, and this route does not invent one.
   The TV lists only those queues; anything else is the usual 403.
3. **The item is read through the profile's OWN grant first** (`/library/metadata/<id>` on the
   home server, or the shared server `plexServer` names). A title this profile cannot see is a
   404 and is never written; an episode, season or anything that is not a movie or a show is a
   400. A `plexServer` equal to the home server's id is a home item, so the TV can always send
   the id of the server it browses.
4. **The write is the web's.** The body of `POST /api/queues/:set/items` moves to
   `addQueueItem()` (`server/src/queueItemAdd.ts`): the remote-server check, the duplicate guard
   (`findDuplicateItem`), then `queues.addItem`. The web route keeps its own request parsing
   (collections, empty value) and its wire shape. The TV adds at the **top**, where the web's
   search adds.
5. **A Rules queue refuses with 409.** It chooses its own titles, so a manual add has nowhere to
   go; the TV says so instead of offering it.

## Context

The owner asked for Plex-grade library browsing on the TV, including adding a title to a
queue. No native route could add anything, and the web route has no authorization of its own
(the household network is its boundary), so the TV could not simply call it with a profile
token.

## Why

Reusing `authorizeQueue()` keeps one authorization rule across the native API. Restricting adds
to the queues a profile plays as matches what the TV already shows as "Plays as <profile>", and
a child profile cannot add to an adult's queue by holding the TV remote. Sharing the add body
means the duplicate guard and the shared-server check cannot drift between the two callers.

## Evidence

The owner, 2026-10-22, in the private project-notes chat about QueuePilot TV: "When browsing
the library, it's missing a lot of the features of Plex like Infinite scroll, different sorting
mechanisms, and the ability to add items to a queue." Covered by `server/src/nativeTv.test.ts`
("native TV add to queue") and `server/src/queueItemAdd.test.ts` with fixture data.

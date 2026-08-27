# A queue's name is OPTIONAL, and the activity fills in — a typed name is never overwritten

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** Product / UI / data model
- **Supersedes:** [A queue is people plus an activity](2026-08-25-a-queue-is-people-plus-an-activity.md)
  §4's implementation, in one respect: "every movies queue is called Movies" was built as
  *the display ALWAYS prints the activity*, which overwrote a name the same decision's own
  evidence says the owner keeps the right to type. The decision's intent stands; what changes
  is that the activity is a **fallback**, not an override.
- **Superseded by:** —

## Decision

**1. A queue with a name is called that. A queue with no name is called after its ACTIVITY.**

```
Manga & Webtoons     a name, kept verbatim
Movies               a name, kept verbatim
Movies & Shows       no name — the activity
Movies & Shows 2     …and the second one of those
```

**2. The number is only ever appended to the activity.** Two queues called "Movies" are the
owner's own doing; two called "Movies & Shows" are the app's, and numbering them is the app's
job.

**3. `queueTitle(set, number)` is the ONE function that answers this**, and it reads
`has_explicit_label`, never `label`.

**4. The Name field is optional in both editors** — `#set-label` and `#dyn-label`. It was
`required`.

**5. The server:**
   - `has_explicit_label` on every registry set — whether `label:` is actually on disk.
   - A nameless create is accepted. The immutable id is slugged from the **activity**
     (`movies_shows`, then `movies_shows_2`), and no `label:` line is written.
   - `PATCH /api/sets/:id` with `label: ""` **deletes** the line. It used to be a 400.

## Context

The owner, 2026-08-26:

> "And then the titles are auto-generates them *unless* they're specified like Manga &
> Webtoons. So I'd rename 'Kevin - Movies' to just 'Movies'. I'd know whose it is by the fact
> that 'Kevin' is the only one assigned to that particular 'Movies' queue."

Asked where the word "Movies" comes from — a short stored name, or generated from the
activity — he chose: **keep a short stored name, and let auto-generation fill in only for a
queue that has no name at all.**

## Why

- **The previous build renamed a queue the owner had deliberately named.** `QueuesView`
  printed `queueTitle(activity, number)` unconditionally, so the Picks page called
  "Manga & Webtoons" **Reading**. On the landing fixture all seven shelves read
  "Movies & Shows", "Movies & Shows 2", "Movies & Shows 3", "Movies & Shows 4",
  "Movies & Shows", "Movies & Shows" and "Movies & Shows 2" — and note that the numbering
  does not even make them distinguishable, because it is keyed on people and activity and
  several of those queues share both.
- **§4's evidence never asked for the override.** The quote it is built on is *"Allow, and add
  a number. **If I want to customize queue names, I can.** And in this case, I've already
  customized my one Kavita queue, so I'm good!"* The decision took "the name is the activity"
  as a display rule that beats the stored string; the owner meant it as what a queue is called
  **when he has not said otherwise**.
- **`label` cannot answer "did somebody type this".** The registry makes it printable by
  falling back to the id, which is right — every caller needs something to show — and is
  exactly why a second flag is needed. Without it the fallback prints `movies_shows` on a
  card. `has_explicit_profiles` is the same shape for the same reason, one field over.
- **The id had to stop depending on the name, or the name could not be optional.** A set id
  is a WIRE ID — an NFC card carries it, and so does every Home Assistant MQTT payload — and
  it was slugged from the label at create. The activity is the honest seed: it is also what
  the queue will be CALLED, so `movies_shows` reads the same in a URL bar as on the card. It
  is deliberately NOT derived from the provider there, even though `activityForSet` could:
  the body is a half-built set whose provider blocks are not normalized yet, and a wrong id is
  permanent in a way a wrong display is not.
- **Clearing has to delete the line, not store a blank.** A `label: ""` on disk would read
  back as a name of zero characters through every consumer that has ever done `label ||
  something`.

## Consequences

- **The Name input seeds from the TYPED name only.** Seeding it from `label` would pre-fill a
  nameless queue's field with its id, and the next Save would store that slug as a name.
- **The modal titles and the delete confirmation quote `queueTitle`**, so they say
  "Movies & Shows" rather than `movies_shows`.
- **What to Watch/Play's queue list uses the same function.** It was `set.label || set.id`,
  which printed a slug. One function, so the two screens cannot call one queue two things.
- **The live queues still have to be renamed**, and that is DATA, not code. "Kevin — Movies"
  becomes "Movies"; the person is on the card as a face. Nothing here does that rename.

## Evidence

- Owner quote above, 2026-08-26, and his answer to the scoping question.
- `e2e/queue-name-test.ts` — 18 assertions over a running server: a named create still writes
  `label:` and still slugs from the name; a nameless create writes no `label:` line and slugs
  from the activity, numbered on collision; clearing deletes the line; the wire id survives
  being named, cleared and named again; a rotation pool behaves identically. In CI.
- `web/src/lib/people.test.ts` — `queueTitle` keeps a typed name, ignores `label` when no name
  was typed, and never numbers a typed name.
- `e2e/shot-queue-name.ts` — the before/after: seven shelves, and the editor's Name field.

## Related

- [A queue is people plus an activity](2026-08-25-a-queue-is-people-plus-an-activity.md) — the
  rule this refines, and the faces that make a short name enough
- [The queue editor is two trays, not a sentence or a roster](2026-08-25-the-queue-editor-is-two-trays-not-a-sentence-or-a-roster.md) —
  the mockup's "Name it for me / I will name it" switch is still NOT built, and this is not it:
  there is one field, and empty means the activity
- [The landing filters by people](2026-08-26-the-landing-filters-by-people-and-the-group-chips-go.md) —
  why "I'd know whose it is" holds without the name saying so

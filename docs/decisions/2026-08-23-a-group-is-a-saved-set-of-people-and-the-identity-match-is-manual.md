# A group is a saved set of people, and the identity match is manual

- **Status:** Accepted
- **Date:** 2026-08-23
- **Type:** Data model / migration
- **Supersedes:** —
- **Superseded by:** —

## Decision

1. **`people` is a table in the book of record, and a GROUP becomes a SAVED SET OF PEOPLE.**
   Not a second identity system beside groups. A person has an immutable id (it is a URL), a
   display name, a provider account map — the same shape `groups.yaml`'s `accounts:` already
   holds — and the three picker fields Board Game Picker kept about a player: `birth_year`,
   `max_weight`, `is_beginner`. A group keeps its wire id, its `/g/<id>` URL, its label and
   its `sets:` claim list; what it gains is `group_people`.

2. **The accounts move onto the person, and the group's own `accounts:` is NOT retired.** The
   two are UNIONED. A group may stand for a provider account that no household member holds —
   a demo profile is exactly that — and a person may hold an account no group listed. Either
   half alone drops sets out of a group silently.

3. **`group_people` has NO foreign key on `group_id`, deliberately.**
   `store/db/groups.ts writeDoc()` and the YAML importer both replace the whole `groups` table
   with `DELETE` + `INSERT` on every write. An `ON DELETE CASCADE` would therefore empty every
   roster the next time anybody renamed a group. The orphan is REPORTED
   (`store/db/people.ts orphanGroupIds()`), never enforced by a constraint that deletes
   household data as a side effect. The FK to `people` stays, because nothing ever replaces
   that table wholesale.

4. **IDENTITY MATCH IS MANUAL. A tool proposes; a human confirms; the import refuses to run
   without the confirmation.** `store/migrate/people.ts` reads a mapping file in the config
   directory and writes nothing at all unless it carries an explicit `confirmed: true`, which
   the generator writes COMMENTED OUT. A confirmed file that fails validation writes nothing
   either — there is no partial import.

5. **The mapping file attaches people to groups that ALREADY EXIST. It never creates one.**
   A group id is a bookmarked URL and inventing one is the owner's decision, not a
   migration's, so an unknown group id is treated as a typo and refuses the file.

6. **People, plays and known-how are schema and code in this public repo, data in
   App-Configs.** Unchanged from `groups.yaml`'s posture. New people fixtures are Ada, Grace
   and Linus; the existing Bob / Alice / Carol / Dave / Erin cast stays and nothing is renamed.

## Context

The absorb (agentic `2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick` §6) says
queues are defined by people, and says to *"extend [groups]; do not invent a parallel identity
system."* Board Game Picker already had `players`, `groups` and `group_players`; QueuePilot
already had groups mapped onto provider accounts. WP-3 is where the two become one model.

The identity problem is concrete and is not solvable by an algorithm. Board Game Picker knows a
player by display name. QueuePilot knows the same human by a Plex account handle and a Kavita
display name that are spelled differently from each other and from the group's label. The pair
that matters most shares no letters.

## Why

- **A wrong match is invisible.** The 2026-08-23 migration baseline measured the source: the
  play log is **2 rows**, so a bad merge costs almost nothing there. `player_known_games` is
  **4 rows** and is the record that matters, because "can this person start this game without
  the rulebook" is a fact a person STATES — a play may renew it and must never invent it
  (board-games `2026-08-17-knowing-the-rules-is-a-per-person-fact-not-a-play-count`). Nothing
  on any screen shows a known-how claim attached to the wrong human.
- **Not migrating is recoverable; migrating wrong is not.** An unimported player is a job still
  to do. A player merged into the wrong person is a corruption that looks like working software.
- **A "match" with an owner in the loop costs one file and one edit.** It is the cheapest
  control available and the only one that is actually correct.
- **Real columns rather than a `data` JSON blob**, unlike `sets` and `groups`. Those two are
  projections of a hand-edited YAML file, where a key nobody promoted must survive a round
  trip. People have no file behind them, so a column is the honest shape — and `store/schema.sql`
  said in its own header that WP-3 was the package that would promote them.

## Evidence

- Absorb plan §2 WP-3 and its risk table: *"Identity merge guesses wrong → corrupt play log +
  wrong profile gate → manual mapping file, owner-confirmed once."*
- Migration baseline, 2026-08-23: 8 players, 1 group, 2 `group_players`, 4 `player_known_games`,
  2 plays, 0 `play_players`.
- The proposal generated tonight matched exactly **one** of the five live groups to a player,
  on two independent pieces of evidence. The other four could not be read off a label or an
  account at all, and are in the file's `unmatched:` section as questions rather than guesses.
  A heuristic willing to guess would have had to invent all four.

## Related

- `docs/decisions/2026-08-23-sqlite-is-the-book-of-record-and-cache-sqlite-stays-derived.md`
- `docs/decisions/2026-08-17-a-group-is-who-is-watching-not-a-plex-profile.md`
- `docs/decisions/2026-08-17-the-repo-is-public-so-people-hosts-and-ips-are-placeholders.md`
- `server/src/store/migrate/people-mapping.example.yaml` — the mapping file's format, with
  invented names.
- `e2e/people-test.ts` — the gate: an unconfirmed mapping imports nobody, and the import
  disturbs no wire id.

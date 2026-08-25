# A play cannot be logged without answering who played, and tonight's pick is written down

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** Bugfix / data model / UI
- **Supersedes:** —
- **Superseded by:** —

## Decision

**1. A logged play records its table, or it is refused.**

`logBoardGamePlay({gameId, personIds})` takes `personIds` as a REQUIRED argument, `POST
/api/board-games/plays` rejects a body that omits it, and the button that sends it says how many
people it is about to record — `Log it · 2 people`, or `Log it · nobody named`. An empty list is
still a legal answer and is stored as one. What is no longer possible is logging a play that
quietly means nobody while looking like it means everybody.

**2. A play RENEWS a known-how claim and never INVENTS one.**

`board_game_known_how` is refreshed by an `UPDATE` guarded on `confirmed_at <`, and there is no
`INSERT` on that path. The only door that creates a claim is `POST /api/board-games/:id/known`,
one person per call. Nothing derives "knows the rules" from a play count and nothing may.

**3. Known-how is marked BY DEFAULT on finish, with Change and Undo — not a yes/skip prompt.**

Finishing proposes that everyone at the table knows it, writes only the claims nobody had already
stated, and offers **Change** and **Undo** with the panel still on screen. **Undo takes back
exactly the claims that finish created** — never one somebody stated months ago, and never the
play, which is a separate fact.

The label is per activity: **"Knows the rules"** for a board game, **"Knows how to play"** for a
video game.

**4. Two routes. `/collection` is the shelf; `/result` is tonight's pick.**

`/collection` lists every title as a card in a grid and carries "we played this" on each one, so a
game can be logged when nobody opened the picker first. `/result` shows **one** card with a reroll
and a shortlist of three behind a control. **`/result/<gameId>` is a queue arrival and has no
reroll and no shortlist** — the queue already chose.

**5. The pick is written to `localStorage`, and it expires after twelve hours.**

`lib/pickSession.ts` holds the criteria, the table, the drawn candidates and reroll's memory. Not
the URL: a pick is a result, not an address, and a shared link claiming to be somebody else's pick
from last Tuesday is worse than no link. Twelve hours is one evening with room to run late.

## Context

The owner marked a board game played on 2026-08-25. It logged the game and the timestamp and
nobody else. Read from the live database that night: **3 plays, 0 participant rows** — and the
participant table had never been written to, for any play, ever.

The write was not missing. The absorbed app's `logPlay` inserted participants correctly; every
screen called it with an empty list. One screen hardcoded `[]` with a comment explaining why, and
the picker's own result card passed `[]` whenever the form was in by-count mode rather than
by-people mode — which is the mode somebody uses when they are standing at a table and just want a
game.

He also lost the pick by leaving the page:

> "It brought up a game, I left the page and came back, and the game went away, so I kept hitting
> 'reroll', and it never showed up again until I refreshed and narrowed it down more."

And asked for the screen this record's item 4 is about:

> "I'd like to be able to go to the Collection screen (if I forget), and mark a game played for the
> night. I'm not even sure what that does right now, but we're tracking it to help with remembering
> rules etc."

## Why

- **The defect was a UI that never asked, so the fix is an API that cannot be called without an
  answer.** A field with a default is a field a caller keeps forgetting, and that is exactly what
  happened four times in one codebase. Making it required moves the failure from a silent empty
  table to a compile error.
- **Marking by default is a PROPOSAL, and that is what makes it compatible with the rule.** Sitting
  through a game is decent evidence you can start it again — but it is evidence a person confirms,
  not a number a query derives. The tick is written in front of the person with the undo still on
  screen, which is a human stating a claim on their own behalf. A `SELECT COUNT(*) FROM plays`
  would not be, no matter how well it correlated.
- **Undo owns only what this finish created.** The alternative — undo clears every claim on the
  card — is a control that silently destroys a year-old fact somebody typed by hand, and the person
  pressing it would have no way to know.
- **The Collection screen routes around the lost pick entirely**, which is why it came before the
  durability fix rather than after it. Most evenings nobody opens the picker at all.
- **`localStorage` and not the URL, and it expires.** Reopening the app three days later and being
  shown Tuesday's card as though it were tonight's is worse than an empty screen, because nothing
  on the card says how old it is.
- **The shortlist is drawn WITH the first card, not when the control is tapped.** A second request
  would re-draw, so the card already on screen could change under the finger that asked to see more
  of them.

## Evidence

- The defect report, confirmed read-only against the live database: 3 plays, 0 `play_players` rows,
  4 `player_known_games` rows written by a different control eight hours after the play they
  follow. That control was the **Collection card's "Knows the rules" checkbox panel** —
  `POST /api/games/:id/known` — which is the path that already worked and is the shape item 3
  reuses.
- `server/src/store/db/boardgamePlays.test.ts` — 14 cases. A participant row per person; an empty
  table stored as empty; a rollback when a participant cannot be written; a claim renewed; **no
  claim created for somebody who had never stated one**; a backdated play that cannot freshen one.
- `e2e/board-game-play-test.ts` — drives the control in a browser and then reads the table with
  plain SQL. Its sharpest line is `🐞 A LOGGED PLAY RECORDS WHO PLAYED`, which fails against the
  behaviour this record replaces.
- ⚠️ The three historical plays are **not** back-filled and never will be. They have no attendance.
  `store/migrate/boardgames.test.ts` pins the empty table as the correct migration result, and
  the new gate re-pins it before it writes anything.

## Related

- Workspace: `agentic:docs/research/2026-08-25-a-logged-play-records-no-players.md` (the report),
  `agentic:board-games-private/docs/decisions/2026-08-17-knowing-the-rules-is-a-per-person-fact-not-a-play-count.md`
  (the rule items 2 and 3 obey), and
  `agentic:docs/decisions/2026-08-25-video-games-absorbs-retro-and-surprise-me-narrows-first.md` §3
  (one card, shortlist behind a control, no reroll on a queue arrival). Named rather than linked —
  a link from here would 404 for anyone reading this on the public repo.
- [The board-game provider reads ROWS and still POSTS a play over HTTP](2026-08-25-the-board-game-provider-reads-rows-and-still-posts-a-play-over-http.md)
  — WP-4e pinned the 0 rows as the state it found. This is the package that changes it.

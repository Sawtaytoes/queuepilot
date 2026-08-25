# The collection absorb is a ONE-WAY DOOR, and the source file is retired

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** architecture / absorb / data safety
- **Supersedes:** —
- **Superseded by:** —
- **Implements:** WP-4d of the absorb — "the CLIs and enrichment", which is the package that
  closes the two-books-of-record problem.
- **Amends:** [the board-game provider reads rows and still posts a play over
  HTTP](2026-08-25-the-board-game-provider-reads-rows-and-still-posts-a-play-over-http.md) —
  its part 3 named this change as the condition, and this is that change.

## Decision

**Once the store holds a collection, the absorb never runs again. `importBoardGames()` refuses,
including under `force`. The source file is renamed aside. The grouping SEED keeps working.**

Five parts.

1. **A latch, in the book of record.** `store_meta('boardgames', 'retired_at')`. Set at the end
   of the boot hook whenever `board_games` holds rows — whether this start absorbed them or an
   earlier one did.
2. **`force` does not open it.** `force` exists to re-run an absorb a fingerprint check would
   skip. Over a collection this app now writes, that is not a debugging convenience; it is a
   whole-table `DELETE` with an innocent name.
3. **The file is moved, not deleted.** `board-game-picker-import.sqlite` becomes
   `board-game-picker-import.sqlite.retired-<timestamp>`. The latch is what makes the
   retirement TRUE; the rename is what makes it VISIBLE. A rename that fails is logged and
   never thrown — a read-only `/config` is not a reason to leave the door open.
4. **The seed is NOT retired.** `board-game-grouping-seed.yaml` keeps being read, by
   `seedGroupingRules()`, gated on its own fingerprint.
5. **Getting back is two manual steps.** Rename the file back AND delete the meta row, with the
   app stopped. There is no flag and there must not be one.

## Context

WP-4b absorbed twelve `board_game_*` tables out of the sibling app's SQLite file, and the
absorb **REPLACES all twelve** whenever the source file's fingerprint changes. That was correct
while the sibling app was the one being edited and nothing here wrote those tables.

WP-4d lands the writers: the BGG sync, the art enrichment, the rulebook linker, the video
linker. `AGENTS.md` has said since WP-4b that the source file is retired **in the same change**
as the first writer, and this is that change.

**One correction to the record.** WP-4d is not quite the first writer. WP-8 (PR #210) landed
`POST /api/board-games/plays` and `POST /api/board-games/:id/known`, which write
`board_game_plays`, `board_game_play_people` and `board_game_known_how`. So a window was already
open: between WP-8 deploying and this landing, a play logged from the Collection screen would
have been erased by the next start whose source fingerprint had moved. Nothing did move it — the
staged file has not been re-staged since 2026-08-25 01:11 — so nothing was lost. The rule was
right and it was applied one package late.

## Why

**Why a latch and not just deleting the file.** A deleted file is a fingerprint of `'absent'`,
which is a *different* fingerprint — so a bare delete makes the absorb want to run again, over
an empty source, and the assertions are the only thing standing between that and twelve emptied
tables. The latch is a statement about who owns the data, which is the actual question. It also
survives someone restoring the file from a snapshot, or pointing `BOARD_GAME_IMPORT_PATH`
somewhere else, neither of which a rename survives.

**Why `force` is fenced off too.** `force` was safe when the tables were a read-only copy of
another app's data: the worst case was re-copying the same rows. It is not safe now, and the
person most likely to reach for it is somebody debugging a collection that looks wrong — which
is exactly the state in which losing the writes is worst.

**Why the seed stays.** The two inputs are not the same kind of thing, and treating them as one
would have been the easy mistake. The source file is a second BOOK OF RECORD: it carries rows
that REPLACE ours. The seed can only ever ADD — every insert is `ON CONFLICT DO NOTHING`, and it
touches only `board_game_groupings` and `board_game_grouping_reviews`. Retiring it as well would
have left **no way at all** to add a grouping rule, because
[the grouping rules are rows](2026-08-23-the-collections-grouping-rules-are-rows-not-source.md)
promises a screen that does not exist yet. That would have been a regression introduced by a
safety change, which is the worst kind.

**Why retirement fires on ROWS EXISTING rather than on an absorb happening.** The live system
absorbed days ago; its next start finds a matching fingerprint and absorbs nothing. Keying on
"this start absorbed" would have left the live system's door open forever. Keying on rows also
protects the opposite case: a fresh container whose absorb found nothing does not latch itself
out of ever receiving a collection.

**Why a rolled-back absorb does not retire.** A failed assertion leaves the tables as they were.
Latching then would freeze a collection nobody meant to keep, and the next start — the one that
fixes the input — could not fix anything.

**What this let `logPlay()` do.** It came home in the same change. WP-4e left it as the one call
on the wire for exactly this reason, so `boardGamesRepositoryClient` now builds no HTTP client
at all. It records `personIds: []`, stated rather than defaulted: whoever presses "we played
this" on a tile is not filling in a form, and a play may RENEW a known-how claim but must never
INVENT one.

## Evidence

Seven unit tests in `store/migrate/boardgames.test.ts`, and **two guards proved by mutation
rather than by watching them pass**:

- Removing the guard in `importBoardGames()` fails `refuses a re-absorb once retired —
  INCLUDING under force`.
- Removing **both** that guard and the boot hook's branch fails `🐞 A SYNC'S ROWS SURVIVE A
  RESTART` — which writes a title and a link the way a sync does, re-stages the source file with
  different content, restarts, and finds them still there.
- Removing only the boot-hook branch fails nothing, because the second guard catches it. That is
  defence in depth and it is why both are checked separately.

`e2e/board-game-absorb-test.ts` proves it on the real boot path, which the unit tests cannot: a
live server absorbed a collection, latched `retired_at`, and moved its own input aside. That
gate also now computes every reference answer from a **second, pristine copy** it writes itself,
rather than reading the app's input back afterwards — strictly stronger, and necessary once the
app owns that file's lifecycle.

`e2e/board-game-transport-parity-test.ts` §5 was **inverted, not weakened**. It used to pin
"neither transport wrote a play row here", which was the correct assertion while the absorb could
erase one. It now pins `plays 22 -> 23, posts 0` for the in-process transport and no local row
for the HTTP one, plus two new assertions: a tile play names nobody, and it creates no known-how
claim out of a counter. A gate that still passed unchanged after a write came home would be a
gate that was never watching the write.

**What is NOT proved here.** Nothing outside this repo moved. `board-game-picker.octen.dev`, its
Homepage tile, its TrueNAS app and its repo are all still running and still serving; retiring
the source FILE is not retiring the APP, and that transfer is WP-10 behind an explicit owner
gate.

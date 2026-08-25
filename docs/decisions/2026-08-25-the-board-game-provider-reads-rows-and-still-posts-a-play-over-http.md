# The board-game provider reads ROWS and still POSTS a play over HTTP

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** architecture / absorb / transport
- **Supersedes:** —
- **Superseded by:** —
- **Implements:** WP-4e of the absorb — "the provider swaps transport;
  `providers/board-game-picker.ts` is unchanged, and that is the proof the seam was right."

## Decision

**`providers/board-game-picker-client.ts` answers every READ out of `store/db/boardgames.ts`,
in process. `logPlay()` — the one WRITE — still POSTs to the sibling app. `BOARD_GAME_TRANSPORT=http`
puts the reads back on the wire.**

Four parts.

1. **The four reads are local.** `games()`, `game()`, `plays()` and `categories()` call the
   read layer WP-4b landed. `cover()` reads the bytes out of the staged
   `board-game-images/` directory.
2. **`providers/board-game-picker.ts` did not change.** Not one line. The provider was written
   against a client interface rather than against a URL, so the transport is one file. The old
   type name `BoardGamesHttpClient` survives as an alias for exactly this reason — renaming it
   at the call site would have meant editing the file whose not changing is the claim.
3. **The play write stays on the wire, and that is not an oversight.** Two books of record are
   open. The absorb REPLACES all twelve `board_game_*` tables whenever the source file's
   fingerprint changes, so a play written here is erased by the next start. WP-4d lands the
   writers and retires the source file **in the same change**; until that day nothing in this
   app may write a collection row.
4. **The HTTP implementation stays runnable behind `BOARD_GAME_TRANSPORT=http`**, the way the
   store keeps `STORE_BACKEND=yaml`.

## Context

WP-4b absorbed the collection into `/config/queuepilot.sqlite` — twelve tables, and on the
live system 147 games, 562 boxes, 193 links, 169 groupings, 3 plays and 4 known-how rows. The
data was in two places from that moment: here, and in the app that is still being edited. The
provider was still reading the sibling app over HTTP, which was safe only because nothing here
wrote those tables.

There is no board-game queue in the live registry today. So this lands with no household queue
depending on it, which is the cheapest moment it will ever have.

## Why

**Why read locally at all.** The sibling app is a LAN host and this app is not always on the
same side of it; every tile probe was a round trip; and the collection is already here. A full
read of the live 147-title shelf is **5.4 ms** measured in process, which is why nothing is
cached — WP-4d brings the first writers of these tables, and a cache with no invalidation hook
turns "the owner just edited a game" into "restart the app".

**Why the write is different from the reads.** A read of stale data is a stale answer. A write
into a table the absorb will REPLACE is a lost answer, with no error and nobody watching. The
rule that the source file is retired in the same change as the first writer already exists in
`AGENTS.md`; this package is not that change, so it does not open a writer. The cost is stated
rather than hidden: a play logged through `POST /api/providers/:id/progress/:itemId` lands in
the sibling app and is invisible to the reads above until the collection is staged and absorbed
again. Nothing in this app's UI calls that route.

**Why keep the HTTP client.** Two reasons, and the second is the better one. It is the rollback,
one env var and one restart. And it is the other half of the parity gate: a gate that can run
BOTH transports over one fixture compares them on every CI run, where a one-off comparison in a
PR description compares them once and then rots.

**Why the wire shape was kept rather than improved.** `game()` returns the object
`GET /api/games/:id` returned, and `plays()` returns the same three keys that endpoint wrote
out by hand. Two consequences. The transports are comparable object for object, which is what
makes the gate possible at all. And the privacy rule did not retire with the transport — it
MOVED: `listBoardGamePlays()` carries `playerIds` and `notes`, and the client drops both here
rather than trusting a caller not to read them.

## Evidence

`e2e/board-game-transport-parity-test.ts`. One invented shelf expressed twice — as hand-written
objects behind a real `node:http` server running the sibling app's transcribed endpoint bodies,
and as rows in that app's own schema, absorbed and read back — with every answer compared value
for value: the four client payloads, `libraries`, `search`, `buckets`, `tiles`, `progressState`,
`materialize`, `handoff`, and the cover BYTES. The HTTP side is transcribed and never imported,
because a stub serving rows out of our own store would be the store agreeing with itself.

Nine lineup scenarios. The one that matters is `queued_at`: a title with twenty old plays and
one recent one, with the bound checked either side of it. Queued after that play, a batch of
three still owes three.

Proved by mutation rather than by watching it pass. Dropping the `since` bound fails 11 cases,
stripping the game DTO fails 8, and pointing the cover read at the wrong directory fails 3.

Three more assertions the gate carries: a read over the in-process transport touches the network
**zero** times, counted at the server; a play carries three keys and never a person; and neither
transport adds a row to `board_game_plays` here.

⚠️ **`board_game_play_people` holds 0 rows against 3 plays on the live system, and this package
left it that way on purpose.** A logged play records nobody — a confirmed defect, evidence in
`agentic:docs/research/2026-08-25-a-logged-play-records-no-players.md`, WP-8 owns the fix. The
gate pins the zero rather than papering over it.

# 2026-08-16 — A curated queue's `requires_profile` is WHO it plays as, not only a gate

Status: Accepted
Date: 2026-08-16
Type: server (engine + provider seam + /api/queues)
Supersedes: —
Superseded by: —

## Decision

`requires_profile` on a curated queue now decides the queue's **account**, not just when it is
allowed to start. Everywhere a queue's progress is read — the grid's next-up tiles and the
scan's own selection — it is read as that Plex Home profile:

- **`/api/queues`** resolves each set's tiles under that profile's server-scoped token
  (`plex.profileScope()`), the same scoping `/api/sets/:id/members?uuid=` already did for a
  rotation channel's member tiles. One lookup per distinct profile, not per tile.
- **The scan** fills the empty binding in through a new optional provider method,
  `Provider.profileBinding(binding, profileTitle)`. The Plex provider joins the name to its
  plex.tv Home-users row and sets `account_id` / `user_uuid` / `watch_count_accounts: [id]`.
- **A binding that already names an account is returned untouched.** A rotation channel's
  `profiles[]` is explicit and `bindingFor()` has already picked the right entry for the
  signed-in profile; second-guessing that re-opens the 2026-08-14 silent-no-play bug from the
  other end.
- **`watch_count_accounts` is `[id]`, never a union** — decision 2026-07-16 stands.
- An **ungated** queue (no `requires_profile`) keeps the admin view it has always had.

The name→account join lives on the Plex side of the provider seam, because "a profile title is
an accountID" is a plex.tv fact, not an engine one.

## Context

Reported from the live app: on `queuepilot.example.com/#/q/carol_1` — "Carol 1",
`requires_profile: Older Kids` — a newly added Dragon Ball collection tile read
**"Z (1989) · E109 · Black Fog of Terror"**. That is where *Bob* is. Older Kids has watched
45 of 155 Dragon Ball episodes and **zero** of 291 DBZ; the right answer was
**"Dragon Ball (1986) · E36 · Major Metallitron"**, 246 episodes earlier and a different show.

Owner: *"Dragon Ball collection was added, but the watch history is for Sawtaytoes, not Older
Kids."*

`requires_profile` shipped 2026-07-25 as a **play gate** — "wait until this profile is signed
in" — and stores a display name and nothing else. A curated queue has no `profiles[]` and no
binding fields, so `routing.bindingFor()` handed back an EMPTY binding, which was wrong in two
directions at once:

- `watch_count_accounts: null` fell through to env `WATCH_COUNT_ACCOUNTS`
  (`1,11111111,22222222` — admin-first, and the two managed ids are placeholders that do not
  exist on this server, so it collapsed to the admin alone);
- `user_uuid: null` read every episode's `viewCount` under the owner's token.

And `/api/queues` passed a hardcoded empty `AccountScope` to `tiles.resolveTile()`.

It stayed invisible for three weeks because **every curated queue was the owner's own**
(`requires_profile: sawtaytoes`, plus two `Demo` reels that have no watched state). The admin
answer was right by accident. `carol_1` is the first queue gated to a kid.

## Why

- The gate exists so *"a card can never play under the wrong account"* (the sets.yaml header).
  Selecting the lineup out of a different account's history is that same wrong-account failure,
  one step earlier — the gate was only ever enforcing half of what it promised.
- Watched state has been per-profile since 2026-07-16, when the cross-account union was tried
  and reverted for exactly this reason ("someone else's viewing drove the kids' cards"). A
  curated queue was quietly still on the union.
- Deriving from `requires_profile` rather than adding a second per-queue "history profile"
  field: a queue that plays under Older Kids has no coherent reason to count anyone else's
  watches, and the UI already calls the field **"Plays under profile"**.

## Evidence

- Live, before: `GET /api/queues` → `carol_1[0].nextEp = {member: "Dragon Ball Z", episode:
  109, partiallyWatched: true}`. Plex `/library/collections/325732/children` per token —
  admin: `Dragon Ball 154/155`, `Dragon Ball Z 176/291`; Older Kids: `Dragon Ball 45/155`,
  `Dragon Ball Z 0/291`.
- Live, after (patched server, real Plex, live config copy): `Dragon Ball` E36; Pokémon
  S1E1→S1E4; Daniel Tiger's S4E6→S4E12; Darkwing Duck E1→E3.
- **Blast radius verified by diffing every set's tiles, prod vs patched: `carol_1` changed and
  nothing else did** — all nine `sawtaytoes` queues, both `Demo` reels and the two ungated
  queues came back byte-identical, because the owner resolves to `{id: 1, uuid: null}` = the
  admin token this always used.
- Gate: `e2e/curated-queue-profile-test.ts` (11 checks, wired into CI's offline engine block) —
  the history query carries only the bound account, the fill is `[id]` not a union, the owner
  still lands on the admin token, an ungated/unknown profile is left alone, and an explicit
  rotation binding survives untouched.
- Screenshots: `__screenshots__/carol1-before.png`, `__screenshots__/carol1-after.png`.

## Follow-up (not in this change)

`plex.collectionChildren()` is still cached and read admin-only, so a collection's **movie**
member's `watched` short-circuit — and the start editor's "N/M watched" — remain the owner's
view. Show members (the common case, and Dragon Ball's) already resolve per-account through
`nextEpisode(opts)`. Fixing it means adding an `account` column to the `collection_children`
cache table, which is a schema migration and its own change.

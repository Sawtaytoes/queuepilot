# Parked: "All" / infinite as a batch size

- **Status:** Parked — owner may never need it; do not build until he asks
- **Date:** 2026-08-16
- **Asked from:** the per-entry "Chapters queued per turn" picker
  (`CountPicker`: 1 / 2 / Custom…)

## The ask

> "I might never need this, but it might be neat to have 'infinite' or
> 'all' here to say read 'all' chapters. Document this as a possible
> future todo, so I don't have to have 999 or something."

An entry (or a queue) should be able to say **this turn is the rest of
the series** — every remaining unread chapter / volume — without typing
a magic number.

The words he used: **"infinite"** or **"all"**. Prefer **All** in the
picker (it is a count of remaining items, not a loop). Same idea on the
set-level "Chapters / Volumes per series each visit" controls, and on
Plex "episodes queued per turn" if it ever lands there too.

## What is true today (so nobody "fixes" this with 999)

- The picker is `1` / `2` / `Custom…`. Custom is a number field clamped
  to `EPISODES_MAX` = **40**, which is also `QUEUE_SERIES_LENGTH`.
- **999 will not work.** The field snaps back, and the server clamps
  `episodes:` / `volumes:` to 40. That cap exists so a typo cannot dump
  a whole library into one scan.
- `<= 1` **drops the key** (sparse default of 1). There is no stored
  "unlimited" value today.
- A later agent will be tempted to store `0` or omit the clamp. The
  2026-08-15 batch decision already warned: a falsy batch is read as
  **uncapped** in the Plex resolver (`applyBatch`). If "All" is ever
  built, it needs an **explicit sentinel** (`all`, not `0`, not `999`)
  that both the writer and the reader agree on — otherwise a typo
  becomes a binge.

## What to build, if it is ever built

1. Picker grows a fourth option: **All**, next to 1 / 2 / Custom….
   Not a Custom value of 999.
2. Store a named sentinel (`episodes: all` / `volumes: all`), never a
   huge integer. 1 still drops the key.
3. Engine: for that entry, the turn is the rest of the unread run — no
   `QUEUE_SERIES_LENGTH` slice. `batch_stops_at` still applies (a
   season/member boundary can shorten "all").
4. Tile tag: `all ch` / `all vol`, not `40 ch`.
5. Default stays **1**. This is opt-in per entry or per queue, same as
   today's "3 chapters for this reading queue".

Do not start this because it is on the list. Start it when the owner
hits a series he wants to finish in one visit and says so.

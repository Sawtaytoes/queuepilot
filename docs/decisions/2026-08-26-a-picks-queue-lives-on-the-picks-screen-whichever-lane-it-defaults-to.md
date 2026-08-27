# A Picks queue lives on the Picks screen, whichever lane it defaults to

- **Status:** Accepted
- **Date:** 2026-08-26
- **Type:** UX / information architecture
- **Supersedes:** the LAST piece of
  [filtered-pools-curated-pools-ordered-queues](2026-08-16-filtered-pools-curated-pools-ordered-queues.md)
  — the three-way split survived in two screen lists after the kinds were merged
- **Superseded by:** —
- **Builds on:**
  - [kind-is-picks-or-rules](2026-08-23-kind-is-picks-or-rules.md) §1 and §6 — which merged
    the kinds and said the Type control goes away, in the DATA
  - [the-queue-page-is-two-lanes](2026-08-26-the-queue-page-is-two-lanes-and-the-drag-is-the-promote.md)
    — which drew the lanes on one queue's own page, and not on the list of queues

## Decision

### 1. Each screen lists its own kind, and nothing else

| Screen | Lists |
| --- | --- |
| **Picks** (`/queues`) | Every `source: queue` set — **both** lane defaults |
| **Rules** (`/channels`) | Every `source: rotation` set, and nothing else |

`add_as` is a **lane default inside one queue**. It decides where a newly added entry lands.
It does **not** decide which page the queue lives on.

The Rules page's picker drops its `q:`-prefixed Picks entries, and its **`＋ Picks queue`**
button goes with them: a page that cannot show you what you just made must not offer to make
it. Picks are created from the Play landing (`#playnewqueue`) and from the Picks toolbar
(`#newqueue`), and the lane default is the set modal's own Type control either way.

The picker's visible label becomes **"Rules queue"**. It said "Pool", which was wrong twice
over — the page's heading says Rules, and `pool` is already the name of a lane. "Eligible
pool" further down that page keeps the word, in the sense it still owns: a pool of candidates.

### 2. A Picks shelf says which lane its posters are in

One shelf, one strip, in two runs — the Priority queue, then a **divider**, then the Random
pool. The shelf heading carries the split in words beside the count:

- both lanes: `12 · 3 priority · 9 pool`
- one lane: `12 · priority queue` / `12 · random pool`
- empty: the count alone

The one-lane clause is not decoration. A divider can only exist where there are two runs to
divide, so without it a queue whose every entry is pooled would be indistinguishable from an
ordered one.

**Each shelf tile gets the promote / demote arrow** the queue page's tiles already have. The
queue page also promotes by dragging across its divider; a shelf cannot, so on this page the
arrow is the only promote and is offered on every shelf.

### 3. One strip per shelf, not two

`/q/<id>` stacks two `ul.grid[data-lane]` elements. A shelf must not: `useHomeDrags` reads a
shelf as a single `.strip` — it hit-tests one per shelf and rebuilds the queue's file order
from `strip.querySelectorAll("li.tile")` — so a second `<ul>` would PATCH an order carrying
half the queue's keys. The divider is an `li.lanesplit`, which no `li.tile` query matches.

Consequence, and it is deliberate: **a shelf drag reorders, it does not promote.** A tile
dropped across the divider returns to its own lane on the next render. The arrow is the
promote here.

### 4. `/api/shelves` carries `placement`

The shelf skeleton exists to paint at final geometry before `/api/queues` resolves against
Plex. Once a shelf draws two runs, that geometry includes the lane split — so an entry's
stored lane belongs in the skeleton, exactly as `add_as` already did, and at the same cost:
one property read, zero Plex calls.

Found by running it. Without it every entry falls into the set's default lane on first paint,
and the divider plus the tiles either side of it move when the resolved payload lands — the
precise layout shift the endpoint was added to prevent.

### 5. A list of queues names its PEOPLE

Any control that lists queues by name shows who each one is for: the two Add-to menus, and the
selection bar's Move-to picker. A chip on the row, from `queuePeopleLabel` — required members
only, three names then `+n`, and `Anybody` for a queue nobody has filed.

Required members only, because the nice-to-have tray is what a dashed face can say and a line
of text cannot. Listing both would put four names in a dropdown badge and tell you less than
two do.

### 6. A rules row names its ACCOUNT

The same rule, one kind over. The Play landing's card has carried the bound account in its
meta line since
[a-filtered-pool-is-locked-to-one-account](2026-08-17-a-filtered-pool-is-locked-to-one-account.md),
and said why: *"Shows" and "Shows & Shorts" are the same words until you know one is Younger
Kids and the other Older Kids.* The rules PICKER never carried it.

Each row now does, as a chip — `channelAccountLabel`, three names then `+n`.

**The gate is the row's own LABEL, not `has_explicit_profiles`.** `PlayView` used the flag,
on the stated belief that a legacy flat set's synthesized binding reports the channel's own
label. The server does not do that; the synthesized binding carries the real `plex_user`,
measured on `/api/sets`:

    younger | Shows & Shorts | explicit: false | profiles: ["Younger Kids"]

The claim reads as true against the live `sets.yaml` only because those two pools are *named
after the accounts they play as*, so the label and the account are the same words. Gating on
the flag dropped the account from every legacy pool; gating on the label drops only the one
real failure, a row saying itself twice. The landing card and the Rules header both move onto
the helper, so all three agree.

**"Plays as `<account>`" comes off the Rules header.** That sentence was
[2026-08-17](2026-08-17-a-filtered-pool-is-locked-to-one-account.md)'s answer to the same
question, and the picker beside it now answers it — the trigger reads
"Shows & Shorts · Younger Kids", so the sentence repeated two words already on screen. **The
rule that record set is untouched:** the account is a FACT about the pool, not a choice, and
it still wears no chevron of its own. The chevron there changes the POOL; each row names the
account it comes with. Only where the fact prints has moved.

**A chip is data, so it shrinks.** `.optionbadge` is `flex: none` on a list row, where the
row is as wide as the panel. On a TRIGGER it is `flex: 0 1 auto` and ellipsises, and the
option's text moved into its own `.optionlabel` element to ellipsise beside it — a bare text
node next to a `Badge` becomes an anonymous flex item, and an anonymous item takes no
`min-width: 0`. Without both, "Younger Kids, Older Kids" held the trigger at 349px and the
Rules header scrolled sideways at 390px. `.chhead label` needed `min-width: 0` for the same
reason one level up. Gate: `narrow-scroll-test`, which caught it.

### 7. Move-to offers every other Picks queue

The selection bar used to ask whether the queue you are standing in is random-order and then
offer its own half of the split. A move between two Picks queues was impossible for no reason
a person could see. The destination's own `add_as` decides which lane the entry lands in.

### 8. Two `ui-test` assertions were stale, and the suite was dying on one

Not this PR's subject, but this PR's gates live below them, so they had to be fixed or the
new assertions would never execute.

- **Line 97 waited for a shelf named `Bob — Shorts`.** A shelf is named after its ACTIVITY
  since [a-queue-is-people-plus-an-activity](2026-08-25-a-queue-is-people-plus-an-activity.md),
  so that text can never appear there again. A `waitForFunction` timeout THROWS rather than
  printing `FAIL`, so the suite read as a short passing run while **thirty assertions below it
  never ran** — the second time this file has lost its tail that way. It waits on the shelf
  COUNT now, and the rename check below it waits on `/api/sets` instead of a display name.
- **`filter "anime" → 0 shelves (channels moved out)`** asserted the defect this record
  removes. It now asserts the filter's real job: the anime queues shown, and only those.

## Context

`kind: picks | rules` landed on 2026-08-23 and the lanes landed in the data on 2026-08-26, but
the two SCREEN lists still split on `add_as`: `queueIds` fed the Picks page, `channelSetIds`
fed the Rules page. That is where a "Curated Pool" was filed when it was its own kind, and
nothing moved it when the kind was retired.

The household's live `sets.yaml` has ten Picks queues with `add_as: random`. All ten were
listed in a dropdown on a page headed **Rules**, between the two rules queues. The owner,
looking at that dropdown:

> This is the "Picks" dropdown, but it includes "Rules" entries in QueuePilot. Can we fix it
> so they're configured properly? That means the "Picks" screen needs to be capable of
> showing priority vs pooled items.

The second sentence is the reason this is more than a filter change. The Picks page had never
had to draw a random-lane queue, so it had no way to say what lane anything was in.

On the same dropdown, minutes later:

> These options should show some badge or something of who's involved in them because it's
> not clear now that we're using auto-names.

A queue's displayed name is its ACTIVITY since
[a-queue-is-people-plus-an-activity](2026-08-25-a-queue-is-people-plus-an-activity.md) — so a
list of them reads "Movies & Shows", "Movies & Shows 2", "Movies & Shows 3". The shelves and
the landing cards already answer that with a row of faces; a menu row and a picker option had
nothing.

## Why

- **A kind is what a screen lists.** Two screens named Picks and Rules that each list some of
  both is worse than no split at all — the name promises a filter the page does not apply.
- **A lane default is not a kind.** `add_as` answers "where does the next thing I add go", and
  the ADR that named the kinds says the Type control goes away for exactly this reason.
- **The Picks page had to grow the lanes anyway.** Ten queues arriving on it with every entry
  pooled, and no way to say so, would have traded one wrong page for one silent one.
- **The people belong wherever the name is.** Not only in the dropdown that prompted it: the
  same auto-name is in two Add-to menus and the Move-to picker, and fixing one of the three is
  how a rule becomes folklore.

## Evidence

- Owner, 2026-08-26, with a screenshot of the Rules page's picker: the quotes above, and on
  the picker once it listed rules queues alone: *"Do we not have a way to show the associated
  account too in this dropdown?"*
- `/api/sets` on the landing fixture, which is what disproves `PlayView`'s stated reason for
  the `has_explicit_profiles` gate: `younger | Shows & Shorts | explicit: false | profiles:
  ["Younger Kids"]`.
- Live `sets.yaml`: four `kind: rules` sets (Younger Kids, Older Kids, Shorts, Movies); every
  other set is `kind: picks`, ten of them `add_as: random`.
- `web/src/state/store.ts` before this change: `queueIds` and `channelSetIds`, one `add_as`
  filter each, feeding `QueuesView` and `ChannelsView` respectively.

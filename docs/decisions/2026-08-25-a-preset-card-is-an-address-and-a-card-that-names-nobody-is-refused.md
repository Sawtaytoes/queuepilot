# A preset card is an ADDRESS, and a card that names nobody is refused

- **Status:** Accepted
- **Date:** 2026-08-25
- **Type:** feature / product boundary / routing
- **Supersedes:** —
- **Superseded by:** —

## Decision

A **Pick preset** on a physical card is a URL — `/tonight/go?…` — and it draws before it
paints. Four rules:

1. **The grammar is the form.** `activity` names one of the six tiles. `people` is a
   comma-separated list of **person ids** (what `GET /api/people` answers, never a display
   name). `guests` is a count of anonymous seats. Every other parameter is a **filter**, and a
   filter is accepted only under the id and the value its own activity declares in
   `ACTIVITY_FILTERS`.
2. **A valid preset lands on `/result`, never on a form.** It runs the same draw the Go button
   runs and replaces itself. While the draw is in flight the screen says what it is doing; it
   does not paint the Who's-here form the card exists to skip.
3. **A card that names NOBODY is REFUSED.** No people and no guests is not "everybody" and not
   "no filter" — it is an unanswered question, and the answer is glass. The refusal lands on
   `/tonight` with everything the card *did* say already applied, and one sentence naming what
   is missing.
4. **Nothing invents a value.** An unknown filter id is dropped. An unknown *value* for a known
   filter falls back to that filter's own default. `light=onn` behaves as the default, never as
   a third state.

Two tiles cannot be baked into a card at all: **Surprise Me** (it narrows on a second screen
first, and the narrowings are not settled) and an activity that is not a tile. Both land on the
form quoting what the card said.

The address is a **one-shot instruction**: every exit uses `replace: true`, so Back never
returns to it and re-draws.

## Context

The absorb brief's NFC table ([§5](https://…/2026-08-22-tonight-picker-merge…)) has four rows.
Three of them already worked before this record:

| Card | How it works |
| --- | --- |
| A kids show rotation / channel | `{"set": "<id>"}` on `queuepilot/cmd/session/start`. No live parameters. |
| A curated per-audience queue | The same. Twelve of these are on the wall. |
| A solo reading queue | `/go/<setId>` — one address, one queue, no form. |
| **A Pick preset — people and filters baked in** | **Had no address at all.** |
| Bare "board games", needing live who's-here | ❌ Use the app. |

WP-8 built `/result` and `/result/<gameId>`, so the *destination* existed. What did not exist
was a way for a card to reach it: the only address a card could carry was `/tonight`, which is
the form. §5's last line is explicit — *"Pick-preset NFC → land on result card (or announce),
not an empty form."*

## Why

- **A card that opens a form has spent the tap and asked the question again.** The whole point
  of a preset is that the answers are already known. Landing on the form is not a smaller
  version of working; from the couch it reads as "the card did not work".
- **A card cannot see the room, so rule 3 is a rule and not a gap.** This is the fourth row's
  ❌ made machine-enforced rather than written down somewhere. The tempting "fix" is to treat an
  empty roster as everybody — and a board-game pick is chosen *by table size*, so that produces
  a confident pick for a table nobody stated. Refusing is the honest answer and it costs one
  tap on a screen that is already open.
- **A card is written once and read for years.** That makes a typo the failure to design for,
  which is why an unknown filter value falls back rather than passing through. A card that
  silently changes what gets picked is worse than one that does nothing.
- **A person id and not a name.** A display name is edited; an id is the wire value. This is the
  same rule `sets.id` has had since the registry existed, applied to the other half of the
  address.
- **The draw is ONE function.** `lib/tonightDraw.ts`. It was written out inside the Go button —
  exactly where a second caller cannot reach it — and a copy would be two places for "which
  engine does this activity use" to drift apart from `routeFor`.
- **The refusal is rendered in the view, not toasted.** The first attempt used `setStatus`, and
  the sentence was gone before anybody read it: the form under it is mid-load and publishes its
  own status, and the last writer wins. `#tonight-preset-note` sits beside the control that can
  fix it and clears when the person changes something.

## Evidence

- Absorb brief §5, last line: *"Pick-preset NFC → land on result card (or announce), not an
  empty form."* The fourth row's ❌: *"Bare 'board games' needing live who's-here → Use the
  app."*
- The twelve cards on the wall are all queue cards, verified against
  `automation.plex_nfc_scanner`'s `tag_command_map` on 2026-08-25. None is a preset today, so
  this record builds the road rather than repairing one.
- `e2e/tonight-preset-test.ts` — 21 assertions in a real browser: the landing on `/result` with
  a card and a reroll, the refusal for a card naming nobody, Surprise Me, an unknown activity,
  an empty draw carrying the engine's own reason, and `/result/<gameId>` still having no
  reroll.
- `web/src/lib/tonightPreset.test.ts` (14) and `tonightDraw.test.ts` (6) — the grammar, the
  round-trip through `tonightPresetHref`, and which door each activity knocks on.

## How to apply

- Writing a card? Build the address with `tonightPresetHref()`, never by hand — it and the
  parser are inverses, and it leaves a filter sitting at its own default out of the URL.
- Adding a filter to an activity? Declare it in `ACTIVITY_FILTERS` and it is accepted on a card
  for free. Nothing in `tonightPreset.ts` names a filter.
- Tempted to make an empty roster mean "everybody"? That is rule 3, and reversing it is a new
  decision record rather than a call-site choice.

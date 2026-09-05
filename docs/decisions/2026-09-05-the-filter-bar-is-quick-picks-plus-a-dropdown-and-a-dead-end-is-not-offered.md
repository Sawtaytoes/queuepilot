# The filter bar is quick picks plus a dropdown, and a dead end is not offered

- **Status:** Accepted
- **Date:** 2026-09-05
- **Type:** UI / layout
- **Supersedes:** the chip-per-person layout in [the landing filters by people and the group chips go](2026-08-26-the-landing-filters-by-people-and-the-group-chips-go.md) (the people-filter model itself is unchanged)
- **Superseded by:** —

## Decision

The people and provider filters are **one row**.

- The first **four** of the roster are chips, plus **every ticked person** wherever they sit in
  the roster. Quick-pick membership is roster order, which the owner sets in Edit people.
- The rest of the roster sits behind one `+ N more` control — a Charcuterie
  `Combobox isMultiple` with a search field, a face, a name and a count per row. Picking does
  not close it.
- The provider pills stay **pills**, on the **right** of the same row (`margin-left: auto`).
  They take their own line only in the Narrow View.
- A person the current selection **shares no queue with** is not offered: the chip disappears,
  and the dropdown row is disabled. A **ticked** person is never hidden and never disabled.

The dead-end test is "does any queue with a roster name all of these people", not "is the
count zero".

## Context

At nine people the bar was three rows — two of wrapped people chips and a third holding two
provider pills — under a toolbar row, on a page whose actual content starts below all of it.
The roster only grows.

Separately, the bar offered combinations that cannot exist. Two people who share no queue is
the ordinary case in a household, and ticking the second one emptied the page and then had to
be undone.

## Why

- **One tap per person is the thing worth keeping, and it does not have to be every person.**
  Four covers the people asked for most, and nobody is unreachable — the dropdown holds the
  rest and has a search field, which the chip row never did.
- **A ticked person is always a chip.** What is ON must be visible and removable without
  opening a panel, and that is what a dropdown alone loses.
- **Quick-pick order is the roster, not a usage ranking.** A control that reorders itself as
  you use it is a control you cannot build muscle memory for.
- **Hide the chip, disable the row.** The owner's own split, and each is right for its shape.
  A greyed chip still occupies the row the change exists to shorten; a dropdown row that
  vanishes makes the panel change length as you type and makes `N more` untrue.
- **Never hide a ticked person.** Clicking a ticked chip removes it, which is the way back out
  of a selection that has filtered the page to nothing. Hiding it there is a dead end with no
  exit.
- **⚠️ The dead-end test cannot be a count of zero.** A queue nobody is filed on passes every
  people filter — that is the 2026-08-26 rule and it is correct — so the count for two people
  who share nothing is however many unfiled queues the house owns, which is at least one. A
  count-based test would never have fired.
- **The `⚙` and `▾` characters do not render.** Both are outside the Latin subset of Outfit
  that `vite.config.ts` preloads, and `⚙ Edit people` had been painting a tofu box on the live
  landing. The glyphs are inline SVGs now, the same route `SchemeIcons.tsx` took.

## Evidence

Owner, 2026-09-05, on the layout:

> "while I like the Plex and Kavita filters, I don't like where they're at. They take up a
> whole line of space that's very necessary. I kinda think both of those could be handled by 2
> multi-select combobox dropdowns instead."

> "I like the quick filters we have right now, but they just take up a lot of space and don't
> scale well."

After comparing three built layouts on a served preview:

> "Compact is really good. I kinda like a combination of both. Like a 'quick pick' version with
> a few selected people and then a combobox dropdown that can optionally show more items that
> are selected. I also like the Plex and Kavita ones being on the side the way you did it."

And on dead ends:

> "What might be good as well is to disable (in the combobox) or hide (in the chips list) the
> ones that aren't able to be clicked. For instance, if I click 'Kevin', that's pretty much
> every queue, but if I click 'Ashlee', there are some invalid combinations like Ashlee and
> Sheldon. Sheldon should disable or disappear when she's been selected."

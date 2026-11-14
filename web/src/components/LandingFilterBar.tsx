import { Link } from "react-router"

import type { Person } from "../lib/types"
import {
  filterPath,
  toggleValue,
} from "../state/landingFilter"
import { openPeopleModal } from "../state/overlays"
import { MorePeople, type PersonOffer } from "./MorePeople"
import { PersonFace } from "./PersonFace"

/**
 * WHO ARE YOU LOOKING FOR — the people filter at the top of the landing, and the provider
 * filter on the right of the same row.
 *
 * ## What this replaced, and why
 *
 * Until 2026-08-26 this row was a chip per GROUP — All, Bob, Older Kids, Younger Kids, Demo
 * — and picking one navigated to `/g/<id>`. The owner asked for the chips to go:
 *
 * > "this selection of 'All', 'Alex', 'Older Kids', etc can go away. We were changing this
 * > to allow selecting people, and then I can narrow it down from there. … The current
 * > groups are no longer needed!"
 *
 * A group was doing two jobs and only one of them survives here. As a MEMBERSHIP RULE it is
 * load-bearing and untouched — "at least one of Grace or Linus" is a set, a number and a
 * spare, it is what a queue's tray holds, and it is what resolves the one provider profile a
 * queue signs in as. As a SHELF LABEL it was a second vocabulary to maintain beside the
 * people, and it could only ever offer the combinations somebody had written down in advance.
 * Ticking people composes them instead
 * (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`).
 *
 * ## A few quick picks, then a dropdown for the rest (2026-09-05)
 *
 * A chip per person was the whole roster on screen at all times. That is one tap per person,
 * which is the thing worth keeping, and it is three wrapped rows at nine people and worse at
 * twelve — *"I like the quick filters we have right now, but they just take up a lot of space
 * and don't scale well."*
 *
 * So the row carries the **first `QUICK_PICK_COUNT` of the roster** as chips, plus **every
 * ticked person wherever they sit in it**, and the remainder go behind one `+ N more`
 * dropdown. Nobody is unreachable and nothing that is ON is hidden:
 *
 * > "a 'quick pick' version with a few selected people and then a combobox dropdown that can
 * > optionally show more items that are selected."
 *
 * Which people are quick — and therefore which are one tap — is **roster order**, which the
 * owner sets in Edit people. It is deliberately not a most-used ranking: a control that
 * reorders itself as you use it is a control you cannot build muscle memory for.
 *
 * The provider pills stay pills, on the right of the same row rather than on one of their own
 * — *"I also like the Plex and Kavita ones being on the side the way you did it."*
 *
 * ## A DEAD END IS NOT OFFERED
 *
 * Adding a name that would leave nothing on screen is not a filter, it is a wasted tap that
 * empties the page and then has to be undone. Two people who share no queue at all is the
 * ordinary case in a household, not an edge:
 *
 * > "if I click 'Alex', that's pretty much every queue, but if I click 'Morgan', there are
 * > some invalid combinations like Morgan and Piper. Piper should disable or disappear
 * > when she's been selected."
 *
 * So a person the selection shares NO QUEUE with goes: the chip disappears, and the dropdown
 * row is disabled rather than removed — the owner's own split, and the right one. A chip that
 * greys out still occupies the row it was meant to shorten; a dropdown row that vanishes makes
 * the panel's list change length as you type, and "N more" stop being true.
 *
 * ⚠️ The test is `hasQueueFor`, NOT a count of zero. A queue nobody is filed on shows under
 * every filter — that is the 2026-08-26 rule and it is right — so the count with two people
 * who share nothing is not 0, it is however many unfiled queues the house owns. On the live
 * data that is at least one, and a dead-end test written on the count would therefore never
 * have fired even once.
 *
 * ⚠️ **A TICKED person is never hidden and never disabled**, whatever their count says.
 * Clicking a ticked chip REMOVES that person, which is always a legal move — and it is the
 * only way back out of a selection that has filtered the page down to nothing. Hiding it there
 * is a dead end with no exit, which is worse than the one this rule closes.
 *
 * ## Both filters are MULTI-SELECT, and the provider one only became so on 2026-09-05
 *
 * A person chip's href is the current address with that person added or taken away, so
 * middle-click, ⌘-click, "copy link" and the status-bar preview all still come for free
 * (decision `2026-08-15-navigation-is-an-anchor-not-a-button`). The provider filter used to
 * be one kind at a time; it is a list now, spelled the same comma way, so "Plex and Kavita
 * but not the board games" is an address.
 *
 * ## The count on a chip
 *
 * **How many cards you get with that person INCLUDED**, on top of whoever else is ticked —
 * both tiers, exact and also-in, because both are cards on the screen.
 *
 * It is deliberately not "what you get if you click", which is the same thing on an unticked
 * chip and something else entirely on a ticked one — clicking a ticked chip REMOVES that
 * person, so that reading put the unfiltered total on the one chip that is currently doing
 * the filtering. Measured on the fixture: Linus ticked, five cards on screen, and his own chip
 * said 17.
 *
 * ⚠️ It counts **both tiers on purpose.** While it counted only exact matches, every person
 * who never has a queue to herself read `0` while her queues were plainly on the screen under
 * Anyone — *"That is very strange since they do have queues shown."* A chip that says 0 and
 * then shows you four cards is worse than no chip at all
 * (decision `2026-09-05-the-people-filter-answers-in-two-tiers-exact-then-also-in`).
 *
 * The provider pills only appear when more than one backend is actually reachable. Offering
 * "Plex / Kavita" to a house that has only Plex is a control that can only ever be a no-op.
 */

/**
 * How many of the roster are chips before the rest fold into the dropdown.
 *
 * Four, measured rather than chosen: at 1400px the row holds Anyone, four chips, the more
 * control, Edit people and two provider pills on ONE line, which is the whole point of the
 * change. A ticked person outside the four is added to the row, so the real maximum is four
 * plus however many are ticked — and somebody who has ticked six people has told you they want
 * six chips.
 *
 * A quick pick that a dead end has hidden is NOT backfilled from the rest of the roster. The
 * row would stay four chips long, and they would be four different people each time you
 * ticked somebody — a chip you are reaching for must not move because of a chip you pressed.
 */
const QUICK_PICK_COUNT = 4

/**
 * ⚙ Edit people's glyph.
 *
 * ⚠️ It replaces the `⚙` CHARACTER, which rendered as a tofu box on this app's own landing —
 * U+2699 is outside the LATIN subset of Outfit, exactly like the chevron above, and it had
 * been shipping that way. `SchemeIcons.tsx` says the app has no icon library and that raw
 * characters are the convention; this is the second glyph to prove the convention only works
 * for a character the font actually carries.
 */
const GEAR = (
  <svg
    aria-hidden="true"
    className="filtercaret"
    fill="none"
    focusable={false}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.75}
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

export type LandingFilterBarProps = {
  /** The path the chips hang off — `/`, without the query. */
  basePath: string
  /** How many cards a given filter would show. Called once per chip, with that chip's person
   *  INCLUDED — see the note above. */
  countFor: (
    people: readonly string[],
    only: readonly string[],
  ) => number
  /**
   * Whether any queue NAMES all of these people at once — the dead-end test.
   *
   * Deliberately not `countFor(...) > 0`: a queue nobody is filed on passes every people
   * filter, so it answers yes for a pair that shares nothing. This one asks only about queues
   * that carry a roster, which is the question "is this combination a thing in this house".
   */
  hasQueueFor: (
    people: readonly string[],
    only: readonly string[],
  ) => boolean
  /**
   * A provider kind's display name.
   *
   * Passed in rather than mapped here, because the answer already exists: every set carries
   * its provider's `vocabulary.name` (the same slot that rewrites "Plex" in authored copy),
   * and only the caller holds the registry. A local `{plex: "Plex", kavita: "Kavita"}` would
   * be a second list to remember when a fourth backend lands.
   */
  labelForKind: (kind: string) => string
  /** The provider kinds ticked, or empty for all of them. */
  only: readonly string[]
  /** The roster, in roster order. */
  people: readonly Person[]
  /** Every provider kind in the registry, in registry order. */
  providerKinds: readonly string[]
  /** The live query string, so a chip keeps the OTHER filter while it changes its own. */
  search: string
  /** Who is ticked. */
  selected: readonly string[]
}

export function LandingFilterBar({
  basePath,
  countFor,
  hasQueueFor,
  labelForKind,
  only,
  people,
  providerKinds,
  search,
  selected,
}: LandingFilterBarProps) {
  const offers: PersonOffer[] = people.map((person) => {
    const isOn = selected.includes(person.id)
    // WITH them, whichever way the control is pointing. The href's selection is the OPPOSITE
    // of this on a ticked chip — see the note above.
    const withThem = countFor(
      isOn ? selected : [...selected, person.id],
      only,
    )

    return {
      isDeadEnd:
        !isOn &&
        !hasQueueFor([...selected, person.id], only),
      isOn,
      person,
      withThem,
    }
  })

  /**
   * The chips: the head of the roster, plus anybody ticked further down it.
   *
   * Chosen by id and then filtered out of `offers`, rather than concatenated, so the row stays
   * in ROSTER ORDER — a ticked person who was already a quick pick must not appear twice, and
   * one who was not must not jump to the end and move the chips beside her.
   */
  const quickIds = new Set([
    ...people
      .slice(0, QUICK_PICK_COUNT)
      .map((person) => person.id),
    ...selected,
  ])
  const quick = offers.filter(
    (offer) =>
      quickIds.has(offer.person.id) && !offer.isDeadEnd,
  )
  const rest = offers.filter(
    (offer) => !quickIds.has(offer.person.id),
  )

  return (
    <nav aria-label="Filter" className="filterbar">
      <ul className="filterchips" id="peoplechips">
        <li>
          {/* ANYONE is an address, not the absence of one — the same lesson the All chip
              taught on 2026-08-19. It has to be clickable from a filtered view, so it is a
              link to the unfiltered one rather than a state nothing can navigate to. It is
              also the way OUT of a selection that shows nothing, so it is never hidden. */}
          <Link
            aria-current={
              selected.length ? undefined : "page"
            }
            className="filterchip"
            to={filterPath(basePath, search, {
              people: [],
            })}
          >
            Anyone
            <span className="filtercount">
              {countFor([], only)}
            </span>
          </Link>
        </li>
        {quick.map(({ isOn, person, withThem }) => (
          <li key={person.id}>
            <Link
              aria-current={isOn ? "page" : undefined}
              className="filterchip"
              to={filterPath(basePath, search, {
                people: toggleValue(selected, person.id),
              })}
            >
              {/* The same circle the cards and the trays draw, so one person is one colour
                  everywhere in the app. It is `aria-hidden`, and the name beside it is the
                  link's accessible name. */}
              <PersonFace
                id={person.id}
                label={person.displayName}
              />
              {person.displayName}
              <span className="filtercount">
                {withThem}
              </span>
            </Link>
          </li>
        ))}
        {rest.length ? (
          <li>
            <MorePeople
              basePath={basePath}
              rest={rest}
              search={search}
              selected={selected}
            />
          </li>
        ) : null}
        <li>
          {/* WHO EXISTS, beside who you can pick — and, since the quick picks are the head of
              the roster, also where their ORDER is set. */}
          <button
            className="filterchip filteredit"
            id="peopleedit"
            onClick={openPeopleModal}
            type="button"
          >
            {GEAR}
            Edit people
          </button>
        </li>
      </ul>

      {providerKinds.length > 1 ? (
        <ul
          className="filterchips providerchips"
          id="providerchips"
        >
          {providerKinds.map((kind) => {
            const isOn = only.includes(kind)
            const withIt = isOn ? only : [...only, kind]

            return (
              <li key={kind}>
                <Link
                  aria-current={isOn ? "page" : undefined}
                  className="filterchip"
                  // The chip wears the backend's own colour, same rule as every other
                  // provider-owned control on the page.
                  data-provider={kind}
                  to={filterPath(basePath, search, {
                    only: toggleValue(only, kind),
                  })}
                >
                  {labelForKind(kind)}
                  <span className="filtercount">
                    {countFor(selected, withIt)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : null}
    </nav>
  )
}

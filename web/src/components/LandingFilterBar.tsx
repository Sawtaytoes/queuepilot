import { Link } from "react-router"

import type { Person } from "../lib/types"
import {
  filterPath,
  togglePerson,
} from "../state/landingFilter"
import {
  openGroupsModal,
  openPeopleModal,
} from "../state/overlays"
import { PersonFace } from "./PersonFace"

/**
 * WHO ARE YOU LOOKING FOR — the row of people at the top of the landing, and the provider
 * filter under it.
 *
 * ## What this replaced, and why
 *
 * Until 2026-08-26 this row was a chip per GROUP — All, Bob, Older Kids, Younger Kids, Demo
 * — and picking one navigated to `/g/<id>`. The owner asked for the chips to go:
 *
 * > "this selection of 'All', 'Kevin', 'Older Kids', etc can go away. We were changing this
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
 * ## Every chip is still a real `<a href>`, and now it toggles
 *
 * A person chip's href is the current address with that person added or taken away, so
 * middle-click, ⌘-click, "copy link" and the status-bar preview all still come for free
 * (decision `2026-08-15-navigation-is-an-anchor-not-a-button`). The chips are MULTI-select,
 * which the single-select group row never was — that is the capability the change buys, and
 * it is why `aria-current` marks each ticked person rather than one chip.
 *
 * The count on a chip is **how many cards you get with that person INCLUDED**, on top of
 * whoever else is ticked. Not what the person owns in the abstract: with Linus ticked, Ada's
 * chip says how many queues the two of them share, which is the number the tap is about to
 * produce.
 *
 * It is deliberately not "what you get if you click", which is the same thing on an unticked
 * chip and something else entirely on a ticked one — clicking a ticked chip REMOVES that
 * person, so that reading put the unfiltered total on the one chip that is currently doing
 * the filtering. Measured on the fixture: Linus ticked, five cards on screen, and his own chip
 * said 17.
 *
 * The provider row only appears when more than one backend is actually reachable. Offering
 * "Plex / Kavita" to a house that has only Plex is a control that can only ever be a no-op.
 */
export function LandingFilterBar({
  basePath,
  countFor,
  labelForKind,
  only,
  people,
  providerKinds,
  search,
  selected,
}: {
  /** The path the chips hang off — `/`, without the query. */
  basePath: string
  /** The live query string, so a chip keeps the OTHER filter while it changes its own. */
  search: string
  /** The roster, in roster order. */
  people: readonly Person[]
  /** Who is ticked. */
  selected: readonly string[]
  /** The active provider filter, or null for all. */
  only: string | null
  /** Every provider kind in the registry, in registry order. */
  providerKinds: string[]
  /** How many cards a given filter would show. Called once per chip, with that chip's person
   *  INCLUDED — see the note above. */
  countFor: (
    people: readonly string[],
    only: string | null,
  ) => number
  /**
   * A provider kind's display name.
   *
   * Passed in rather than mapped here, because the answer already exists: every set carries
   * its provider's `vocabulary.name` (the same slot that rewrites "Plex" in authored copy),
   * and only the caller holds the registry. A local `{plex: "Plex", kavita: "Kavita"}` would
   * be a second list to remember when a fourth backend lands.
   */
  labelForKind: (kind: string) => string
}) {
  return (
    <nav aria-label="Filter" className="filterbar">
      <ul className="filterchips" id="peoplechips">
        <li>
          {/* ANYONE is an address, not the absence of one — the same lesson the All chip
              taught on 2026-08-19. It has to be clickable from a filtered view, so it is a
              link to the unfiltered one rather than a state nothing can navigate to. */}
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
        {people.map((person) => {
          const isOn = selected.includes(person.id)
          const next = togglePerson(selected, person.id)
          // WITH them, whichever way the chip is pointing. `next` is the href's selection and
          // is the opposite of this on a ticked chip — see the note above.
          const withThem = isOn
            ? selected
            : [...selected, person.id]

          return (
            <li key={person.id}>
              <Link
                aria-current={isOn ? "page" : undefined}
                className="filterchip"
                to={filterPath(basePath, search, {
                  people: next,
                })}
              >
                {/* The same circle the cards and the trays draw, so one person is one
                    colour everywhere in the app. It is `aria-hidden`, and the name beside
                    it is the link's accessible name. */}
                <PersonFace
                  id={person.id}
                  label={person.displayName}
                  size="sm"
                />
                {person.displayName}
                <span className="filtercount">
                  {countFor(withThem, only)}
                </span>
              </Link>
            </li>
          )
        })}
        <li>
          {/* WHO EXISTS, beside who you can pick. */}
          <button
            className="filterchip filteredit"
            id="peopleedit"
            onClick={openPeopleModal}
            type="button"
          >
            ⚙ Edit people
          </button>
        </li>
        <li>
          {/* A GROUP IS STILL A THING, it is just not a chip. It holds "at least one of the
              kids", it is what a queue's Must-be-here tray points at, and it resolves the
              one provider profile a queue signs in as — so its editor has to stay reachable
              even though nothing on this page filters by it. Here rather than buried in the
              queue editor, because it is the other half of the question the chip beside it
              asks. */}
          <button
            className="filterchip filteredit"
            id="groupsedit"
            onClick={() => openGroupsModal(null)}
            type="button"
          >
            ⚙ Edit groups
          </button>
        </li>
      </ul>

      {providerKinds.length > 1 ? (
        <ul
          className="filterchips providerchips"
          id="providerchips"
        >
          <li>
            <Link
              aria-current={only ? undefined : "page"}
              className="filterchip"
              to={filterPath(basePath, search, {
                only: null,
              })}
            >
              All
            </Link>
          </li>
          {providerKinds.map((kind) => (
            <li key={kind}>
              <Link
                aria-current={
                  only === kind ? "page" : undefined
                }
                className="filterchip"
                // The chip wears the backend's own colour, same rule as every other
                // provider-owned control on the page.
                data-provider={kind}
                to={filterPath(basePath, search, {
                  only: kind,
                })}
              >
                {labelForKind(kind)}
                <span className="filtercount">
                  {countFor(selected, kind)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  )
}

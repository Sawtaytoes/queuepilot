import { useVisibility } from "@charcuterie/logic"
import { Badge, Button, Combobox } from "@charcuterie/ui"
import { Link, useNavigate } from "react-router"

import type { Person } from "../lib/types"
import {
  filterPath,
  toggleValue,
} from "../state/landingFilter"
import { openPeopleModal } from "../state/overlays"
import { PersonFace } from "./PersonFace"

/**
 * WHO ARE YOU LOOKING FOR — the people filter at the top of the landing, and the provider
 * filter beside it.
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
 * then shows you four cards is worse than no chip at all.
 *
 * ## The three layouts
 *
 * `variant` is a PREVIEW SWITCH and one of these is going to be deleted — see
 * `LANDING_FILTER_VARIANTS`. The owner asked to compare a chip row against the two
 * multi-select dropdowns he proposed, on the real page with a real roster, before either is
 * built for good.
 *
 * The provider row only appears when more than one backend is actually reachable. Offering
 * "Plex / Kavita" to a house that has only Plex is a control that can only ever be a no-op.
 */
/**
 * A trigger with no chevron reads as a button that DOES something rather than as a control
 * that opens a list. The app's other pickers get theirs from `Picker`; `Combobox` takes a
 * trigger of the caller's choosing and adds nothing to it, so this is `Picker`'s own glyph,
 * copied.
 *
 * ⚠️ It is an SVG rather than the `▾` character on purpose. `▾` is U+25BE, outside the LATIN
 * subset (`U+0000-00FF`) `vite.config.ts` preloads and the only subset of Outfit that carries
 * the UI text — so it rendered as nothing at all in the first build of this control, with no
 * error anywhere.
 */
const CHEVRON_DOWN = (
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
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const LANDING_FILTER_VARIANTS = [
  "chips",
  "combos",
  "compact",
] as const

export type LandingFilterVariant =
  (typeof LANDING_FILTER_VARIANTS)[number]

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
  /** Which layout to draw. Temporary — see the note above. */
  variant?: LandingFilterVariant
}

export function LandingFilterBar(
  props: LandingFilterBarProps,
) {
  const variant = props.variant ?? "chips"

  return (
    <nav
      aria-label="Filter"
      className={`filterbar filterbar-${variant}`}
    >
      {variant === "chips" ? (
        <ChipsLayout {...props} />
      ) : (
        <DropdownLayout {...props} variant={variant} />
      )}
    </nav>
  )
}

// ── the chip layouts ───────────────────────────────────────────────────────────────────── //

/**
 * Every filter as a pressable pill, which is what shipped on 2026-08-26.
 *
 * The change here is that the provider pills join the SAME wrapping flow as the people, after
 * a divider, rather than owning a line of their own. Two rows of people and a third row
 * holding two provider pills was most of the header — *"They take up a whole line of space
 * that's very necessary."*
 */
function ChipsLayout({
  basePath,
  countFor,
  labelForKind,
  only,
  people,
  providerKinds,
  search,
  selected,
}: LandingFilterBarProps) {
  return (
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
          to={filterPath(basePath, search, { people: [] })}
        >
          Anyone
          <span className="filtercount">
            {countFor([], only)}
          </span>
        </Link>
      </li>
      {people.map((person) => {
        const isOn = selected.includes(person.id)
        const next = toggleValue(selected, person.id)
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
      {providerKinds.length > 1 ? (
        <>
          {/* A hairline rather than a second `<ul>`: the provider pills are the same kind
              of control and belong in the same wrapping flow, but they answer a different
              question, so the eye needs to know where one filter stops. */}
          <li aria-hidden="true" className="filterdivide" />
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
        </>
      ) : null}
    </ul>
  )
}

// ── the dropdown layouts ───────────────────────────────────────────────────────────────── //

/**
 * The two multi-select dropdowns, which is what the owner proposed:
 *
 * > "I kinda think both of those could be handled by 2 multi-select combobox dropdowns
 * > instead."
 *
 * `combos` is that and nothing else — one row, whatever the roster grows to. `compact` adds
 * the ticked people back beside the trigger as removable chips, so a filter that is ON is
 * legible without opening the panel; it costs a line only once something is ticked.
 *
 * Both use Charcuterie's `Combobox isMultiple`, the same control `TonightView`'s category
 * filter uses.
 *
 * ⚠️ `Combobox isMultiple` renders its OWN chip rail above the trigger, and `.filterpicker`
 * hides it. That rail is the right answer in a form — it is how you see and remove what you
 * picked — and it is the wrong one here, because it sits ABOVE the trigger and puts back
 * exactly the line this layout exists to save. The trigger already names the selection, and
 * `compact` draws the removable chips itself, beside the control rather than over it.
 * If one of these layouts wins, the rail is turned off with a PROP upstream rather than with
 * this rule — a shared shape is fixed in Charcuterie, not per app.
 */
function DropdownLayout({
  basePath,
  countFor,
  labelForKind,
  only,
  people,
  providerKinds,
  search,
  selected,
  variant,
}: LandingFilterBarProps & {
  variant: LandingFilterVariant
}) {
  const isCompact = variant === "compact"
  const nameOf = (id: string) =>
    people.find((person) => person.id === id)
      ?.displayName ?? id

  return (
    <div className="filterrow">
      <PeopleDropdown
        basePath={basePath}
        countFor={countFor}
        isNamingSelection={!isCompact}
        only={only}
        people={people}
        search={search}
        selected={selected}
      />

      {providerKinds.length > 1 ? (
        <ProviderDropdown
          basePath={basePath}
          countFor={countFor}
          isNamingSelection={!isCompact}
          labelForKind={labelForKind}
          only={only}
          providerKinds={providerKinds}
          search={search}
          selected={selected}
        />
      ) : null}

      {/* WHO EXISTS, beside who you can pick — the same control the chip row carries, and
          the reason it is still a raw button is the same: it is chip-shaped, in a row of
          chip-shaped links, and `BadgeLink` does not exist yet. */}
      <button
        className="filterchip filteredit"
        id="peopleedit"
        onClick={openPeopleModal}
        type="button"
      >
        ⚙ Edit people
      </button>

      {isCompact ? (
        <ul className="filterpicked">
          {selected.map((personId) => (
            <li key={personId}>
              {/* Each ticked person as a REMOVABLE chip: the whole chip is the remove
                  control, so taking one name back off is a single tap and never needs
                  the panel. It stays a `<Link>`, so the address rule holds. */}
              <Link
                aria-label={`Remove ${nameOf(personId)}`}
                className="filterchip filterchip-picked"
                to={filterPath(basePath, search, {
                  people: toggleValue(selected, personId),
                })}
              >
                <PersonFace
                  id={personId}
                  label={nameOf(personId)}
                  size="sm"
                />
                {nameOf(personId)}
                <span aria-hidden="true">✕</span>
              </Link>
            </li>
          ))}
          {only.map((kind) => (
            <li key={kind}>
              <Link
                aria-label={`Remove ${labelForKind(kind)}`}
                className="filterchip filterchip-picked"
                data-provider={kind}
                to={filterPath(basePath, search, {
                  only: toggleValue(only, kind),
                })}
              >
                {labelForKind(kind)}
                <span aria-hidden="true">✕</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The people dropdown.
 *
 * The trigger names the SELECTION rather than the control, because that is the thing whose
 * value somebody is checking at a glance: "Anyone", one name, or "3 people". The panel's rows
 * carry the face and the count, so the list reads the way the chip row did.
 *
 * Selecting does not close the panel — `Combobox isMultiple` keeps it open and clears the
 * query for the next one — which is the whole reason a multi-select is worth having here.
 */
function PeopleDropdown({
  basePath,
  countFor,
  isNamingSelection,
  only,
  people,
  search,
  selected,
}: { isNamingSelection: boolean } & Pick<
  LandingFilterBarProps,
  | "basePath"
  | "countFor"
  | "only"
  | "people"
  | "search"
  | "selected"
>) {
  const panel = useVisibility()
  /**
   * A pick NAVIGATES, because the address is still the whole truth — the same rule the chips
   * follow. A `Combobox` row cannot be a `<Link>`: its job is to toggle one value and leave
   * the panel open for the next one, which is the entire point of a multi-select.
   */
  const navigate = useNavigate()
  /**
   * `combos` has nothing else on the row, so the trigger has to BE the selection. `compact`
   * draws the ticked names as chips beside it, so a trigger that repeated them would print
   * "Sven" twice in 40px of each other — there it stays a stable "People" and the chips are
   * the answer.
   */
  const label = !isNamingSelection
    ? "People"
    : selected.length === 0
      ? "Anyone"
      : selected.length === 1
        ? (people.find(
            (person) => person.id === selected[0],
          )?.displayName ?? "1 person")
        : `${selected.length} people`

  return (
    <div className="filterpicker">
      <Combobox
        emptyLabel="Nobody by that name"
        isMultiple
        isVisible={panel.isVisible}
        onDismiss={panel.hide}
        onSelect={(personId) => {
          navigate(
            filterPath(basePath, search, {
              people: toggleValue(selected, personId),
            }),
          )
        }}
        options={people.map((person) => ({
          label: (
            <span
              className="filteroption"
              data-value={person.id}
            >
              <PersonFace
                id={person.id}
                label={person.displayName}
                size="sm"
              />
              <span className="optionlabel">
                {person.displayName}
              </span>
              <Badge
                appearance="outline"
                className="optionbadge"
                intent="neutral"
                size="sm"
              >
                {String(
                  countFor(
                    selected.includes(person.id)
                      ? selected
                      : [...selected, person.id],
                    only,
                  ),
                )}
              </Badge>
            </span>
          ),
          textValue: person.displayName,
          value: person.id,
        }))}
        placeholder="Search people…"
        selectedValue={selected}
        trigger={
          <Button
            appearance="outline"
            aria-label={`People: ${label}`}
            data-testid="peoplepicker"
            id="peoplepicker"
            // NEUTRAL, like every other picker trigger in the app. A `Button` defaults to
            // the accent intent, which paints this as a call to action sitting where a form
            // control belongs — and it is the loudest thing on the page beside ＋ New queue.
            intent="neutral"
            onClick={panel.toggle}
          >
            {label}
            <span className="filtercount">
              {countFor(selected, only)}
            </span>
            {CHEVRON_DOWN}
          </Button>
        }
      />
    </div>
  )
}

/** The provider dropdown — the same control, over the backends. */
function ProviderDropdown({
  basePath,
  countFor,
  isNamingSelection,
  labelForKind,
  only,
  providerKinds,
  search,
  selected,
}: { isNamingSelection: boolean } & Pick<
  LandingFilterBarProps,
  | "basePath"
  | "countFor"
  | "labelForKind"
  | "only"
  | "providerKinds"
  | "search"
  | "selected"
>) {
  const panel = useVisibility()
  const navigate = useNavigate()
  const label = !isNamingSelection
    ? "Libraries"
    : only.length === 0
      ? "Every library"
      : only.map(labelForKind).join(", ")

  return (
    <div className="filterpicker">
      <Combobox
        emptyLabel="No such library"
        isMultiple
        isVisible={panel.isVisible}
        onDismiss={panel.hide}
        onSelect={(kind) => {
          navigate(
            filterPath(basePath, search, {
              only: toggleValue(only, kind),
            }),
          )
        }}
        options={providerKinds.map((kind) => ({
          label: (
            <span
              className="filteroption"
              data-provider={kind}
              data-value={kind}
            >
              <span className="optionlabel">
                {labelForKind(kind)}
              </span>
              <Badge
                appearance="outline"
                className="optionbadge"
                intent="neutral"
                size="sm"
              >
                {String(
                  countFor(
                    selected,
                    only.includes(kind)
                      ? only
                      : [...only, kind],
                  ),
                )}
              </Badge>
            </span>
          ),
          textValue: labelForKind(kind),
          value: kind,
        }))}
        placeholder="Search libraries…"
        selectedValue={only}
        trigger={
          <Button
            appearance="outline"
            aria-label={`Libraries: ${label}`}
            data-testid="providerpicker"
            id="providerpicker"
            intent="neutral"
            onClick={panel.toggle}
          >
            {label}
            {CHEVRON_DOWN}
          </Button>
        }
      />
    </div>
  )
}

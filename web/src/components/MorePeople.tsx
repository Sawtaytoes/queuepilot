import { useVisibility } from "@charcuterie/logic"
import { Badge, Button, Combobox } from "@charcuterie/ui"
import { useNavigate } from "react-router"
import type { Person } from "../lib/types"
import {
  filterPath,
  toggleValue,
} from "../state/landingFilter"
import { PersonFace } from "./PersonFace"

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

/** What a person's chip or row would show you, and therefore whether it is worth offering. */
export type PersonOffer = {
  /** True when ticking this person would empty the page. Never true for a ticked person. */
  isDeadEnd: boolean
  isOn: boolean
  person: Person
  /** The count the control prints: the cards you get with this person INCLUDED. */
  withThem: number
}

/**
 * The rest of the roster, behind one control.
 *
 * A `Combobox isMultiple` rather than a `Listbox`, for the reason the picker rule gives: this
 * list is as long as the household and is the one control here that wants typing. Picking does
 * not close it — multi-select keeps the panel open and clears the query for the next name —
 * which is the whole reason a multi-select is worth having.
 *
 * It holds only the people who are NOT already chips. Somebody ticked here becomes a chip on
 * the next render and leaves this list, which is what makes "N more" a true count and stops
 * the same person being tickable in two places at once.
 */
export function MorePeople({
  basePath,
  rest,
  search,
  selected,
}: {
  basePath: string
  /** The roster minus the chips, in roster order. */
  rest: readonly PersonOffer[]
  search: string
  selected: readonly string[]
}) {
  const panel = useVisibility()
  /**
   * A pick NAVIGATES, because the address is still the whole truth — the same rule the chips
   * follow. A `Combobox` row cannot be a `<Link>`: its job is to toggle one value and leave
   * the panel open for the next one.
   */
  const navigate = useNavigate()

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
        options={rest.map(
          ({ isDeadEnd, person, withThem }) => ({
            // DISABLED, not removed — see the note at the top of this file. A row that
            // vanishes as you tick people makes the panel change length under the cursor and
            // makes "N more" a lie.
            isDisabled: isDeadEnd,
            label: (
              <span
                className="filteroption"
                data-value={person.id}
              >
                <PersonFace
                  id={person.id}
                  label={person.displayName}
                />
                <span className="optionlabel">
                  {person.displayName}
                </span>
                {/* The same number the chip carries, so folding somebody into this list does
                    not cost the one piece of information the chip was giving.

                    NOT on a disabled row. The count there is TRUE and reads as a
                    contradiction: a queue nobody is filed on still shows under any filter,
                    so a person who shares nothing with the selection is greyed out beside a
                    `1`. The row's job at that point is to say "not this one", and a number
                    only argues with it. */}
                {isDeadEnd ? null : (
                  <Badge
                    appearance="outline"
                    className="optionbadge"
                    intent="neutral"
                    size="sm"
                  >
                    {String(withThem)}
                  </Badge>
                )}
              </span>
            ),
            textValue: person.displayName,
            value: person.id,
          }),
        )}
        placeholder="Search people…"
        // EMPTY, always. Anybody ticked has become a chip and is not in `rest`, so a checkmark
        // in this panel would be marking a row that cannot exist.
        selectedValue={[]}
        trigger={
          <Button
            appearance="outline"
            aria-label={`${rest.length} more people`}
            data-testid="peoplemore"
            id="peoplemore"
            // NEUTRAL, like every other picker trigger in the app. A `Button` defaults to the
            // accent intent, which paints this as a call to action sitting in a row of quiet
            // pills.
            intent="neutral"
            onClick={panel.toggle}
            size="sm"
          >
            {`+${rest.length} more`}
            {CHEVRON_DOWN}
          </Button>
        }
      />
    </div>
  )
}

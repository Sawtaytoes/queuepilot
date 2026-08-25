import { Field, IconButton } from "@charcuterie/ui"

/** Nobody seats twenty anonymous people, and an unbounded field is a typo waiting to
 * become a player count the picker cannot satisfy. */
const MAX_GUESTS = 20

/**
 * How many anonymous seats are at the table.
 *
 * A GUEST is not a person: it gets no roster row, no id and nothing remembered. It is a
 * number, and it exists because the household's player count is not always the household —
 * three of us plus two friends is a five-player evening and only three of those five are
 * ever going to be in the people table.
 *
 * ## Why this is composed rather than a component
 *
 * `@charcuterie/ui` has no numeric stepper, and the fleet has no second consumer for one:
 * mux-magic's `NumberField` is a text field with a lookup beside it, which is a different
 * shape solving a different problem. So this is three library controls in a row — two
 * `IconButton`s and a `Field` over a native number input — rather than a new library
 * component built for one call site. The moment a second app wants `− n +`, that is the
 * evidence for a Charcuterie `NumberStepper` and this becomes its first consumer.
 *
 * The class on the wrapper is app LAYOUT — it sets the row and its gaps and paints
 * nothing — which is the one thing the "configured by props, not a borrowed class" rule
 * leaves to the app.
 *
 * ## The input is real, and typing into it works
 *
 * `− 0 +` alone is four taps to five guests. The field takes a number directly, clamps to
 * the range on change rather than letting the value leave it, and an unparseable entry
 * reads as zero — the same "snap back to something true" `CountPicker` does on blur.
 *
 * ⚠️ A native `<input type="number">` is NOT the native `<select>` the picker rule bans.
 * That rule is about the OS-painted dropdown; a number field is a text box with a spinner
 * and `Field` styles it.
 */
export function GuestStepper({
  count,
  onChange,
}: {
  count: number
  onChange: (next: number) => void
}) {
  const clamp = (next: number) =>
    Math.max(0, Math.min(MAX_GUESTS, Math.trunc(next)))

  return (
    <div className="gueststep">
      <Field
        description="Anonymous seats. A guest gets no roster row."
        id="guests"
        inputMode="numeric"
        label="Guests"
        max={MAX_GUESTS}
        min={0}
        onChange={(e) =>
          onChange(
            clamp(Number(e.currentTarget.value) || 0),
          )
        }
        type="number"
        value={String(count)}
      >
        <input />
      </Field>
      <div className="gueststepbtns">
        <IconButton
          appearance="outline"
          id="guests-down"
          intent="neutral"
          isDisabled={count <= 0}
          label="One guest fewer"
          onClick={() => onChange(clamp(count - 1))}
        >
          −
        </IconButton>
        <IconButton
          appearance="outline"
          id="guests-up"
          intent="neutral"
          isDisabled={count >= MAX_GUESTS}
          label="One guest more"
          onClick={() => onChange(clamp(count + 1))}
        >
          ＋
        </IconButton>
      </div>
    </div>
  )
}

import { Checkbox } from "@charcuterie/ui"

/**
 * A flat list of labelled checkboxes inside a `.libs` grid. Used by the set modal's
 * libraries, the channel filter panel's ratings + three library groups, and every
 * binding card's two ratings pickers.
 *
 * These were a raw `<input type="checkbox">` until now — the app's only unstyled
 * control, rendering as the browser's default box next to Charcuterie's own. The
 * blocker was real and not laziness: the library's `Checkbox` had no way to say WHICH
 * member of a group a box is, so a group could not be read back and the e2e suites'
 * `input[value="15"]` selectors had nothing to match. `@charcuterie/ui@2.18.0` added
 * `value` for exactly this, so `value` still lands on the `<input>` and every existing
 * selector keeps working.
 *
 * ### Why `seedKey`, and why the boxes are uncontrolled now
 *
 * Charcuterie's `Checkbox` is uncontrolled BY DECISION — `isChecked` seeds the first
 * paint and the `<input>` is the store from then on ("a controlled `checked` prop is
 * the thing this library refuses to have"). So a parent that changes the checked set
 * WITHOUT the user clicking has to remount the box, which is this repo's existing rule
 * for exactly this shape (`2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`).
 *
 * `seedKey` is that second writer's identity — the modal being (re-)opened, the
 * channel/profile whose ratings these are, the source block's provider. Keyed on THAT
 * and never on `checked` itself: `checked` changes on the user's own click too, so
 * keying on it would remount the box under their finger and drop keyboard focus
 * mid-list.
 */
export function CheckboxGroup<T extends string | number>({
  checked,
  id,
  onToggle,
  options,
  seedKey = "",
}: {
  id?: string
  options: { value: T; label: string }[]
  checked: T[]
  onToggle: (value: T, isChecked: boolean) => void
  /**
   * Identity of whatever re-seeds `checked` from outside the user's clicks. Changing
   * it remounts every box in the group against the new seed. Omit only when this
   * group's checked set has no writer but the user.
   */
  seedKey?: string
}) {
  return (
    <div className="libs" id={id}>
      {options.map((o) => (
        <Checkbox
          isChecked={checked.includes(o.value)}
          key={`${seedKey}:${o.value}`}
          label={o.label}
          onChange={(isChecked) =>
            onToggle(o.value, isChecked)
          }
          size="sm"
          value={String(o.value)}
        />
      ))}
    </div>
  )
}

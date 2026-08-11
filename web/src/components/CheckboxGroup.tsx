/**
 * The `checkboxGroup()` helper from the vanilla app: a flat list of labelled
 * checkboxes inside a `.libs` grid. Used by the set modal's libraries, the channel
 * filter panel's ratings + three library groups, and every binding card's two
 * ratings pickers.
 *
 * `value` is stringified on the input because that is what the e2e suites select on
 * (`#ch-movielibs input[value="15"]`, `#ch-ratings input[value="PG"]`).
 */
export function CheckboxGroup<T extends string | number>({
  checked,
  id,
  onToggle,
  options,
}: {
  id?: string
  options: { value: T; label: string }[]
  checked: T[]
  onToggle: (value: T, isChecked: boolean) => void
}) {
  return (
    <div className="libs" id={id}>
      {options.map((o) => (
        <label key={String(o.value)}>
          <input
            checked={checked.includes(o.value)}
            onChange={(e) =>
              onToggle(o.value, e.target.checked)
            }
            type="checkbox"
            value={String(o.value)}
          />
          {` ${o.label}`}
        </label>
      ))}
    </div>
  )
}

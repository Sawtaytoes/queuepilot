import type { ControlSize } from "@charcuterie/tokens"
import type { SlotProps } from "@charcuterie/ui"
import { Badge, Picker } from "@charcuterie/ui"
import type { ReactNode } from "react"

/**
 * The app's single-select picker — now a thin adapter over
 * `@charcuterie/ui`'s `Picker` rather than its own assembly of
 * `useVisibility` + `Button` + `Listbox` + a hand-rolled chevron.
 *
 * `Picker` exists because this file was one of **four** independent
 * versions of those thirty lines across the fleet (board-game-picker's
 * `SelectMenu`, mux-magic's `ListboxPicker`, and twice inside
 * `@charcuterie/ui` itself). See charcuterie's
 * `2026-08-13-picker-is-the-assembled-listbox-and-listbox-stays-trigger-agnostic`.
 *
 * Kept as a named component rather than deleted in favour of importing
 * `Picker` at all nine call sites, because two things here are this
 * app's and not the library's:
 *
 *  - **`data-value` inside every option label.** The e2e suite picks by
 *    VALUE (`[role="option"] [data-value="…"]` — see `e2e/pick.mjs`),
 *    which is what replaced `selectOption(sel, value)` when the native
 *    `<select>` went away. `textValue` keeps the plain string as the
 *    type-ahead target and the trigger's text.
 *  - **The `id` → `data-testid` swap.** The overlay clones the trigger
 *    and overwrites its `id`, so an `id` never survives; the suite's
 *    stable handle is `data-testid`. `Picker` now documents this, but
 *    the mapping from this component's `id` prop still lives here.
 *
 * One behaviour changes, deliberately: the trigger's accessible name is
 * now `"<label>: <value>"` rather than a bare `label`. The button's
 * visible text is the value, and WCAG 2.5.3 wants the visible text
 * contained in the accessible name — so the old name failed it. No test
 * targeted the old name, so nothing needed rewriting.
 */
export type SelectListboxOption = {
  /**
   * Trailing chip on the open row — "Default" on the count picker, "Watched" on
   * a start-from episode. `.optionbadge` right-aligns it. The trigger still
   * reads `label` (`textValue`); the chip is a list-row hint, not the value.
   */
  badge?: string
  badgeIntent?:
    | "accent"
    | "danger"
    | "neutral"
    | "success"
    | "warning"
  isDisabled?: boolean
  label: string
  value: string
}

/**
 * `SlotProps` is what makes this component usable inside a Charcuterie `Field`.
 *
 * `Field` CLONES onto its one child and does not wrap it, so it hands this component
 * an `id`, an `aria-describedby`, and (when required) `aria-required`/`required`. A
 * component that declares none of them drops all four in silence — React does not
 * warn, TypeScript never sees them, the render is pixel-identical, and the `Field`'s
 * `<label htmlFor>` then points at an id that is nowhere in the document. That is the
 * exact defect `slotProps.ts` was written to make impossible, so the rule it states —
 * *a slot component is a pass-through* — is honoured here: everything received is
 * forwarded to `Picker`, which spreads it onto the real `<button>`.
 */
export type SelectListboxProps = SlotProps & {
  className?: string
  id?: string
  isDisabled?: boolean
  /** What the control is FOR — the old `Select`'s `label`. */
  label: string
  onChange: (value: string) => void
  options: readonly SelectListboxOption[]
  /** When the current `value` matches nothing, the trigger reads this. */
  placeholder?: string
  size?: ControlSize
  value?: string
}

export function SelectListbox({
  className,
  id,
  isDisabled = false,
  label,
  onChange,
  options,
  placeholder,
  size = "md",
  value,
  ...slotProps
}: SelectListboxProps): ReactNode {
  return (
    <Picker
      {...slotProps}
      // Every trigger in the app carries `.qppicker`, which is what lets one rule
      // in app.css make a picker shrink and ellipsise. It has to be a class rather
      // than a Tailwind utility list here because the rule also has to reach the
      // trigger's inner `<span>` (the option label), which this file never renders —
      // `Picker` puts `options[].label` there itself.
      className={
        className ? `qppicker ${className}` : "qppicker"
      }
      data-testid={id}
      // `data-testid` stays the e2e handle, and the `id` is now ALSO rendered.
      // `useAnchoredOverlay` used to overwrite a trigger's `id` with a generated one,
      // which is why this component only ever emitted `data-testid`; `Picker` fixed
      // that (it prefers the trigger's own id and mints one only when absent) exactly
      // so a `<label htmlFor>` above a picker can name it. A `Field` around this
      // control needs that, and every call site's `id` is already unique.
      id={id}
      isDisabled={isDisabled}
      label={label}
      onChange={onChange}
      // Stop the click reaching a parent row/tile handler, exactly as
      // the native `<select>` sites did. `Picker` runs this before it
      // toggles the panel.
      onClick={(clickEvent) => {
        clickEvent.stopPropagation()
      }}
      options={options.map((option) => ({
        isDisabled: option.isDisabled,
        label: (
          <span data-value={option.value}>
            {option.label}
            {option.badge ? (
              <Badge
                appearance="outline"
                className="optionbadge"
                intent={option.badgeIntent ?? "neutral"}
                size="sm"
              >
                {option.badge}
              </Badge>
            ) : null}
          </span>
        ),
        textValue: option.badge
          ? `${option.label} ${option.badge}`
          : option.label,
        value: option.value,
      }))}
      // The old fallback chain, preserved: current → placeholder → the
      // first option's label. `Picker` only falls back to `placeholder`,
      // so the rest of the chain is folded into what it is handed.
      placeholder={placeholder ?? options[0]?.label ?? ""}
      size={size}
      value={value}
    />
  )
}

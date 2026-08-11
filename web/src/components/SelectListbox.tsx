import { useVisibility } from "@charcuterie/logic"
import type { ControlSize } from "@charcuterie/tokens"
import { Button, Listbox } from "@charcuterie/ui"
import type { ReactNode } from "react"

/**
 * The app's single-select picker. A drop-in for what used to be `@charcuterie/ui`'s
 * native `Select` here — same `{ id, label, value, onChange, options }` shape — but it
 * renders a themed `Listbox`, never an OS `<select>`.
 *
 * Why: the owner only ever accepted the native `Select` as a stopgap for the absence of a
 * `Listbox`/`Combobox`; both now exist in `@charcuterie/ui@2.x`, so every picker uses one —
 * including the ones inside modals, now that `Modal` is a Charcuterie body-portalled overlay
 * (not a top-layer `<dialog>`) and the dropdown can stack above it.
 * (decision `2026-08-07-plex-channels-pickers-are-listbox-not-native-select`)
 *
 * DOM contract kept: the `id` and any `className` land on the TRIGGER button, so e2e that
 * targeted `#chchannel` / `#addpos` still finds the control — it just clicks to open and
 * clicks a `[role="option"]` instead of `selectOption`.
 */
export type SelectListboxOption = {
  isDisabled?: boolean
  label: string
  value: string
}

export type SelectListboxProps = {
  className?: string
  id?: string
  isDisabled?: boolean
  /** The accessible name of the trigger — the old `Select`'s `label`. */
  label: string
  onChange: (value: string) => void
  options: readonly SelectListboxOption[]
  /** When the current `value` matches nothing (e.g. an empty seed), the trigger reads this. */
  placeholder?: string
  size?: ControlSize
  value?: string
}

function ChevronDown(): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      focusable={false}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
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
}: SelectListboxProps): ReactNode {
  const { hide, isVisible, toggle } = useVisibility()

  const current = options.find(
    (option) => option.value === value,
  )
  const triggerLabel =
    current?.label ?? placeholder ?? options[0]?.label ?? ""

  return (
    <Listbox
      isVisible={isVisible}
      onDismiss={hide}
      onSelect={onChange}
      // Each option's rendered label carries `data-value`, and `textValue` keeps the
      // plain string as the type-ahead + accessible name. The `data-value` is the DOM
      // handle e2e uses to pick by value (the native `<select>` it replaced was driven by
      // `selectOption(sel, value)`; now it clicks `[role=option] [data-value=…]`).
      options={options.map((option) => ({
        isDisabled: option.isDisabled,
        label: (
          <span data-value={option.value}>
            {option.label}
          </span>
        ),
        textValue: option.label,
        value: option.value,
      }))}
      selectedValue={value}
      trigger={
        <Button
          appearance="outline"
          aria-label={label}
          className={className}
          // `data-testid`, not `id`: the overlay CLONES the trigger and overwrites its
          // `id` with a generated one (to point the listbox's `aria-labelledby` at it), so
          // an `id` here never survives. `data-testid` is not a value the clone injects, so
          // it does — it is the stable e2e handle that replaces the old `<select id>`.
          data-testid={id}
          iconEnd={<ChevronDown />}
          intent="neutral"
          isDisabled={isDisabled}
          // Stop the click from reaching a parent row/tile handler, exactly as the
          // native `<select>` sites did; `toggle` opens/closes the portalled list.
          onClick={(event) => {
            event.stopPropagation()
            toggle()
          }}
          size={size}
          type="button"
        >
          {triggerLabel}
        </Button>
      }
    />
  )
}

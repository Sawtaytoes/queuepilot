import { IconButton } from "@charcuterie/ui"
import { useEffect, useRef, useState } from "react"

import {
  countPickerPresets,
  isCountPreset,
} from "../lib/countPicker"
import { SelectListbox } from "./SelectListbox"

/**
 * A small whole-number control that reads **1 / 2 / Custom…** and turns into a typed number
 * field the moment you need a third value.
 *
 * Why not a plain dropdown of 1-6, which is what episodes-per-play used to be: the counts that
 * matter are not evenly spread. Nearly every entry is 1, a few are 2, and the ones that are
 * neither are things like "queue twelve of this before switching" — a number you know and want
 * to type, not hunt for in a list that would have to be forty items long to hold it. So the
 * list carries the two common answers and Custom… hands over a spinner with the real range.
 * "All" / infinite (the rest of the series this visit) is a parked todo — do not invent
 * it as Custom 999; the field already clamps to 40. See
 * `docs/todos/batch-all-or-infinite.md`.
 *
 * `unit` is cosmetic ("x" renders 1x/2x for weights). The value is always a plain integer, and
 * an out-of-range or unparseable entry snaps back to the last good one on blur rather than
 * writing something the server would clamp behind the user's back.
 *
 * `defaultValue` is the number this control follows when the caller has not overridden it
 * (the queue's own batch, or the engine floor of 1 on the set editor). That option wears a
 * **Default** chip in the list so you can see which pick is "just use the current default"
 * rather than guessing from the selected number.
 *
 * `presets` swaps the common answers for a caller on a different scale — a channel's LINEUP
 * length counts whole items in one sitting, where 1 and 2 are not answers anyone would pick.
 *
 * `hasInfinite` adds **Infinite** to the list and lets `value` be the string `"infinite"`.
 * Opt-in, because it is meaningless for most counts: an entry's batch has no infinite form
 * (`docs/todos/batch-all-or-infinite.md` is still parked on what "all" would even mean there),
 * while a PLAYBACK LENGTH does — it is the pool that keeps going until someone stops it.
 * Spelled as its own option and never as a magic number: 0 already reads as *uncapped* deeper
 * in the engine, so a sentinel would turn a typo into a binge.
 */

const CUSTOM = "custom"
export const INFINITE = "infinite"

/** What every caller passes, whatever it counts. */
type CountPickerBase = {
  /** The option that is "follow the current default" — tagged Default in the list. */
  defaultValue?: number
  /**
   * A stable handle for the suites. Follows the control through its two faces — the listbox
   * (where `SelectListbox` renders it as `data-testid`, because the overlay overwrites an
   * `id`) and the number field Custom… swaps in. Without it a page holding two of these can
   * only be driven by DOM order.
   */
  id?: string
  label: string
  max: number
  min?: number
  /** The always-present options. Defaults to 1 / 2 — an entry batch's common answers. */
  presets?: readonly number[]
  size?: "sm" | "md"
  unit?: "" | "x"
}

/**
 * The props split on `hasInfinite` so that opting in is a TYPE-level fact, not a convention.
 *
 * Widening `onChange` to `number | "infinite"` for everyone was the first cut, and it broke
 * all four existing call sites at once: a `(n: number) => void` cannot accept a string, and
 * the compiler is right to say so — an entry batch has no infinite form to handle. This way a
 * caller that does not ask for Infinite can never be handed it.
 */
type CountPickerProps =
  | (CountPickerBase & {
      hasInfinite?: false
      onChange: (value: number) => void
      value: number
    })
  | (CountPickerBase & {
      /** Offer **Infinite** as an option, and accept `"infinite"` as the value. */
      hasInfinite: true
      onChange: (value: number | typeof INFINITE) => void
      value: number | typeof INFINITE
    })

export function CountPicker({
  defaultValue,
  hasInfinite = false,
  id,
  label,
  max,
  min = 1,
  onChange,
  presets: common,
  size = "sm",
  unit = "",
  value,
}: CountPickerProps) {
  // Inside the body the two halves are one shape; the union is what the CALLERS see, and it
  // has already done its job by the time control reaches here.
  const emit = onChange as (
    v: number | typeof INFINITE,
  ) => void
  const preset = (n: number) =>
    unit === "x" ? `${n}x` : String(n)
  const presets = countPickerPresets(defaultValue, common)
  const isInfinite = value === INFINITE
  // Infinite is a preset in its own right, so it must not fall through to the Custom… field —
  // there is no number to seed it with, and the spinner cannot express it.
  const isPreset =
    isInfinite ||
    isCountPreset(value as number, defaultValue, common)
  // `isCustom` is UI state, not derived state: picking Custom… must show the field BEFORE a
  // number exists to derive it from, and it must stay open while you type 1 on the way to 12.
  const [isCustom, setIsCustom] = useState(!isPreset)
  const [draft, setDraft] = useState(
    isInfinite
      ? String(defaultValue ?? min)
      : String(value),
  )
  const fieldRef = useRef<HTMLInputElement>(null)

  // The server owns the value: a PATCH can reject it, and a change made on another device
  // arrives over SSE. Re-sync when it moves underneath us.
  //
  // The preset list is depended on by its CONTENTS, not by its identity: a caller passing an
  // inline `[12, 24, 60]` hands a fresh array every render, and this effect resets the draft —
  // it would wipe what you are typing on every keystroke.
  const commonKey = presets.join()

  useEffect(() => {
    if (value === INFINITE) {
      setIsCustom(false)

      return
    }

    setDraft(String(value))
    if (!isCountPreset(value, defaultValue, common))
      setIsCustom(true)
    // `common` is read through `commonKey`, which is what makes the dep stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commonKey, defaultValue, value])

  const commit = (raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n < min || n > max) {
      setDraft(String(value)) // snap back — never write a value the server would clamp
      return
    }
    setDraft(String(n))
    if (n !== value) emit(n)
  }

  if (isCustom) {
    return (
      <span className="countpick">
        <input
          aria-label={label}
          className="countnum"
          id={id}
          max={max}
          min={min}
          onBlur={(e) => commit(e.target.value)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit((e.target as HTMLInputElement).value)
            }
          }}
          ref={fieldRef}
          type="number"
          value={draft}
        />
        <IconButton
          appearance="outline"
          intent="neutral"
          label={`${label} — back to the presets`}
          onClick={() => {
            setIsCustom(false)
            if (
              value !== INFINITE &&
              !isCountPreset(value, defaultValue, common)
            ) {
              emit(defaultValue ?? 1)
            }
          }}
          size="sm"
          title="Back to the presets"
        >
          {/* An inline SVG, not "▾": the app's font ships no glyph for it, so the character
              rendered as an empty box beside the number field. */}
          <svg
            aria-hidden="true"
            height="8"
            viewBox="0 0 10 6"
            width="10"
          >
            <path
              d="M1 1l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.6"
            />
          </svg>
        </IconButton>
      </span>
    )
  }

  return (
    <SelectListbox
      id={id}
      label={label}
      onChange={(v) => {
        if (v === INFINITE) {
          emit(INFINITE)

          return
        }
        if (v === CUSTOM) {
          setIsCustom(true)
          // Focus the field it just became, or picking Custom… means picking up the mouse again.
          requestAnimationFrame(() =>
            fieldRef.current?.focus(),
          )
          return
        }
        emit(parseInt(v, 10))
      }}
      options={[
        ...presets.map((n) => ({
          badge: n === defaultValue ? "Default" : undefined,
          label: preset(n),
          value: String(n),
        })),
        ...(hasInfinite
          ? [{ label: "Infinite", value: INFINITE }]
          : []),
        { label: "Custom…", value: CUSTOM },
      ]}
      size={size}
      value={String(value)}
    />
  )
}

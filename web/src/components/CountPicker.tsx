import { useEffect, useRef, useState } from "react"

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
 *
 * `unit` is cosmetic ("x" renders 1x/2x for weights). The value is always a plain integer, and
 * an out-of-range or unparseable entry snaps back to the last good one on blur rather than
 * writing something the server would clamp behind the user's back.
 */

const CUSTOM = "custom"

export function CountPicker({
  label,
  max,
  min = 1,
  onChange,
  size = "sm",
  unit = "",
  value,
}: {
  label: string
  max: number
  min?: number
  onChange: (value: number) => void
  size?: "sm" | "md"
  unit?: "" | "x"
  value: number
}) {
  const preset = (n: number) =>
    unit === "x" ? `${n}x` : String(n)
  const isPreset = value === 1 || value === 2
  // `isCustom` is UI state, not derived state: picking Custom… must show the field BEFORE a
  // number exists to derive it from, and it must stay open while you type 1 on the way to 12.
  const [isCustom, setIsCustom] = useState(!isPreset)
  const [draft, setDraft] = useState(String(value))
  const fieldRef = useRef<HTMLInputElement>(null)

  // The server owns the value: a PATCH can reject it, and a change made on another device
  // arrives over SSE. Re-sync when it moves underneath us.
  useEffect(() => {
    setDraft(String(value))
    if (value !== 1 && value !== 2) setIsCustom(true)
  }, [value])

  const commit = (raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n) || n < min || n > max) {
      setDraft(String(value)) // snap back — never write a value the server would clamp
      return
    }
    setDraft(String(n))
    if (n !== value) onChange(n)
  }

  if (isCustom) {
    return (
      <span className="countpick">
        <input
          aria-label={label}
          className="countnum"
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
        <button
          aria-label={`${label} — back to the presets`}
          className="countback"
          onClick={() => {
            setIsCustom(false)
            if (value !== 1 && value !== 2) onChange(1)
          }}
          title="Back to the presets"
          type="button"
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
        </button>
      </span>
    )
  }

  return (
    <SelectListbox
      label={label}
      onChange={(v) => {
        if (v === CUSTOM) {
          setIsCustom(true)
          // Focus the field it just became, or picking Custom… means picking up the mouse again.
          requestAnimationFrame(() =>
            fieldRef.current?.focus(),
          )
          return
        }
        onChange(parseInt(v, 10))
      }}
      options={[
        { label: preset(1), value: "1" },
        { label: preset(2), value: "2" },
        { label: "Custom…", value: CUSTOM },
      ]}
      size={size}
      value={String(value)}
    />
  )
}

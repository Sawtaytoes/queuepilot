import { useEffect, useState } from "react"

/** One Priority tile's one-based order, editable without opening a second panel. */
export function PriorityPositionInput({
  count,
  onChange,
  position,
  title,
}: {
  count: number
  onChange: (position: number) => void
  position: number
  title: string
}) {
  const [draft, setDraft] = useState(String(position))

  useEffect(() => setDraft(String(position)), [position])

  const commit = () => {
    const parsed = Number.parseInt(draft, 10)
    const next = Number.isFinite(parsed)
      ? Math.max(1, Math.min(count, parsed))
      : position

    setDraft(String(next))
    if (next !== position) onChange(next)
  }

  return (
    <input
      aria-label={`Priority position for ${title}`}
      className="priority-position"
      inputMode="numeric"
      max={count}
      min={1}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter")
          event.currentTarget.blur()
        if (event.key === "Escape") {
          setDraft(String(position))
          event.currentTarget.blur()
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      title={`Priority position ${position} of ${count}. Type a new number to move it.`}
      type="number"
      value={draft}
    />
  )
}

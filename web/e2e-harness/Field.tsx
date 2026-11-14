import { useState } from "react"
import { CountPicker } from "../src/components/CountPicker.tsx"
import { EPISODES_MAX } from "../src/components/EntrySettings.tsx"

/**
 * Isolated CountPicker page so we can screenshot the Default chip without a
 * live queue. Not in the production bundle.
 */
export const Field = ({
  defaultValue,
  hint,
  id,
  title,
  value: initial,
}: {
  defaultValue?: number
  hint: string
  id: string
  title: string
  value: number
}) => {
  const [value, setValue] = useState(initial)

  return (
    <section style={{ maxWidth: 420 }}>
      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          margin: "0 0 12px",
        }}
      >
        {title}
      </h2>
      <div className="entryfields">
        <div className="field">
          <span className="fieldlabel">
            Chapters queued per turn
          </span>
          <span data-testid={id}>
            <CountPicker
              defaultValue={defaultValue}
              label="Chapters queued per turn"
              max={EPISODES_MAX}
              onChange={setValue}
              value={value}
            />
          </span>
          <span className="fieldhint">{hint}</span>
        </div>
      </div>
    </section>
  )
}

import { useState } from "react"
import { createRoot } from "react-dom/client"

import { CountPicker } from "../src/components/CountPicker.tsx"
import { EPISODES_MAX } from "../src/components/EntrySettings.tsx"
import "../src/styles/app.css"

/**
 * Isolated CountPicker page so we can screenshot the Default chip without a
 * live queue. Not in the production bundle.
 */
const Field = ({
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

const Harness = () => (
  <main
    className="p-10"
    style={{
      display: "grid",
      gap: 48,
      gridTemplateColumns: "1fr 1fr",
      padding: 32,
    }}
  >
    <Field
      hint="How long this entry’s turn is. Used to ignore the queue default and always show 1."
      id="before"
      title="Before — set default is 2, picker still says 1"
      value={1}
    />
    <Field
      defaultValue={2}
      hint="How long this entry’s turn is when the queue reaches it. Overrides the queue’s own default."
      id="after"
      title="After — follows the set, Default chip on 2"
      value={2}
    />
  </main>
)

const container = document.getElementById("root")

if (container) {
  createRoot(container).render(<Harness />)
}

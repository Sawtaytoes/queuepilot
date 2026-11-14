import { createRoot } from "react-dom/client"

import "../src/styles/app.css"
import { Field } from "./Field.tsx"

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

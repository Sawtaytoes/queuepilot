import { useState } from "react"
import { createRoot } from "react-dom/client"

import { SelectListbox } from "../src/components/SelectListbox.tsx"
import "../src/styles/app.css"

/**
 * The smallest page that mounts a REAL `SelectListbox` so
 * `e2e/pick-contract-test.mjs` can drive it with the real
 * `e2e/pick.mjs` helpers.
 *
 * ### Why a harness rather than an app route
 *
 * Every picker in the app proper lives inside a modal that needs a
 * populated backend (a Plex library, a queue, a device registry), which
 * is exactly why the suites that exercise them are gated on
 * `PLEX_TOKEN` — and that secret is unset, so those suites skip on
 * every PR. The picker's contract with `pick.mjs` was therefore the one
 * part of this UI nothing verified. This page needs no backend, so its
 * test runs on every PR.
 *
 * ### It is not in the bundle
 *
 * `vite.config.ts` names one entry (`index.html`), so `vite build` does
 * not reach this file and `dist/` never contains it. It is only ever
 * served by `vite` in dev, on a private port, by the test.
 *
 * Keep this page dependency-free — no router, no query client, no
 * fetches. The moment it needs the app's providers to render, it stops
 * being runnable on a bare PR and the gate goes quiet again.
 */
const POSITIONS = [
  { label: "Top (plays next)", value: "top" },
  { label: "Bottom", value: "bottom" },
  // A disabled option, because `pickIndex` counts every option and a
  // disabled one must still be counted (and must not be selectable).
  { isDisabled: true, label: "Nowhere", value: "none" },
]

const Harness = () => {
  const [position, setPosition] = useState("bottom")

  return (
    <main className="p-10">
      <SelectListbox
        // The e2e handle. `id` is deliberate: the point of this gate is
        // that `SelectListbox` maps `id` onto `data-testid`, because
        // `useAnchoredOverlay` overwrites a trigger's real `id`.
        id="addpos"
        label="Add to"
        onChange={setPosition}
        options={POSITIONS}
        value={position}
      />

      {/* The test reads this to prove a pick reached `onChange`. */}
      <p data-testid="chosen">{position}</p>

      {/* A second picker with a trailing chip — CountPicker's Default tag and
          StartModal's Watched chips both ride `badge` on SelectListbox. */}
      <SelectListbox
        id="count"
        label="Chapters queued per turn"
        onChange={() => undefined}
        options={[
          { label: "1", value: "1" },
          { badge: "Default", label: "2", value: "2" },
          { label: "Custom…", value: "custom" },
        ]}
        value="2"
      />
    </main>
  )
}

const container = document.getElementById("root")

if (container) {
  createRoot(container).render(<Harness />)
}

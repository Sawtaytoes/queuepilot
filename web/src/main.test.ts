import { expect, test } from "vitest"

// Read through Vite's `?raw` rather than `node:fs`, so this file stays inside the
// browser program — the same route `firstPaintColour.test.ts` takes.
import mainSource from "./main.tsx?raw"

/**
 * The one thing no rendering test in this package can see.
 *
 * `main.tsx` mounts at module scope, so there is nothing to render and nothing to
 * assert against. Every other test builds its own `MemoryRouter` tree, which means
 * every other test would keep passing if this file dropped the adapter — and both
 * seams it carries fail SILENTLY. A missing link seam turns every `ButtonLink` press
 * into a full page load, which still shows the right screen. A missing scroll seam
 * sends Back to the top of a long queue, which still shows the right queue.
 *
 * mux-magic is the proof that this is worth a test: it renders `Shell` and `Main`,
 * and it had never wired the link seam at all.
 */
test("the router seams are wired at the root", () => {
  // Two assertions rather than one on the whole import line: the
  // formatter is free to wrap it, and a test that breaks on a
  // reformat is a test somebody deletes.
  expect(mainSource).toContain("ReactRouterAdapter")
  expect(mainSource).toContain(
    '"@charcuterie/ui/react-router"',
  )

  expect(mainSource).toContain("<ReactRouterAdapter>")
})

/**
 * Inside the router, because it reads `useLocation()`. A build where it sits outside
 * throws on the first render, but it throws in the browser rather than in CI.
 */
test("the adapter is inside the router", () => {
  const routerAt = mainSource.indexOf("<BrowserRouter>")
  const adapterAt = mainSource.indexOf(
    "<ReactRouterAdapter>",
  )

  expect(routerAt).toBeGreaterThan(-1)
  expect(adapterAt).toBeGreaterThan(routerAt)
})

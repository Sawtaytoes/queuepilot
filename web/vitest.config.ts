import { defineConfig } from "vitest/config"

/**
 * Node environment, no jsdom: these are the PURE gates — the tile-face rules the
 * recent UX decisions settled, the hash router, and the first-paint guard (which
 * reads `index.html` through Vite's `?raw`, so it needs no `node:fs` and no Node
 * types in the browser program's tsconfig).
 *
 * Component/DOM tests are deliberately out of scope for phase 1: rendering tests
 * would need a jsdom project, and phase 2 is the natural time for them, since that
 * is when `@charcuterie/ui` arrives with its own guarantees. The real coverage of
 * this UI is `e2e/` — seventeen Playwright suites that drive a live server.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    name: "web",
  },
})

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { firstPaint } from "./vite/firstPaint.ts"

/**
 * One entry: the editor is a single-page app routed on
 * `location.hash` (`#/`, `#/queues`, `#/q/<id>`, `#/channels/<id>`).
 * Hash routing is deliberate and predates this migration — it means
 * the Express server needs no SPA fallback at all, because every URL
 * the browser ever requests is `/`.
 *
 * `dist/` lands beside this file and `server/src/server.js` points
 * `PUBLIC_DIR` at it, so the server-side change is one constant.
 */
export default defineConfig({
  build: {
    assetsDir: "assets",
    // Empty on every build — a stale hashed bundle would otherwise
    // keep answering from `dist/` after a rename.
    emptyOutDir: true,
    outDir: "dist",
    // Source maps so a production stack trace in the browser console
    // points at the original TSX.
    sourcemap: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    // Sets `<html data-scheme>` + the anti-flash background from the persisted/OS
    // choice before first paint. Must precede the token stylesheet, so it is
    // injected head-prepend.
    firstPaint(),
  ],
  /**
   * `@charcuterie/ui` is not a dependency yet (M6d phase 2), but the
   * dedupe line goes in now for the reason rip-deck's `vite.config.ts`
   * documents: a `portal:`/`yarn link` of a React library is a
   * **symlink**, and both Node and Vite resolve a symlinked module
   * from its real path — so the library would render with its own
   * React while the app renders with ours, and the first shared hook
   * throws `Cannot read properties of null (reading 'useRef')` while
   * saying nothing about symlinks. Costs nothing with one copy.
   */
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    // Express owns `/api` (including the `/api/events` SSE stream and
    // the `/api/thumb` poster proxy), so `yarn dev` talks to a real
    // backend on 8768 instead of needing a mock layer.
    port: 5175,
    proxy: {
      "/api": {
        changeOrigin: true,
        target: "http://localhost:8768",
      },
    },
    strictPort: true,
  },
})

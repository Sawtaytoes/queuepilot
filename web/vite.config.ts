import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/**
 * Preload the ONE font subset the first paint actually needs.
 *
 * `@charcuterie/tokens/fonts.css` already sets `font-display: swap` on every face,
 * so nothing is invisible — but a swap is a relayout, and the `<h1>` plus every tile
 * title swapping at once was a measurable slice of the 0.398 CLS. The font is
 * referenced from inside a CSS file, which means the browser cannot discover it
 * until the stylesheet has downloaded AND parsed; a preload moves that discovery to
 * the initial HTML.
 *
 * Only `outfit-1` — the LATIN subset (`U+0000-00FF`). `outfit-0` is latin-ext and is
 * not needed to paint English UI text, and Baloo 2 / Victor Mono are headings and
 * code, neither of which is above the fold on the landing route.
 *
 * The filename is content-hashed, so it cannot be written into `index.html` by hand;
 * this reads it out of the emitted bundle instead. If the asset ever stops existing
 * (a tokens release that renames its subsets) the plugin injects nothing rather than
 * a 404 preload, and the only cost is the swap coming back.
 */
const preloadBodyFont = (): Plugin => ({
  enforce: "post",
  name: "plex-channels:preload-body-font",
  transformIndexHtml: {
    handler: (_html, ctx) => {
      const file = Object.keys(ctx.bundle ?? {})
        .find((name) => /outfit-1[-.][^/]*\.woff2$/.test(name))

      if (!file) return []

      return [{
        attrs: {
          as: "font",
          // Fonts are always CORS-fetched, even same-origin; without this the
          // preload is discarded and fetched a SECOND time by the CSS.
          crossorigin: "anonymous",
          href: `/${file}`,
          rel: "preload",
          type: "font/woff2",
        },
        injectTo: "head-prepend",
        tag: "link",
      }]
    },
    order: "post",
  },
})

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
    rollupOptions: {
      output: {
        /**
         * Two vendor chunks, for the CACHING more than the size.
         * `vendor-react` changes only when React does, so its
         * content hash survives an app deploy and the browser
         * reuses it under the one-year `immutable` header
         * `server/src/server.js` now sets on `/assets`. Before
         * this the whole app was one bundle whose hash changed on
         * every commit, so every deploy re-downloaded React too.
         */
        /**
         * The FUNCTION form, not the object form: Vite 8 bundles with
         * rolldown, and rolldown's `manualChunks` accepts only a
         * function (the object form fails the build outright with
         * "manualChunks is not a function").
         *
         * Matching on the module path rather than on a package-name
         * list, because that is all a rolldown `manualChunks` is
         * given. `/node_modules/` is checked first so an app file
         * that merely mentions "react" in its path can't be pulled
         * into a vendor chunk.
         */
        manualChunks: (id: string) => {
          if (!id.includes("/node_modules/")) return undefined

          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return "vendor-react"
          }

          if (id.includes("/node_modules/@charcuterie/")) return "vendor-ui"

          return undefined
        },
      },
    },
    /**
     * `hidden`, not `true`: the `.map` files are still EMITTED (so a
     * stack trace can be symbolicated from the build artifacts), but
     * no `//# sourceMappingURL=` comment is appended — so no browser
     * ever fetches them. The map was 1.2 MB against a 282 KB bundle
     * and was being pulled on ordinary page loads.
     *
     * The Dockerfile's `web-build` stage then deletes the maps
     * outright, so they never reach the runtime image at all.
     */
    sourcemap: "hidden",
  },
  plugins: [
    react(),
    tailwindcss(),
    // Sets `<html data-scheme>` + the anti-flash background from the persisted/OS
    // choice before first paint. Must precede the token stylesheet, so it is
    // injected head-prepend.
    firstPaint(),
    preloadBodyFont(),
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

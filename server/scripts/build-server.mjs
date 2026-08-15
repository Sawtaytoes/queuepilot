import { statSync } from "node:fs"
import { build } from "esbuild"

// Bundle the server to a single Node-runnable ESM file, so the runtime image can
// start it with plain `node` and carry no TypeScript at all — no `.ts` source, no
// tsx, no typescript, no esbuild. tsx in prod means the whole compiler stays
// resident, which on a container this small is most of its RSS.
//
// Mirrors castkit's scripts/build-server.mjs and mux-magic's `build:server-bundle`;
// keep the three in step. Run from `server/` (`npm run build`), so every path here
// is relative to that directory.

const OUTFILE = "dist/index.js"

const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  format: "esm",
  // Matches the Dockerfile's node:26-trixie-slim base. Anything the runtime
  // already understands (top-level await, `using`, native `node:sqlite`) is
  // emitted as-is instead of being downlevelled into a polyfill.
  target: "node26",
  // `hidden`-style tradeoff doesn't apply server-side: the map never crosses a
  // network, and `start:prod` runs with --enable-source-maps, so a production
  // stack trace points at the original `.ts` line even though the source is not
  // in the image. The `.map` MUST ship alongside index.js for that to work.
  sourcemap: true,
  // Several transitive deps (mqtt's decoders, undici's internals) are CJS, and a
  // CJS module inlined into an ESM bundle still calls `require`, which does not
  // exist in an ES module. This banner is the fleet's verbatim shim.
  banner: {
    js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
  },
  // Nothing. Deliberately.
  //
  // Every runtime dep here is pure JS with no native addon and no
  // resolved-at-runtime asset path: `hono`, `@hono/node-server`,
  // `@charcuterie/server`, `undici`, `yaml` and `mqtt` all bundle clean.
  //
  // `mqtt` was the one to check — it picks its transport by protocol, which reads
  // like a dynamic require. It isn't: the branch table is a static object literal
  // over `net`/`tls`/`ws`, so esbuild follows all of them, and the bundle really
  // does connect (verified against a live broker socket). `src/playback.js`'s
  // `await import('mqtt')` is likewise a literal specifier and gets inlined.
  //
  // `node:sqlite` and the other `node:` builtins need no entry — esbuild treats
  // them as external automatically on `platform: "node"`.
  //
  // If a dep ever DOES need to stay out (a native addon, or something that
  // resolves a file from `import.meta.url`), add it here AND make sure the
  // Dockerfile's production `npm ci --omit=dev` layer still installs it.
  external: [],
})

for (const warning of result.warnings) {
  console.warn(`[build] warning: ${warning.text}`)
}

const kilobytes = (statSync(OUTFILE).size / 1_024).toFixed(1)

console.log(`[build] server/${OUTFILE} — ${kilobytes} KB (+ .map)`)

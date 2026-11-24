// Offline gate: PLEX_WEB_URL, when set, is the origin of a Plex tile's webUrl.
//
// The e2e harnesses point PLEX_API_SERVER_URL at a loopback forwarder (e2e/gatehouse-plex.ts).
// A browser on another machine (a shared preview) cannot reach that address, so the harness
// sets PLEX_WEB_URL to the real web client, and the link must use it. plex-web-url-test
// covers the default, where the link uses PLEX_API_SERVER_URL.
//
// Self-contained: stubs `./playback.js` under webLinks so nothing reaches a live Plex.
// Run:  server/node_modules/.bin/tsx e2e/plex-web-origin-test.ts
import { registerHooks } from "node:module"
import assert from "node:assert/strict"
import { parentIs } from "./stubs/module-id.mjs"

const PLAYBACK_STUB = `data:text/javascript,${encodeURIComponent(
  "export async function machineIdentifier() { return 'server-mid' }",
)}`

const fromWebLinks = parentIs("/server/src/webLinks")
registerHooks({
  resolve(spec, ctx, next) {
    if (fromWebLinks(ctx) && spec === "./playback.js") {
      return { url: PLAYBACK_STUB, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

process.env.PLEX_API_SERVER_URL = "http://127.0.0.1:18799"
process.env.PLEX_WEB_URL = "https://plex-web.example.com/"
delete process.env.CONFIG_PATH

const { plexWebUrl } = await import(
  "../server/src/webLinks.js"
)

assert.equal(
  await plexWebUrl("12345"),
  "https://plex-web.example.com/web/index.html#!/server/server-mid/details?key=%2Flibrary%2Fmetadata%2F12345",
)
console.log("plex-web-origin-test: ok")

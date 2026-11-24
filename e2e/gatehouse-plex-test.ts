// e2e/gatehouse-plex.ts never passes a Plex token on, and maps the helper's answers to HTTP.
// Browserless. A fake helper stands in for gatehouse-request and logs what it was given, so
// nothing here reaches the broker or Plex.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(
  path.join(os.tmpdir(), "gatehouse-plex-"),
)
const log = path.join(dir, "calls.jsonl")
const helper = path.join(dir, "gatehouse-request")
fs.writeFileSync(
  helper,
  `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args[2].startsWith("/early")) { process.stderr.write("refused before reading\\n"); process.exit(7) }
const body = args.includes("--data") ? fs.readFileSync(0, "latin1") : null
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, body, fallback: process.env.GATEHOUSE_FALLBACK_ENV_FILE }) + "\\n")
const path = args[2]
if (path.startsWith("/missing")) { process.stderr.write("the upstream answered HTTP 404 (through Gatehouse)\\n"); process.stdout.write("<html/>"); process.exit(3) }
if (path.startsWith("/denied")) { process.stderr.write("HTTP 403: denied (rule). Do not fall back.\\n"); process.exit(4) }
if (path.startsWith("/playQueues")) { process.stderr.write("gatehouse-request: Gatehouse did not work (no_rule)\\n"); process.exit(6) }
if (path.startsWith("/held")) { process.stderr.write("HTTP 202: the request waits for the owner's approval\\n"); process.exit(5) }
process.stdout.write(path.startsWith("/thumb") ? Buffer.from([0xff, 0xd8, 0xff, 0xe0]) : '{"MediaContainer":{"size":1}}')
`,
)
fs.chmodSync(helper, 0o755)
process.env.GATEHOUSE_REQUEST = helper
process.env.PLEX_WEB_URL = "https://plex.example.com/"

const {
  startGatehousePlex,
  withoutToken,
  sniffType,
  statusOf,
} = await import("./gatehouse-plex.js")

const hasHeader = (args: string[], header: string) =>
  args.some(
    (arg) => arg.toLowerCase() === header.toLowerCase(),
  )
const calls = () =>
  fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

// The token parameter goes, in any case and any position; the rest stays byte for byte.
assert.equal(withoutToken("/library"), "/library")
assert.equal(withoutToken("/a?X-Plex-Token=t"), "/a")
assert.equal(
  withoutToken("/a?x=1&x-plex-token=t&y=a%20b"),
  "/a?x=1&y=a%20b",
)
assert.equal(
  withoutToken("/a?X%2DPlex%2DToken=t&url=%2Flibrary%2Fx"),
  "/a?url=%2Flibrary%2Fx",
)
assert.equal(
  withoutToken("/a?bad=%E0%A4%A"),
  "/a?bad=%E0%A4%A",
)

assert.equal(
  sniffType(Buffer.from(' {"a":1}')),
  "application/json",
)
assert.equal(
  sniffType(Buffer.from("<MediaContainer/>")),
  "text/xml",
)
assert.equal(
  sniffType(Buffer.from([0xff, 0xd8, 0xff])),
  "image/jpeg",
)
assert.equal(
  sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/png",
)
assert.equal(
  sniffType(Buffer.from("plain")),
  "application/octet-stream",
)

assert.equal(statusOf(0, ""), 200)
assert.equal(
  statusOf(
    3,
    "the upstream answered HTTP 404 (through Gatehouse)",
  ),
  404,
)
assert.equal(statusOf(3, "no status"), 502)
assert.equal(statusOf(4, ""), 403)
assert.equal(statusOf(5, ""), 502)
assert.equal(
  statusOf(6, "Gatehouse did not work (no_rule)"),
  403,
)
assert.equal(statusOf(6, "unreachable"), 502)
assert.equal(statusOf(null, ""), 502)

const server = await startGatehousePlex(0)
const address = server.address()
assert.ok(address && typeof address === "object")
const base = `http://127.0.0.1:${address.port}`

try {
  const read = await fetch(
    `${base}/library/sections?X-Plex-Token=leak&x=1`,
    {
      headers: {
        Accept: "application/json",
        "X-Plex-Token": "leak",
        "X-Plex-Client-Identifier": "harness",
        Cookie: "session=leak",
      },
    },
  )
  assert.equal(read.status, 200)
  assert.equal(
    read.headers.get("content-type"),
    "application/json",
  )
  assert.deepEqual(await read.json(), {
    MediaContainer: { size: 1 },
  })

  const write = await fetch(`${base}/:/scrobble?key=1`, {
    method: "PUT",
    body: "",
  })
  assert.equal(write.status, 200)
  const posted = await fetch(
    `${base}/playlists?type=video`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    },
  )
  assert.equal(posted.status, 200)

  const head = await fetch(`${base}/identity`, {
    method: "HEAD",
  })
  assert.equal(head.status, 200)

  const image = await fetch(`${base}/thumb/1`)
  assert.equal(
    image.headers.get("content-type"),
    "image/jpeg",
  )

  assert.equal((await fetch(`${base}/missing`)).status, 404)
  const denied = await fetch(`${base}/denied`)
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).exitCode, 4)
  assert.equal((await fetch(`${base}/held`)).status, 502)

  // A web-client link redirects to PLEX_WEB_URL and never reaches the helper.
  const link = await fetch(
    `${base}/web/index.html?X-Plex-Token=leak`,
    { redirect: "manual" },
  )
  assert.equal(link.status, 302)
  assert.equal(
    link.headers.get("location"),
    "https://plex.example.com/web/index.html",
  )

  // The query is not part of the /web match, and the token never reaches Location.
  const linkWithQuery = await fetch(
    `${base}/web?x=1&X-Plex-Token=leak`,
    { redirect: "manual" },
  )
  assert.equal(linkWithQuery.status, 302)
  assert.equal(
    linkWithQuery.headers.get("location"),
    "https://plex.example.com/web?x=1",
  )

  // No broker rule for play queues: a refusal, reported as 403.
  assert.equal(
    (await fetch(`${base}/playQueues/1`)).status,
    403,
  )

  // A helper that exits without reading a large body must not crash the forwarder.
  const early = await fetch(`${base}/early`, {
    method: "PUT",
    body: Buffer.alloc(4 * 1024 * 1024, 120),
  })
  assert.equal(early.status, 502)
  assert.equal(
    (await fetch(`${base}/library/sections`)).status,
    200,
  )

  const [first, scrobble, playlist, headCall] = calls()
  assert.deepEqual(first.args.slice(0, 3), [
    "plex",
    "GET",
    "/library/sections?x=1",
  ])
  assert.ok(
    hasHeader(first.args, "Accept: application/json"),
  )
  assert.ok(
    hasHeader(
      first.args,
      "X-Plex-Client-Identifier: harness",
    ),
  )
  assert.equal(first.body, null)
  assert.deepEqual(scrobble.args.slice(0, 3), [
    "plex",
    "PUT",
    "/:/scrobble?key=1",
  ])
  assert.deepEqual(scrobble.args.slice(-2), ["--data", "-"])
  assert.equal(scrobble.body, "")
  assert.ok(
    hasHeader(
      playlist.args,
      "Content-Type: application/json",
    ),
  )
  assert.equal(playlist.body, '{"a":1}')
  assert.equal(headCall.args[1], "GET")
  for (const call of calls()) {
    assert.equal(call.fallback, "/dev/null")
    const text = JSON.stringify(call)
    assert.ok(
      !text.includes("leak"),
      "a token or cookie was passed on",
    )
    assert.ok(
      !text.toLowerCase().includes("x-plex-token"),
      "a token name was passed on",
    )
  }
  console.log("gatehouse-plex-test: ok")
} finally {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

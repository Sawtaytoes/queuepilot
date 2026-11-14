// §B.3 Node mirror test — the completed-entry TTL sweep in server/src/queues.js.
//
// session.js runs the sweep on every scan; this pins the rule it runs — what a done entry's
// done_at means: parseDuration parses the window, entryDoneAt reads the stamp, and
// sweepCompleted removes ONLY past-TTL done entries, honours the never/0 disable, and exempts
// keep_completed / reel sets. Imports the real module against a temp QUEUES_PATH.
//
// Run standalone: server/node_modules/.bin/tsx e2e/ttl-sweep-test.ts   (non-zero on failure)
import {
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"

const QUEUES_PATH = "/tmp/ttl-queues.yaml"
const STORE_PATH = "/tmp/ttl-queuepilot.sqlite"
process.env.QUEUES_PATH = QUEUES_PATH
process.env.STORE_PATH = STORE_PATH
for (const filePath of [
  STORE_PATH,
  `${STORE_PATH}-shm`,
  `${STORE_PATH}-wal`,
])
  rmSync(filePath, { force: true })

let failures = 0
const ok = (
  name: string,
  isPassing: boolean,
  extra = "",
) => {
  console.log(
    `${isPassing ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`,
  )
  if (!isPassing) failures += 1
}

const read = () => readFileSync(QUEUES_PATH, "utf8")

// Fixed clock (epoch seconds) so the fixtures are deterministic.
const NOW = 1_000_000_000
const OLD = NOW - 100_000 // ~27.7h ago: past a 24h TTL
const RECENT = NOW - 60 // a minute ago: within 24h
const FIXTURE = `bob:
  - {title: "Old Done", done: true, done_at: ${OLD}}
  - {title: "Recent Done", done: true, done_at: ${RECENT}}
  - {title: "Legacy Done", done: true}
  - "Active Movie"
`

function seed() {
  for (const filePath of [
    QUEUES_PATH,
    `${QUEUES_PATH}.lock`,
    `${QUEUES_PATH}.tmp`,
  ]) {
    rmSync(filePath, { force: true, recursive: true })
  }
  writeFileSync(QUEUES_PATH, FIXTURE)
}

const queues = await import("../server/src/queues.js")
const promote = await import("../server/src/promote.js")

// --- parseDuration mirrors the Python parser --------------------------------- //
ok(
  "parseDuration 24h -> 86400",
  queues.parseDuration("24h") === 86400,
)
ok(
  "parseDuration 7d -> 604800",
  queues.parseDuration("7d") === 604800,
)
ok(
  "parseDuration 90m -> 5400",
  queues.parseDuration("90m") === 5400,
)
ok(
  "parseDuration bare number -> seconds",
  queues.parseDuration("45") === 45,
)
ok(
  "parseDuration 0 -> disabled",
  queues.parseDuration("0") === null,
)
ok(
  "parseDuration never -> disabled",
  queues.parseDuration("never") === null,
)
ok(
  "parseDuration blank -> disabled",
  queues.parseDuration("") === null,
)
ok(
  "parseDuration junk -> disabled",
  queues.parseDuration("soon") === null,
)

// --- entryDoneAt reads the stamp --------------------------------------------- //
ok(
  "entryDoneAt reads a numeric stamp",
  queues.entryDoneAt({ done: true, done_at: OLD }) === OLD,
)
ok(
  "entryDoneAt of a stampless done entry -> null",
  queues.entryDoneAt({ done: true }) === null,
)
ok(
  "entryDoneAt of a scalar entry -> null",
  queues.entryDoneAt("Active Movie") === null,
)

const keys = async (): Promise<string[]> =>
  (await queues.listSet("bob")).map((entry) => entry.key)

// --- default is keep-forever (opt-in) ---------------------------------------- //
seed()
let res = await queues.sweepCompleted("bob", { now: NOW }) // no override -> default 'never'
ok(
  "default (no override) keeps everything — no sweep",
  res.removed === 0,
  `removed=${res.removed}`,
)
ok(
  "default: past-TTL done entry survives",
  (await keys()).includes("title:Old Done"),
)

// --- opt-in window removes ONLY past-TTL done entries ------------------------ //
seed()
await promote.recordLead("bob", "title:Old Done")
res = await queues.sweepCompleted("bob", {
  removeCompletedAfter: "24h",
  now: NOW,
})
ok(
  "opt-in removed exactly one entry",
  res.removed === 1,
  `removed=${res.removed}`,
)
let ks = await keys()
ok(
  "opt-in removed the past-TTL done entry",
  !ks.includes("title:Old Done"),
)
ok(
  "opt-in cleared the removed entry's lead cooldown",
  (await promote.lastLedAt("bob", "title:Old Done")) ===
    null,
)
ok(
  "opt-in kept the recent done entry",
  ks.includes("title:Recent Done"),
)
ok(
  "opt-in kept the timestamp-less done entry",
  ks.includes("title:Legacy Done"),
)
ok(
  "opt-in kept the active (not-done) entry",
  ks.includes("title:Active Movie"),
)

// --- never / 0 disables ------------------------------------------------------ //
seed()
res = await queues.sweepCompleted("bob", {
  removeCompletedAfter: "never",
  now: NOW,
})
ok("never disables the sweep", res.removed === 0)
ok(
  "never: past-TTL done entry survives",
  (await keys()).includes("title:Old Done"),
)

seed()
res = await queues.sweepCompleted("bob", {
  removeCompletedAfter: "0",
  now: NOW,
})
ok("0 disables the sweep", res.removed === 0)
ok(
  "0: past-TTL done entry survives",
  (await keys()).includes("title:Old Done"),
)

// --- keep_completed / reel exempt the set (even with a window set) ------------ //
seed()
res = await queues.sweepCompleted("bob", {
  isKeepingCompleted: true,
  removeCompletedAfter: "24h",
  now: NOW,
})
ok("keepCompleted exempts the set", res.removed === 0)
ok(
  "keepCompleted: past-TTL done entry survives",
  (await keys()).includes("title:Old Done"),
)

seed()
res = await queues.sweepCompleted("bob", {
  isReel: true,
  removeCompletedAfter: "24h",
  now: NOW,
})
ok("reel exempts the set", res.removed === 0)
ok(
  "reel: past-TTL done entry survives",
  (await keys()).includes("title:Old Done"),
)

// --- per-set override tightens the window ------------------------------------ //
seed()
res = await queues.sweepCompleted("bob", {
  removeCompletedAfter: "30s",
  now: NOW,
})
ks = await keys()
ok(
  "tight window sweeps the recent done entry too",
  res.removed === 2 &&
    !ks.includes("title:Recent Done") &&
    ks.includes("title:Active Movie"),
)

// A still-populated list must stay a block list (not collapse to flow `[ ... ]`) after a sweep.
ok(
  "kept entries stay a block list",
  /bob:\n- /.test(read()) && !/bob:\s*\[/.test(read()),
)

rmSync(QUEUES_PATH, { force: true })
rmSync(`${QUEUES_PATH}.lock`, {
  force: true,
  recursive: true,
})
for (const filePath of [
  STORE_PATH,
  `${STORE_PATH}-shm`,
  `${STORE_PATH}-wal`,
])
  rmSync(filePath, { force: true })

console.log(
  failures
    ? `\n${failures} sweep assertion(s) failed`
    : "\nall TTL sweep assertions passed",
)
process.exit(failures ? 1 : 0)

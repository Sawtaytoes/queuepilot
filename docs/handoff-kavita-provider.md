# Handoff — build the Kavita provider

**Written 2026-08-13, after the queuepilot rename shipped.** Everything below the "ground truth"
section is design that already exists and is merged; the *code* does not exist at all.

## Ground truth — verified 2026-08-13, not assumed

Nothing Kavita-related is built. Checked on `main`:

- `grep -ril kavita` over `server/`, `web/src`, `e2e/`, `cast_sidecar/` → **zero hits.** Every
  mention of Kavita in this repo is in `docs/`.
- There is **no `server/src/providers/` directory.** The provider seam is a design, not a file.
- The live TrueNAS app's env has **no Kavita variables** — 15 vars, all Plex/MQTT/Shield.
- The queue-editor's "Libraries this queue can search & hold" list is the **Plex** library list
  fetched from the Plex API. Kavita libraries do not appear there because no code fetches them.

So: the owner cannot add a Kavita queue today, and no partial implementation is waiting to be
finished. This is a greenfield build against a merged design.

## The design of record — read these four, in this order

1. [`docs/kavita-feasibility.md`](kavita-feasibility.md) — **read first.** Every endpoint in it
   was actually called against the live instance, read-only. §2 is the endpoint table, §3 is how
   the reader deep link works, §4 is the one real gap, §7 is the library inventory with ids.
2. [`decisions/2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md`](decisions/2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md)
   — the architecture. The `materialize` / `handoff` split is the load-bearing part.
3. [`decisions/2026-08-12-provider-tokens-live-in-a-separate-config-file.md`](decisions/2026-08-12-provider-tokens-live-in-a-separate-config-file.md)
   — where the Kavita base URL and token go, and why they can't be env-only like `PLEX_TOKEN`.
4. [`decisions/2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md`](decisions/2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)
   — the queue data model these providers serve.

Plus [`docs/queuepilot-ui-design.md`](queuepilot-ui-design.md) for the 302 launcher route and the
reading-side UI.

**These are Accepted decisions. Do not relitigate them** — if you believe one is wrong, supersede
it with a new dated ADR and cross-link both directions (`docs/decisions/README.md` is the index).

## Corrections to the design docs — apply these, they are known-stale

Found while writing this handoff, by checking each cited anchor against the tree:

- **`applyBatch` does not exist.** The provider ADR cites "`applyBatch`
  (`server/src/engine/resolve.js:413`)". There is no `applyBatch` symbol anywhere in `server/`
  or `e2e/`, and `resolve.js` contains no `batch` string at all. What *does* exist is
  `batch_stops_at`, parsed in `server/src/engine/routing.js:146-147` and handled in `sets.js`,
  `queues.js` and `server.js`. `QUEUE_SERIES_LENGTH` is real (`server/src/env.js:72`, default
  40). Re-derive the batch story from those before building on it.
- **`buildRotation` is real and correctly cited** — `server/src/engine/rotation.js:76`, declared
  `export async function`. The ADR's claim that it is backend-neutral holds: it round-robins over
  bucket objects and never touches Plex.
- The ADR's description of the current seam is accurate: `server/src/engine/plex-live.js:12,17`
  really does expose exactly `container(path, token)` and `accountToken(uuid)`, mirrored by
  `plex-replay.js`.

## What to build

From feasibility §8, in dependency order:

1. **Connector config** — Kavita base URL + token, per the provider-tokens ADR. The token file is
   the only file allowed to hold a credential, mode `0600`, created by the app, never in the
   image, excluded from the YAML-editing machinery, never logged or returned by an API. A new
   credential file joins those rules **in the same change that introduces it**.
2. **Widen the seam.** Today the engine takes a `client` with `container`/`accountToken` — that
   is Plex's wire format as an interface. Widen at the same injection point to
   `buckets(set, profile)` / `progressState(profile)` / `materialize(items)` / `handoff(artifact)`.
   Port the existing Plex client onto the new shape first and keep every gate green — that
   proves the seam before Kavita exists.
3. **The Kavita provider** — `buckets` from `Reader/continue-point`, `progressState` from
   `ReadingList/items`, `materialize` into a Reading List, `handoff` returning the deep link.
4. **The 302 launcher route**, one stable URL per queue.

`sections` and `ratingKey` are the two genuinely Plex-shaped fields in the YAML schemas and need
a provider-scoped equivalent (a Kavita library id, a Kavita series id). Everything else in
`sets.yaml` / `queues.yaml` is reusable as-is.

### 5. The provider selector in the queue editor — owner requirement, 2026-08-13

The queue editor's **"Libraries this queue can search & hold"** block currently lists the Plex
libraries with no indication that Plex is where they came from, because Plex was the only
possible answer. Once Kavita exists it needs a **provider selector above that list**:

**The repeatable-block shape is the owner's current thinking, and it landed after two revisions —
take the final one.** He first said a `Listbox` for provider, then corrected to "Combobox with
multiselect", then arrived at the real model and explicitly withdrew the control question:

> "So I think this whole section needs to be able to be added multiple times. I might be wrong on
> the list/combobox thing"

So the unit that repeats is **the whole block** — "Plays under profile" *plus* "Libraries this
queue can search & hold" — not a picker inside it. A queue holds **N of these blocks**, and each
block is one `{ provider, profile, libraries }` group. Mixing then falls out of composition
rather than out of a multi-select control: each block stays homogeneous, and the queue is the sum.

- **The control type is UNRESOLVED and is not yours to just pick.** He withdrew the
  Listbox/Combobox call himself. This is a "make this look better" task, which has a house
  procedure: **mock it up in HTML, serve it over `devshare`, let him choose, and only then
  build** — [`docs/runbooks/ui-design-previews.md`](../../agentic/docs/runbooks/ui-design-previews.md)
  and [`2026-07-25-preview-ui-changes-as-served-html`](../../agentic/docs/decisions/2026-07-25-preview-ui-changes-as-served-html.md)
  in the workspace root repo. Mock at least: one block vs three, how a block is added and removed,
  and what the provider control looks like when there is only one provider installed. Whatever
  wins, it is not a native `<select>`
  ([`2026-08-07-plex-channels-pickers-are-listbox-not-native-select`](decisions/2026-08-07-plex-channels-pickers-are-listbox-not-native-select.md))
  and it comes from Charcuterie
  ([`2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens`](decisions/2026-07-31-frontend-is-react-typescript-vite-tailwind-on-charcuterie-tokens.md)).

- **The profile field is provider-scoped, and today's copy is Plex-only.** The current help text
  says "Locks this queue to a Plex Home profile — a scan waits (and switches the Shield) until
  that profile is signed in before it plays." None of that is true for Kavita: there is no Shield
  to switch and no scan to wait on, and the equivalent concept is *which Kavita user owns the
  reading list* (feasibility §6 — build lists as **his** user, not admin). So the label, the help
  text and the option list all have to come **from the provider**, not be hardcoded in the modal.
  Check the existing profile ADRs before touching this — there are four, and they are load-bearing
  for the NFC cards:
  [`2026-07-25-sets-can-require-a-plex-profile`](decisions/2026-07-25-sets-can-require-a-plex-profile.md),
  [`2026-07-26-cards-name-a-profile-and-the-scan-waits-for-it`](decisions/2026-07-26-cards-name-a-profile-and-the-scan-waits-for-it.md),
  [`2026-08-07-choose-profile-for-queues`](decisions/2026-08-07-choose-profile-for-queues.md),
  [`2026-08-07-default-profile-per-channel`](decisions/2026-08-07-default-profile-per-channel.md).

- **Storage is a list of blocks from day one.** Never a scalar provider, never provider identity
  encoded into library ids or smuggled into `sections`. Getting this wrong turns the multi-block
  case into a migration instead of an additive change.

**The consequence you must not build blind.** N blocks means one queue can span Plex *and* Kavita,
and that is a change to the seam rather than a UI affordance: `buckets()` runs per block and the
results merge before `buildRotation` interleaves them, and `materialize`/`handoff` stop having one
answer — a mixed queue has a playQueue *and* a reading list, a push target and a pull URL at once.
He said on 2026-08-13 that mixing is "something to look into in the future" while the UI should
already support repeating the block.

So: **build the UI and the storage for N blocks, get the single-block path working end to end
first, and take the mixed-queue semantics — above all what `handoff` returns — back to him as its
own decision before implementing it.** That question is genuinely open and is not yours to assume.

This is a visible UI change, so it needs before/after screenshots on the PR — see the working
conventions below.

### The gap you cannot design around

**Kavita has no cast and no webhooks.** `Device/send-to` is Send-to-Kindle *email*. So reading is
**pull**, not push: `handoff` returns a URL the owner opens, and progress is **polled, not
subscribed** (feasibility §4, §188). Do not try to make reading behave like the Shield push path
— the `materialize`/`handoff` split exists precisely so it doesn't have to.

Build reading lists **as the owner's user, not admin** (feasibility §6).

## Traps carried over from the rename — read before you touch MQTT or config

- **The MQTT rename bridge is still ON.** `MQTT_LEGACY_PREFIX=plex-channels` means the app
  publishes and subscribes on both `queuepilot/…` and `plex-channels/…`. Do not clear it as part
  of Kavita work; it has its own cutover procedure in
  [`docs/queuepilot-mqtt-cutover.md`](queuepilot-mqtt-cutover.md), gated on a real NFC card scan
  passing first.
- **`PLEX_CLIENT_IDENTIFIER` keeps the value `plex-channels-helper` permanently.** The plex.tv
  managed-user token exchange is keyed on it. It is not a leftover.
- **`env.js` is the single source of runtime knobs.** During the rename, `mqttc.js` was found
  re-declaring four topic defaults from `process.env` with its own copies — it would have
  silently stayed on the old prefix. Read knobs from `env.js`; do not reach into `process.env`.
  A Kavita provider must not repeat this.
- **The CI workflow must keep `name: CI`** — `docker-deploy.yml` triggers on
  `workflows: ["CI"]`, so renaming it leaves CI green while nothing builds.

## Gates — all of these must stay green

Run from the repo root after `npm ci --prefix server` and `npm ci --prefix web`:

```sh
for f in $(find server/src -name '*.js'); do node --check "$f"; done
npm --prefix web run lint:biome && npm --prefix web run typecheck && npm --prefix web test && npm --prefix web run build
node e2e/collection-start-test.mjs && node e2e/keep-completed-test.mjs && node e2e/resume-in-queue-test.mjs \
  && node e2e/resume-in-progress-done-test.mjs && node e2e/playback-fsm-test.mjs && node e2e/fsm-wake-and-skip-test.mjs \
  && node e2e/session-profile-gate-test.mjs && node e2e/profile-gate-test.mjs && node e2e/mqtt-legacy-bridge-test.mjs \
  && node e2e/device-registry-test.mjs
node e2e/binding-parity.mjs && node e2e/set-passthrough-parity.mjs && node e2e/engine-parity.mjs \
  && node e2e/curated-parity.mjs && node e2e/batch-stops-at-test.mjs && node e2e/live-client-adapter-test.mjs \
  && node e2e/mark-done-parity.mjs && node e2e/adb-unit-test.mjs
node e2e/history-persist-test.mjs && node e2e/api-v2-test.mjs && node e2e/sse-resync-test.mjs \
  && node e2e/ttl-sweep-test.mjs && node e2e/specials-count-test.mjs && node e2e/leaves-revalidate-test.mjs \
  && node e2e/leaves-per-account-test.mjs && node e2e/collection-batch-cap-test.mjs && node e2e/resume-on-advance-test.mjs
```

The **parity gates are contracts**, not smoke tests: they diff the Node engine against the
retired Python engine's recorded answers over a committed synthetic corpus. Widening the seam
must not move them. If a parity gate fails, the seam changed behaviour — that is the gate doing
its job, not a fixture to update.

Add offline tests for the Kavita provider in the house style — plain `.mjs`,
`node:assert/strict`, no framework, stubbed HTTP so they run with no token and no network. See
`e2e/device-registry-test.mjs` and `e2e/mqtt-legacy-bridge-test.mjs` as the recent models. Wire
new tests into `.github/workflows/ci.yml` in the offline block with a comment explaining what
they guard.

## Working conventions

- Work in your own `git worktree`, not the shared checkout — concurrent agents share these repos.
- Commit small and often; never leave the tree dirty.
- The repo is `Sawtaytoes/queuepilot` on public GitHub. Squash-merge with a `(#N)` suffix.
- **Any change with a visible result gets before/after screenshots attached to the PR itself**,
  committed into the PR branch under `docs/images/` and linked with SHA-pinned
  `raw.githubusercontent.com` URLs. A `devshare` link dies with the session and is not enough for
  a PR.
- Display name is **`QueuePilot`**; `queuepilot` lowercase stays correct for slugs, package names,
  image names, topic prefixes and filenames.

## Live environment

| Thing | Value |
| --- | --- |
| App | TrueNAS app `queuepilot`, container `ix-queuepilot-queuepilot-1` |
| Image | `ghcr.io/sawtaytoes/queuepilot:latest` |
| Config | `/mnt/TrueNAS-Apps/App-Configs/queuepilot` → `/config` in-container |
| URL | `https://queuepilot.example.com` (old `plex-channels.example.com` 301s to it) |
| Kavita | `KAVITA_API_SERVER_URL` = `https://kavita.example.com`, key `KAVITA_API_KEY` — both in the **root `.env`** (gitignored). Verified present 2026-08-13. Auth is the API-key → JWT exchange in feasibility §1; library ids in §7. |

Redeploy after merge: `ssh root@nas.example.com 'midclt call app.redeploy queuepilot'`. Note that
a GHCR push is **not** a redeploy.

# `plex-channels` becomes **queuepilot**

- **Status:** Accepted
- **Date:** 2026-08-12
- **Type:** naming / product
- **Supersedes:** —
- **Superseded by:** —

## Decision

The app is renamed **`plex-channels` → `queuepilot`**.

- **`queue`** is the direct keyword, and literally the data model — a queue is the object the
  whole app manipulates
  ([mode-knobs ADR](2026-08-12-queues-have-orthogonal-mode-knobs-not-named-types.md)).
- **`pilot`** carries the playful half twice over: **autopilot**, for the hands-off result, and
  a **pilot**, which is a first episode.

**Availability, verified 2026-08-12:** free on **npm** (`registry.npmjs.org/queuepilot` → 404),
free on **PyPI** (→ 404), and free at both `github.com/Sawtaytoes/queuepilot` and
`github.com/sawtaytoes/queuepilot` (→ 404). Note that the *hyphenated* `queue-pilot` **is**
taken on npm — if a package is ever published, publish the unhyphenated form and do not treat
the two as interchangeable.

**Not renamed:** the repo directory on disk, and no code. This ADR is the decision and the
checklist; executing it is separate work.

## Why rename at all

The name became actively misleading on two independent axes:

1. **It is no longer Plex-only.** Kavita is verified feasible and is the next backend
   ([feasibility record](../kavita-feasibility.md)); Jellyfin, Emby and Kodi are all wanted. The
   architecture now has an explicit provider seam
   ([provider ADR](2026-08-12-backends-are-providers-behind-a-media-neutral-seam.md)), so
   "plex-" in the name contradicts the design.
2. **"channel" collides with a real feature in the exact backends being integrated.** Plex,
   Jellyfin and Emby all ship **Live TV** with channels. An internal "channel" that means
   something different from the host app's "channel" is a permanent source of confusion — and
   the concept it named has itself been replaced by orthogonal knobs.

## Rejected candidates — recorded so this isn't relitigated

| Candidate | Why not |
| --- | --- |
| **`tuner`** | Means **HDHomeRun OTA capture hardware** in Plex, Jellyfin *and* Emby. That is a collision *inside* the exact backends being integrated — the same trap as `channel`, one layer down. |
| **`rabbit-ears`** | Clean and evocative, but [rabbitears.info](https://rabbitears.info) owns the term in the antenna community, and pure-TV imagery reads oddly for a Webtoon queue. |
| **`cue-stack`** | A real lighting-console term, but it reads as DAW/theatre tooling to everyone else, and cue-for-queue is a stretch that has to be explained every time. |
| **omakase / chef's-choice** | Semantically the closest — "I leave it up to you" — but effectively **DHH-branded** (Rails is omakase, Omakub, Omacom). More importantly it is **inaccurate**: nobody else is choosing. See below. |
| **anything anchored on `list`** | Kavita says "Reading List", Plex says "Playlist". Building on `list` collides with **both** backends at once — the same trap as `channel` and `tuner`. |

### The omakase rejection is the product statement

Worth keeping because it is the sentence that keeps the product honest:

> **You pre-choose in bulk. The app orders what you already approved, and remembers where you
> left off. It is not a recommender — nothing is choosing *for* you.**

Omakase means "I leave it up to you" — someone else decides. That is the opposite of what
happens here: every item in a queue was put there by the owner. The app removes the *nightly*
decision, not the *choosing*. Any name from the omakase family would promise taste-making the
app deliberately does not do.

## Rename checklist

Verified against `main` at `621534d` and the live deployment on 2026-08-12. **Several of these
are load-bearing for the NFC cards — a missed one silently breaks every card.**

**Execution status (2026-08-12):** everything in code and on GitHub is done. What remains is
live infrastructure and Home Assistant — the three unchecked boxes below. The MQTT prefix is
checked off because the *code* has moved, but it moved behind a **reversible bridge** that keeps
the old topics alive: the app publishes and subscribes on both prefixes until
`MQTT_LEGACY_PREFIX` is cleared, so nothing outside the container had to change on the same
deploy. The ordered procedure, the verification command after each step and the rollback are in
[`docs/queuepilot-mqtt-cutover.md`](../queuepilot-mqtt-cutover.md).

Two traps found during execution that this checklist did not predict:

- **`server/src/mqttc.js` never used `env.js`.** It re-declared four topic knobs from
  `process.env` with its own copies of the defaults — the exact drift `env.js` exists to
  prevent. It would have stayed on the old prefix while `mqttd` moved, taking the web UI's
  device dropdown and state feed quiet with nothing logged. Now imports from `env.js`.
- **The GHCR package does not follow the repo rename.** Renaming the GitHub repo leaves the
  `plex-channels` *package* in place, and the first push to `…/queuepilot` creates a **new
  package that defaults to private** — while the old one is public. The TrueNAS app cannot pull
  a private package, so the new one must be flipped to public before the app is repointed.

### Load-bearing at runtime (get these wrong and the cards stop working)

- [x] **MQTT topic prefix `plex-channels/…`** — the highest-risk item. Ten topics, all
      env-overridable, in `server/src/env.js:195-218`: `T_CMD_START`, `T_CMD_ADVANCE`,
      `T_CMD_SOUNDTRACK`, `T_CMD_PREVIEW`, `T_RESP_PREVIEW_BASE`, `T_RESP_LAST_PLAYED`,
      `T_RESP_SOUNDTRACK`, `T_STATE`, `T_NOW_PLAYING`, `T_DEVICES_BASE`.
      **Requires dual-publish or a coordinated HA change** — the env overrides make a staged
      cutover possible without a code change, which is the safe route.
- [x] **⚠️ `T_CMD_CAST_PLAY` is HARDCODED on the publisher side.**
      `server/src/playback.js:41` declares `'plex-channels/cmd/cast/play'` as a `const`, while
      the subscriber (`cast_sidecar/service.py:18`) reads it from env with the same default.
      So the two halves **can be re-pointed independently and silently diverge** — the sidecar
      would sit on a topic nobody publishes to. Fix the hardcode *before* touching topics.
      Its reply topic `plex-channels/resp/cast` (`cast_sidecar/service.py:19`) is env-driven.
- [x] **HA MQTT-discovery entity.** `DISCOVERY_OBJECT_ID` defaults to `plex_channels_status`
      (`server/src/env.js:212`), which is what creates **`sensor.plex_channels_status`**
      (`server/src/mqttd.js:101-105`). Renaming it **changes the HA entity_id** and breaks every
      automation that references the sensor. The device block also carries
      `identifiers: ['plex_channels']` and `manufacturer: 'plex-channels'`
      (`mqttd.js:116,118`). Decide deliberately whether the entity is renamed at all — keeping
      the old `object_id` is a legitimate choice.
- [ ] **HA consumers.** Confirmed to reference the topics: `script.control_plex`,
      `automation.plex_nfc_scanner`, `automation.plex_session_bookkeeping`,
      `automation.plex_channels_status_announcements`, `automation.plex_channels_now_playing`.
      **Two further YAML-defined automations could not be scanned** via the REST config endpoint
      (404) — check those by hand before cutting over, do not assume they are clean.
      Note `server/src/driver.js:33` warns that its strings are **read aloud verbatim** by
      `automation.plex_channels_status_announcements`.
- [x] **⚠️ Do NOT rename `PLEX_CLIENT_IDENTIFIER`.** It defaults to `plex-channels-helper`
      (`server/src/config.js:15`, `.env.example:7`) and must stay stable — it is the client id
      the managed-user token exchange against plex.tv is keyed on, and changing it makes that
      exchange non-repeatable. This is a case where the old name is *correct* forever.
- [x] **Plex-facing identity strings.** `X-Plex-Device-Name` and `X-Plex-Product` are both
      `'plex-channels'` (`server/src/playback.js:571-572`). These are what appear in Plex's
      device list and activity. Cosmetic, but user-visible inside Plex.

### Infrastructure

- [x] **GitHub repo** `Sawtaytoes/plex-channels` → `queuepilot`. GitHub redirects the old path,
      so clones and links keep working; the git remote should still be updated deliberately.
- [x] **GHCR image** `ghcr.io/sawtaytoes/plex-channels` → `…/queuepilot`
      (`.github/workflows/docker-deploy.yml:71-73`, three tags: sha, branch, `latest`).
- [x] **⚠️ The CI workflow must keep the name `"CI"`.** `docker-deploy.yml:21` triggers on
      `workflow_run: workflows: ["CI"]`, matching `ci.yml:14`'s `name: CI`. Renaming the
      workflow silently stops all image builds — CI stays green while nothing deploys.
- [ ] **TrueNAS app** `plex-channels` (custom app, stable train, currently RUNNING) and its
      **`/config` dataset** `App-Configs/plex-channels` — which holds the live `sets.yaml`,
      `queues.yaml`, `config.yaml`, `cache.sqlite` and eight `.bak-*` files. A dataset rename is
      a data move; plan it with the app stopped.
- [ ] **NPM proxy host** `plex-channels.example.com` (live, 200) → `queuepilot.example.com`
      (does not resolve yet). Per the
      apps-get-product-name-subdomains decision (`agentic/docs/decisions/2026-07-16-apps-get-product-name-subdomains.md`)
      the subdomain follows the product name, so this one is required, not optional. Keep the
      old host redirecting.
- [x] Legacy `.gitea/workflows/ci.yml` still exists alongside the GitHub workflows.
- [x] `build.sh:6,11` (image name + the redeploy instruction) and `.env.example:1,30,32`.

### Code and docs (cosmetic, but do them in one pass)

- [x] `web/package.json` `name: "plex-channels-web"` + description; `web/vite.config.ts:27` and
      `web/vite/firstPaint.ts:39` plugin names.
- [x] `server/src/server.js:1-2,872` (`[plex-channels-web]` log prefix),
      `server/src/mqttd.js:138` (`clientId: plex-channels-node-…`),
      `cast_sidecar/service.py:94` (`client_id="plex-channels-cast-sidecar"`),
      `server/src/adb.js:64` (`/sdcard/plex-channels-ui.xml`).
- [x] `Dockerfile:2,55`, `entrypoint.sh:5,7,12`.
- [x] `README.md` — done as part of this work; see the "Why *queuepilot*?" section there.
- [x] **The private companion `agentic/plex-channels-private/`** — note this is a *tracked
      subdirectory of the `agentic` root repo*, not a separate git repo, so renaming it is a
      directory move plus the references in `docs/ROADMAP.md` and the workspace `todo/README.md`.
      Its `publish/sanitize-spec.md` also maps `plex-channels.example.com` and needs updating.

### Sequencing

Rename in this order, verifying between steps: **infrastructure that redirects** (GitHub, NPM
host) → **image + CI** → **TrueNAS app + dataset** → **MQTT topics with dual-publish** → **HA
consumers** → **cosmetic strings**. The MQTT step is the only one that can break the cards, and
it is the only one with a safe staged path (env overrides on both halves), so it should not be
bundled with anything else.

## Evidence

- Owner chose `queuepilot` and gave the reasoning for both halves of the name, plus the
  rejections above (2026-08-12 session).
- Availability checks run 2026-08-12 (npm, PyPI, both GitHub paths).
- Every checklist location read from `main` at `621534d`; HA consumers enumerated via the live
  Home Assistant config search; app/dataset state from the live TrueNAS instance.

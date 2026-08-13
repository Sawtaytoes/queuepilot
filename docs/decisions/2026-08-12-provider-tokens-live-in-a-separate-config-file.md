# Provider definitions go in plaintext config; provider TOKENS go in a separate `/config` file

- **Status:** Accepted
- **Date:** 2026-08-12
- **Type:** architecture / security
- **Supersedes:** —
- **Superseded by:** —

## Decision

The App Connectors surface (connect Kavita, later Jellyfin/Emby/Kodi — see the
[UI design](../queuepilot-ui-design.md)) splits its configuration in two:

1. **Provider *definitions* — plaintext**, in a normal YAML file on `/config` alongside
   `sets.yaml` / `queues.yaml`: `id`, `label`, `kind` (`plex` | `kavita` | …), `base_url`, and
   which queues draw from it. These are editable in the web UI, diffable, backup-able, and
   carry no credential.
2. **Provider *tokens* — a separate file**, `/config/providers.secrets.yaml`, holding nothing
   but `id → token`. Never in the image, never in git, never rendered back to the browser after
   it is set (write-only in the UI: you can replace a token, not read it).

**Resolution order per provider token, extending the app's existing rule:**

```
env  >  /config/providers.secrets.yaml  >  unset (the provider is reported NOT CONFIGURED)
```

An **unset token must fail loudly** — the provider reports unconfigured and its queues refuse to
launch with a named error. It must never silently fall through to an empty string, an
unauthenticated request, or a placeholder.

### Rules that come with the secrets file

- **It is the only file allowed to hold a credential**, and it holds nothing else. No base URLs,
  no labels — those are in the plaintext definitions file. That separation is what lets the
  definitions be backed up, diffed and screenshotted freely.
- **Mode `0600`**, created by the app, never shipped in the image.
- **Excluded from the YAML-editing machinery**: it must not be written through the
  `setKeepingComment` / undo-history path (`HISTORY_PATH`, the `.history.json` mirror) and must
  not get `.bak-*` sidecars the way `sets.yaml` and `queues.yaml` do
  (`/config` currently holds eight such backups). A credential that gets copied into an undo
  stack or a dated backup has escaped its file.
- **Never logged**, never included in a support bundle, never echoed in an API response.
- **A new credential file joins these rules in the same change that introduces it** — the
  discipline from the encryption decision, applied to whatever this app adds next.

## Context — why not `SECRET_PATHS`

The draft design said provider tokens should be "a separate file added to `SECRET_PATHS`",
citing `agentic/docs/decisions/2026-07-16-secrets-only-encryption-plaintext-config.md` in the
workspace root repo. **That mechanism does not exist for this app, and cannot be borrowed.**
Checked on 2026-08-12:

- `SECRET_PATHS` is defined in exactly one place — `agent-sandbox-base/entrypoint.sh:56` — as
  the **agent sandbox container's** credential allowlist (`ssh`, `gh`, `gitconfig`,
  `claude/.credentials.json`, `codex/auth.json`, `t3/userdata/secrets`), decrypted at boot into
  a tmpfs.
- This app is a **TrueNAS custom app**, not an agent sandbox. It has no such entrypoint, no
  `secrets.tar.enc`, and no tmpfs indirection. Its `/config`
  (`App-Configs/plex-channels/`) is a plain persistent mount.

So the *mechanism* does not transfer. What transfers is the **principle**, and it is worth
stating because it is the reason this design is a separate file rather than a field in
`sets.yaml`:

> Encrypt/isolate only **barely-changing credentials**; churny bulk state stays plaintext, and
> a churny file must never join the credential set.

Provider tokens are the textbook barely-changing case: set once when you connect an app,
touched again only if it is revoked. Queue state, progress, and caches are the churny case and
stay exactly where they are.

### The pattern this follows already exists here

The app already draws the line in the right place, and this decision just extends it to a
second credential:

- **Secrets come from env only.** `PLEX_TOKEN` is `process.env.PLEX_TOKEN ||
  process.env.PLEX_API_KEY` (`server/src/config.js:11`) — deliberately **not** read from
  `/config/config.yaml`.
- **Host/deploy values** (real Shield IP, LAN Plex URL, client names — private but not secret)
  resolve `env > /config/config.yaml > placeholder` via `hostval`
  (`server/src/hostConfig.js:27`), so real hostnames stay out of the public image.

### Why tokens can't be env-only like `PLEX_TOKEN`

Because the connector UI lets you **add a provider at runtime**, and a container cannot write
its own environment. `PLEX_TOKEN` is env-only because Plex is configured once at deploy time by
the person who deploys it; a connector added from the couch has nowhere to put its token but a
file the app can write.

Env still **wins** where it is set, so the deploy-time path is unchanged and an operator can
always override a UI-set token without touching the file.

## Why

- **Two prior production outages came from exactly this seam**, and both looked identical from
  the couch — the NFC card opened Plex and nothing played. Written up in the private companion
  repo as `agentic/plex-channels-private/docs/`
  `2026-08-06-sanitized-placeholder-ips-broke-profile-gated-cards.md` (sanitized placeholder
  values reached production) and `2026-08-10-node-engine-ignored-config-yaml-so-cards-stalled.md`
  (the Node half reproduced the placeholder defaults but not the YAML layer, so every host value
  fell back to the non-routable placeholder and ADB dialled `192.0.2.30`). `hostConfig.js`
  carries that second incident in its header comment as a warning to the next reader.

  The lesson both incidents teach is the "fail loudly" rule above. A placeholder that *looks*
  like config is worse than no config, because it produces a working-looking app that quietly
  talks to nothing. **A missing provider token must be an error, not a default.**
- **Definitions and tokens have opposite handling requirements.** Definitions want to be
  visible — diffed, screenshotted in a PR, restored from backup. Tokens want to be invisible.
  One file cannot be both, and mixing them means the *whole* file inherits the token's
  handling rules, which is how config stops being reviewable.
- **It keeps the plaintext half genuinely plaintext.** Everything that makes the connector
  surface reviewable — which queue uses which provider, what base URL it points at — stays in a
  file anyone can read and any agent can safely paste into a PR.

## Scope

**Design only. No connector code, no file, and no schema ships with this ADR.** In particular
the exact key names, the definitions file's name, and the UI's write-only token control are
specified in the [UI design](../queuepilot-ui-design.md) as a proposal, not built.

## Evidence

- `SECRET_PATHS` located at `agent-sandbox-base/entrypoint.sh:56` and nowhere else in the fleet
  (`rg -uu` across `/mnt/TrueNAS-Apps/Repos`, 2026-08-12); the only other hits are
  `EXTRA_SECRET_PATHS` in `t3code-container/Dockerfile:111`.
- Existing resolution rules read from `main` at `621534d`: `server/src/config.js:11`,
  `server/src/hostConfig.js:12,27`; live `/config` inventory from
  `App-Configs/plex-channels/`.
- The two incident write-ups above, both in the private companion repo.

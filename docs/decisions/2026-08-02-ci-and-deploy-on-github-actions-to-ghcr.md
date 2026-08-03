# CI runs on GitHub Actions and the image is built-on-push to GHCR

- **Status:** Accepted — **production cutover DONE 2026-08-02** (see "Cutover")
- **Date:** 2026-08-02
- **Type:** infrastructure / CI-CD
- **Supersedes:** the manual `build.sh` → `docker-registry.example.com/plex-channels:latest`
  build path for the automated build (the LAN registry stays reachable, but is no longer
  the build-on-push target)
- **Superseded by:** —

## Decision

1. **CI** runs on **GitHub Actions** (`.github/workflows/ci.yml`) — a faithful 1:1 port of
   the retired Forgejo workflow `.gitea/workflows/ci.yml`, same steps and same action-major
   pins. The workflow keeps the name **`CI`** so the deploy workflow can key on it.
2. **Build-on-push** is wired as a second workflow, `.github/workflows/docker-deploy.yml`,
   mirroring the **mux-magic** pattern: a `workflow_run` trigger fires after `CI` concludes,
   and on success builds the app image and pushes it to
   **`ghcr.io/sawtaytoes/plex-channels`** (`:<sha>`, `:<branch>`, and `:latest` on `main`).
   The Dockerfile builds the React `web/` in its own stage, so there are no host-side Node
   build steps (unlike mux-magic).

## Context

plex-channels was open-sourced to public GitHub (`Sawtaytoes/plex-channels`) on 2026-08-02
and the Forgejo repo was deleted. The only workflow that shipped was `.gitea/workflows/ci.yml`
(Forgejo Actions), which **does not run on GitHub Actions** — so after the move there was no
CI at all, and no build-on-push, and the merged React+Tailwind+Vite frontend (M6d) had never
been built into a deployed image. The running container (image dated 2026-07-31) still served
the pre-M6d **vanilla** frontend (`/style.css` + hand-written HTML), not the hashed Vite
bundles the merged code produces.

## Why

- **A GitHub repo can't use the old build path.** The sibling build-on-push repos split two
  ways: mux-magic builds via **GitHub Actions → GHCR**, while gallery-downloader and the old
  plex-channels build via **Forgejo Actions → the LAN registry `docker-registry.example.com`**.
  A GitHub-hosted runner cannot reach the private LAN registry, and Forgejo is gone — so the
  Forgejo→LAN-registry path is no longer available to this repo. GHCR via GitHub Actions
  (the mux-magic model) is the only viable build-on-push path for a GitHub repo. This is a
  forced choice, not a novel mechanism.
- **Faithful port, not a rewrite.** The CI steps are unchanged from the proven Forgejo file,
  so the gates the repo already trusted still run.
- **No new redeploy mechanism.** The fleet's existing chain still applies once the app points
  at a registry that receives pushes: registry gets a new digest → TrueNAS detects it →
  HA `automation.truenas_app_updates` publishes `truenas/update/trigger` → the `truenas-mqtt`
  runner calls `app.pull_images redeploy:true` (`pull_policy: always`). Nothing here home-rolls
  a redeploy.

## Evidence

- Ported CI ran green on the first push (`CI` run 30781626539's parent, 28s).
- `Docker Deploy` (`workflow_run` after CI) built and pushed the image to GHCR (52s).
- Local build of `web/` produced hashed Vite bundles (`dist/assets/index-*.js` +
  `index-*.css`); the node server serving that `dist/` returns those bundles, and the running
  UI is the charcuterie three-column layout (screenshot in `__screenshots__/`), while the live
  `plex-channels.example.com` still returns the vanilla `/style.css` markup.

## Cutover (owner-approved, done 2026-08-02)

The owner approved the live cutover; both steps were executed and verified live:

1. **GHCR package is public.** Anonymous pull of `ghcr.io/sawtaytoes/plex-channels:latest`
   returns HTTP 200 with the real manifest (verified via the anon `ghcr.io/token` flow; a
   private/absent package returns 403 by contrast). Matches mux-magic's public-package
   precedent, so the TrueNAS app pulls uncredentialed with no `imagePullSecret`.
   *(Correction to the first draft of this record: an earlier "package is private / 401"
   claim was a flawed test — it omitted the `Authorization: Bearer <anon-token>` header that
   even public GHCR requires after the token exchange. The corrected test shows public.)*
2. **App image repointed.** `midclt call -j app.update plex-channels` set
   `image.repository` `docker-registry.example.com/plex-channels` →
   `ghcr.io/sawtaytoes/plex-channels` (tag `latest`, `pull_policy: always`). The app pulled
   the GHCR image and redeployed: state `RUNNING`, active container
   `ghcr.io/sawtaytoes/plex-channels:latest`, **0 restarts**, both processes healthy (web on
   :8768, MQTT connected rc=Success, discovery published).

**Live evidence:** `plex-channels.example.com` now serves the hashed Vite bundles
(`/assets/index-*.js` + `/assets/index-*.css`, `<div id="root">`, `data-scheme="dark"`); the
old vanilla `/style.css` + hand-written markup is gone. Full three-column React/Tailwind UI
renders with real Plex data (screenshot: `__screenshots__/live-cutover-ghcr-new-build.png`).

The old LAN registry `docker-registry.example.com/plex-channels` is now unused for this app;
`build.sh` (the manual path) is superseded by the GitHub Actions → GHCR build.

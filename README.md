# plex-channels

Helper service for the kids' **NFC / Unfolded Circle 3** Plex experiences on the
Family Room theater. Home Assistant owns the cards/buttons and the theater activity;
this service owns the Plex *brains* it can't do in templates — and talks to HA **only
over MQTT** (no REST/shell bridges).

Two kid experiences, both **profile-driven** since 2026-07-16 (the card carries only the
KIND; the Shield's signed-in Plex Home profile - Younger Kids / Older Kids - decides the
tier, detected from the PMS debug log):

1. **Rewatch Movie** — a kid-rated movie that profile has watched before, weighted
   `1/n²` toward the least-watched (seen-exactly-once movies dominate; a first watch is
   impossible, so the kids never see a movie for the first time without the user).
2. **"Saturday Morning Cartoons"** — the *next unwatched* episode across a rotating
   pool of kid shows (+ a bucket of classic shorts), **switching show after each
   episode** like old-TV, auto-advancing.

## How it decides

- **Watched state is PER-PROFILE** and comes from Plex play *history*
  (`/status/sessions/history/all?accountID=`) for the set's own account only — the
  cross-account union was tried and reverted (someone else's viewing drove the kids'
  cards), and `viewCount` on the library reflects only the admin account and is useless.
- **Kid-appropriateness** comes from each set's **own account view** (the Younger Kids
  token sees the G-tier library; the Older Kids token sees the TV-PG library), with a
  per-set `movie_ratings` cap applied on top (younger = G-tier; older = PG tier only, i.e.
  PG/TV-PG, disjoint from younger). The managed-user token works
  locally via the **server-scoped access token** (switch → `/resources` → this server's
  accessToken); playback attribution follows the Shield's signed-in profile (client mode),
  never the owner. A contentRating allow-list is still applied as the ceiling.
- **Rotation** round-robins each show's ordered unwatched episodes across shows, so a
  binge still advances that show across rounds and no two consecutive items share a show.

## Layout

| File | Role |
| --- | --- |
| `queue_builder/config.py` | env + the extensible `SETS` dict (younger/older, ratings, accounts) |
| `web/` | React + TypeScript + Vite web editor for the curated movie/anime queues (Tailwind on `@charcuterie/ui`) |
| `docs/why-queues-not-plex-playlists.md` | 💬 RATIONALE: why "queues" are a watched-state-aware recipe, not native Plex Playlists |
| `queue_builder/plex.py` | read-only Plex queries + selection (rotation, rewatch movie) |
| `queue_builder/playback.py` | drive the Shield's Plex app directly via its Companion endpoint (`client` mode, resolved from plex.tv); retired `cast` path kept but undeployed |
| `queue_builder/profiles.py` | detect the Shield's signed-in profile from the PMS debug log (`set=auto`) |
| `queue_builder/soundtrack.py` | MA → YouTube-Music → Ollama soundtrack resolver (Living-Room card) |
| `queue_builder/service.py` | MQTT entrypoint (the runtime) |
| `queue_builder/cli.py` | **dry-run** CLI for offline verification (no playback, no MQTT) |

## Dry-run (Phase 1, read-only)

```sh
export PLEX_API_SERVER_URL=https://plex.example.com PLEX_TOKEN=<token>
python3 -m queue_builder.cli rotation younger     # the interleaved queue
python3 -m queue_builder.cli movie                # a rewatch-movie pick (set arg optional)
python3 -m queue_builder.cli shows younger        # buckets + unwatched counts
python3 -m queue_builder.cli watched-count        # movie combined-view histogram
```

Deploy this as a container (see `Dockerfile` / `build.sh`) with the env from
`.env.example`, and wire MQTT to your broker. Keep secrets in the app env, never in the
tree.

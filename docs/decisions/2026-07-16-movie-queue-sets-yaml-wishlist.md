# Movie-queue sets are a hand-edited YAML wishlist, pruned on finish, played as Bob

- **Status:** Accepted
- **Date:** 2026-07-16
- **Type:** feature / architecture
- **Supersedes:** —
- **Superseded by (in part):** [finished-queue-entries-marked-done-not-pruned](2026-07-21-finished-queue-entries-marked-done-not-pruned.md)
  — reverses **point 3** ("finished movies are pruned from the file") and the "prune over
  derived-skip" rationale: finished entries are now kept + tagged `done`, removed only on an explicit
  "remove all completed". The rest of this decision (YAML wishlist store, resume, Bob-only accounts,
  no rating cap, people-names) stands.
- **Extended by:** [anime-queues-retire-ondeck-set](2026-07-16-anime-queues-retire-ondeck-set.md)
  (same machinery, three more queues against the Anime section) ·
  [config-web-app-embedded-in-plex-channels](2026-07-16-config-web-app-embedded-in-plex-channels.md)
  (a web UI becomes the intended way in; YAML stays the store, so this decision stands)

## Decision

Three new sets in `plexchannels/config.py` - `bob`, `bob_alice`, `family` - back three
NFC cards (`Plex: Bob Movies`, `Plex: Bob & Alice Movies`, `Plex: Bob & Kids Movies`).
They introduce a new `kind: queue` and differ from every existing set: the lineup is **manually
curated**, not selected by rule.

1. **Source = a hand-edited YAML wishlist.** The sets carry `source: "queue"`. Order in the file
   is play order, top first. This is the first set whose contents Bob writes rather than the
   service computing (kid sets = whole-library rotation; anime = On Deck).
2. **The file lives at `/srv/app-configs/plex-channels/queues.yaml`**, mounted
   read-write to `/config/queues.yaml`, re-read on every scan. Not baked into the image, and not
   in the git repo. It follows the existing `App-Configs/<service>/` convention and is reachable
   from Windows at `\\nas.example.com\App-Configs\plex-channels\queues.yaml`.
3. **Finished movies are pruned from the file by the service.** On each scan it re-reads, drops
   entries Bob has finished, and atomically rewrites, so the file always shows only what's left.
4. **Partially-watched movies resume.** Unfinished means still queued; the entry leaves only once
   Plex marks it watched.
5. **All three run as Bob (admin).** `user_uuid: None` → the admin `PLEX_TOKEN`;
   `watch_count_accounts: [1]` so only Bob's own history prunes his queues.
6. **No content-rating cap.** `allowed_ratings: None` on all three, including `family` -
   manual curation replaces the filter.

## Context

The kid cards and the anime card both pick *for* you, from rules. Bob wanted the opposite: a
plain wishlist of specific films, split by who he plans to watch them with, that he tops up as he
hears about movies and that cleans itself up as he watches them.

## Why

- **YAML in App-Configs** is the only option that satisfies "easily add" - the image bakes
  `config.py`, so a Python-dict queue means a rebuild + redeploy per movie. App-Configs is already
  the house mount convention *and* already SMB-shared, so it needs no new share, dataset, or
  workflow.
- **Prune over derived-skip** was chosen deliberately: the file is the UI, so it should read as
  the actual remaining list rather than an ever-growing log. The usual objection to write-back
  (git churn, fighting a working copy) does not apply because the file is outside git.
- **Resume** matches Plex's own On Deck behavior and how the `anime` set already feels, and
  avoids silently burning a half-watched film.
- **Bob-only watch accounts** keeps the queues personal. The global union would let Alice
  finishing a film on her account delete it from Bob's list before he ever saw it.
- **Named after people** because the audience *is* the distinction, and "Plex: Kids Movies" would
  collide with the existing `Plex: Younger/Older Kid Movies` cards.

## Why not (rejected alternatives)

- **Derived skip (never write the file)** - simpler and race-free, but the wishlist would grow
  forever and no longer show what's actually left. Rejected by the user in favor of a file that
  self-cleans.
- **Queue in the git repo, mounted** - would version the wishlist, but couples the running app to
  a working copy and makes every finished movie a git diff.
- **Audience-noun names (`Solo` / `Couple` / `Family`)** - closer to the existing
  `Younger`/`Older` scheme, but the user chose explicit people names.
- **Rating-filtered `family`** - unnecessary; a hand-picked list is already appropriate by
  construction.

## Known risks to handle at build time

- `movie_view_counts()` uses the **global** `WATCH_COUNT_ACCOUNTS`, and `_watched_for_set()` only
  walks `episodic_sections` (never movies). Neither honors per-set accounts *for movies* - a new
  lookup is required or point 5 silently fails.
- The prune rewrite must use **`ruamel.yaml` round-trip**; PyYAML's `safe_dump` would strip the
  file's comments and ordering.
- Prune can race a hand-edit. Mitigate with re-read-before-write + `os.replace()`.
- Resume depends on the cast path accepting a start offset; `PlayQueue.create` +
  `block_until_playing` currently pass none. Verify before promising resume.

## Evidence

- User: "I wanna document a new set of Plex cards for movies I wanna queue up to watch by myself,
  my wife, and with my kids. 3 NFC cards. These are all for the Bob account. I essentially want
  a way to wishlist these movies such that when I scan the card, it'll play the next one in queue
  and remove finished movies. And I can easily add to this queue via YAML or something in the
  Plex-Channels config." (chat 2026-07-16)
- User chose, when asked: cards named after people; prune the YAML rather than derive; a dedicated
  app-config path rather than the repo; resume partially-watched. (chat 2026-07-16)

# The third provider kind is named `board-game-picker`, not `board-games`

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** provider seam / naming
- **Supersedes:** the *name* chosen in
  [`board-games` is a third provider kind, configured by URL](2026-08-16-board-games-is-a-third-provider-kind.md)
  — everything else in that record stands unchanged
- **Superseded by:** —
- **Related:**
  [A queue wears its provider's colour](2026-08-15-a-queue-wears-its-providers-colour.md),
  fleet: [The Board Game Picker repo is named for the product too](https://mkdocs.example.com/workspace/agentic/docs/decisions/2026-08-17-board-game-picker-repo-name-matches-the-product/)

## Decision

The provider **kind** and the implicit provider **id** are both `board-game-picker`.
Everything derived from them moves with them:

| Surface | Before | After |
| --- | --- | --- |
| `KINDS`, `DELIVERY`, `VOCABULARY`, `ENV_TOKEN_KEYS`, `KINDS_CONFIGURED_BY_URL` | `board-games` | `board-game-picker` |
| implicit definition `{id, kind}` | `board-games` | `board-game-picker` |
| `BoardGamesArtifact.kind` | `'board-games'` | `'board-game-picker'` |
| accent selector | `[data-provider="board-games"]` | `[data-provider="board-game-picker"]` |
| provider modules | `providers/board-games{,-client}.ts` | `providers/board-game-picker{,-client}.ts` |
| harness | `e2e/board-games-provider-test.ts` | `e2e/board-game-picker-provider-test.ts` |

The env names were **already** `BOARD_GAME_PICKER_URL` / `BOARD_GAME_PICKER_API_TOKEN`, and
the label was already `Board Game Picker`. The kind was the one surface still carrying the
old name.

**No alias, no read-side fallback for `board-games`.** See Why.

## Context

The picker app was renamed end to end on 2026-08-17 — repo, Yarn scope, env vars, SQLite
filename and App-Configs directory. This kind was the last `board-games` in the fleet.

The kind is not purely internal: it is a **wire value**. It is written into `queues.yaml`
as a set's `provider:`, into `sets.yaml`'s `provider_kind`, and into a runtime artifact's
`kind` — so a rename with saved data behind it would be a data migration, and a
one-directional one at that.

There is no saved data behind it. `App-Configs/queuepilot/` was grepped before the change:
`queues.yaml`, `sets.yaml`, `config.yaml`, `profile-order.json`, `.history.json` and
`cache.sqlite` contain **zero** occurrences of `board-games`. The kind shipped 2026-08-16
and no board-game queue was ever created — the owner has not started using the picker yet.

> "Yes, you can do that migration. I'm not even using the app yet." (owner, 2026-08-17)

## Why

- **One product, one name.** A queue's `provider:` line is hand-edited over SMB. Reading
  `provider: board-games` in a file whose only backend is called Board Game Picker is the
  same split the fleet rename exists to remove.
- **A compatibility alias would be worse than the rename.** An accepted-on-read
  `board-games` would have to be accepted forever — a wire value has no deprecation
  window once something writes it — and it would let a half-migrated config keep working
  silently, which is the failure mode the strictness in `config.ts`'s header was bought to
  prevent. With zero saved occurrences, the alias would guard nothing that exists.
- **The unknown-kind path already covers the theoretical case.** A definition naming a kind
  this build does not know is *kept* rather than dropped and reports unsupported, with
  Plex's vocabulary as the fallback. So the worst case for a hand-written
  `provider: board-games` is a visible unsupported provider, not a silent
  misinterpretation.

## Evidence

Owner, 2026-08-17, on the list of four things the earlier rename deliberately left —
including this kind, flagged at the time as "a wire value inside already-saved queues":

> "Yes, you can do that migration. I'm not even using the app yet. I mean, I might, but
> I'm not actively using it."

Verified before the change:

```sh
grep -rl "board-games" /mnt/TrueNAS-Apps/App-Configs/queuepilot/   # no output
```

Verified after: `server`/`web` typecheck, `web` biome (no new diagnostics), and all
seventeen assertions of `e2e/board-game-picker-provider-test.ts` — including the two that
pin the implicit definition and `isConfigured('board-game-picker', 'board-game-picker')`.

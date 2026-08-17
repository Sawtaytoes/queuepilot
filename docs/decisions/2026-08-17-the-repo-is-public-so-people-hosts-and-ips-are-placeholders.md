# This repo is public, so people, hosts and IPs are always placeholders

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** privacy / naming convention
- **Supersedes:** —
- **Superseded by:** —

> This record deliberately does **not** repeat the names, hostnames or addresses it exists to
> remove — writing them here would republish them. The real ↔ placeholder mapping lives in
> `queuepilot-private`.

## Decision

`Sawtaytoes/queuepilot` is a **public** GitHub repository. Nothing committed here — code,
comments, decision records, fixtures, test labels, commit messages, PR bodies or
**screenshots** — may contain a real household name, a real hostname, or a real LAN address.

The placeholder sets are fixed. Use these and only these:

| Kind | Placeholder | Never |
| --- | --- | --- |
| The owner / admin account | **Bob** (`bob`), display name `Bob Smith` | the owner's real first or full name |
| The owner's partner | **Alice** (`alice`) | her real name |
| Third person / a child | **Carol** (`carol`) | a child's real name |
| Fourth, fifth | **Dave**, **Erin** | real names |
| Set ids | `bob`, `bob_alice`, `bob_anime`, `bob_alice_anime`, `bob_kids`, `carol_1`, … | `<realname>_anime` etc. |
| Hosts | `example.com` subdomains — `plex.example.com`, `kavita.example.com`, `queuepilot.example.com` | the household's real domain |
| The NAS host | `nas.example.com` (bare: `nas`) | the real host name |
| IPs | **RFC 5737** documentation ranges — `192.0.2.x` | any real `10.x` / `192.168.x` LAN address |

Plex profile labels that are already generic (`Younger Kids`, `Older Kids`, `Family`) are
fine as-is — they name a tier, not a person.

**This is not a new convention.** `server/src/sets.ts` and `server/src/plex.ts` have used
`bob` / `bob_alice` / "admin (Bob)" since the first commit. Real names appearing in this
repo were always a **regression against** the convention, never a gap in it.

## Context

On 2026-08-17 the owner asked whether the household's real first names had been committed
here in place of the Bob/Alice placeholders, and whether the repo was leaking PII. It was.

A binary-safe scan of every blob in history found, in round numbers: the owner's first name
**~396 times**, his partner's **~103**, one child's **~63**, the family surname **~23**, two
further given names **10** between them, the household domain **~136**, the NAS hostname
**~28**, plus live LAN addresses. All of it present from the **root commit** onward, so there
was no clean window to cut from.

Worse, **158 committed screenshots** under `docs/images/` were captures of the live app and
rendered those names as **pixels** — including one queue shot, named for a child in its very
filename, showing **that child's name over that child's actual viewing history**. Text
filtering cannot touch a pixel, and a byte substitution that *did* match inside a PNG would
corrupt the deflate stream rather than redact it.

The whole history was therefore rewritten with `git filter-repo`, `docs/images/` was
**dropped from every commit**, and main was force-pushed. Recovery instructions and the full
blast radius live in the workspace-root decision record of the same date.

## Why

- **A public repo is a publication.** The owner's own name is already tied to the
  `Sawtaytoes` account, but his partner's and his children's names are not, and they never
  consented to appear. A child's name beside what that child watches was the single worst
  item the repo carried.
- **Placeholders were already the house style**, so following them costs nothing and keeps
  fixtures internally consistent. `Bob & Alice — Movies` documents the exact same shape as
  the real label without naming anyone.
- **RFC 5737 and `example.com` are reserved for documentation**, so a placeholder can never
  collide with a real host. This matches the posture the 2026-08-06 sanitised-IP incident
  established: committed defaults are placeholders and the **deploy** supplies real values
  (`env > config.yaml > placeholder`). Verified during this scrub — every host/IP occurrence
  in this repo's source is inside a **comment**, and `.env.example` is a template, so nothing
  sanitised here is a runtime fallback.
- **Prose is not the risky part — pictures are.** A reviewer notices a name in a diff; nobody
  re-reads a merged PR's screenshots.

## How to apply

- Adding a fixture, a test label, a decision record or a doc? Use the table above.
- Adding a **screenshot**? Capture it against the stub/fixture stack (the `e2e/shot-*.ts`
  scripts run a stub Plex + the real server + a browser, fully offline), **never** against the
  live server. Open the PNG and look at it before committing — headers, shelf labels and left
  rails leak. Real film/series titles and poster art are fine; only people, hosts and
  addresses are faked.
- Real host values, tokens and IPs belong in the **private** deploy config and
  `queuepilot-private`, never here.

## Evidence

- Owner, 2026-08-17, on the screenshots: *"Drop from history, then re-capture current ones
  with fake data. You can use actual thumbnails for real ones though."*
- Pre-existing convention, `server/src/sets.ts`: `- id: bob` / `label: Bob — Movies`,
  `- id: bob_alice` / `label: Bob & Alice — Movies`.
- Verified after the rewrite from a **fresh clone of GitHub**: 1601 blobs scanned
  binary-safe → **zero** hits for any of the removed name/host terms and **zero** LAN IPs.
- Full CI path re-run on the rewritten tree before pushing: 92 web tests, server + e2e
  typechecks, both builds, 9/11 engine tests (the other 2 time out on unmodified `main` too —
  they need live network). One Biome **format** diff appeared because the placeholders are
  shorter than the real names and re-wrapped a test file; fixed in the same push.
- The before/after pair embedded in the sibling record
  `2026-08-16-completed-is-judged-when-playback-ends…` was **regenerated** from
  `e2e/shot-completed-badge.ts` against its offline stub, so that record keeps working
  images. Screenshot paths named in **older** records point at files that no longer exist —
  the accepted cost of the scrub, not rot to repair.

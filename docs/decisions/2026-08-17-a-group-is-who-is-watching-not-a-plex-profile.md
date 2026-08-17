# A Group is "who is watching", it lives in the path, and explicit membership beats derived

- **Status:** Accepted
- **Date:** 2026-08-17
- **Type:** Architecture / data model / UX
- **Supersedes:** —
- **Superseded by:** —
- **Settles part of:** [Profiles, Groups and navigation — the design conversation](../queuepilot-profiles-groups-and-navigation-design.md)
  (§2 identity model, §3 routing, §4 naming). Everything that document lists under
  §5 — the settings screen, the device ignore list, Plex-only Filtered Pools, the Pools-screen
  navigation dead end — stays **open** and is deliberately not decided here.

## Decision

**1. A Group is ours, and it is not a provider profile.** It maps N-to-M onto provider
accounts: `{plex: [...], kavita: [...]}`. Bob is one Plex account and one Kavita user; Carol
is two Plex accounts and one Kavita; Alice is Kavita only and shares Bob's Plex. A Group may
also be an audience (`Bob & Alice`) or neither (`Demo`).

**Profile and Group collapse into ONE concept**, against the design doc's tentative
"two concepts, one control". The account mapping *is* the membership rule, so a separate
"profile that owns the accounts and implies a group" had no field of its own to hold.

**2. Membership is EXPLICIT-THEN-DERIVED, in that order.**

1. `sets:` — this group claims these set ids outright.
2. `accounts:` — provider kind → account names, consulted **only for a set no group named.**

**3. The group is in the PATH** — `/g/<id>`, the design doc's Option C. `localStorage`
answers a bare `/` only; it never overrides a URL you typed or opened. Group **ids are
immutable** and labels rename freely, the same contract set ids already have
([sets-registry-immutable-ids](2026-07-21-sets-registry-immutable-ids.md)).

**4. Provider is a FILTER, not a level of the hierarchy** — `?only=kavita` chips, not a
provider-first menu.

**5. A row inside a group drops the group's own name.** `Bob — Anime` reads as `Anime`
under Bob; the full label comes back under `All`.

## Context

> "I might want to be more granular on users. For instance, Carol might have his own Kavita
> pool/queue, but he's still in both the Older Kids and Younger Kids profiles… For me, it's 1
> to 1. 1 Plex and 1 Kavita. For Carol, it's 2 Plex and 1 Kavita. Alice has only 1 Kavita.
> The Plex stuff she shares under my account."

The owner considered provider-first and rejected it himself mid-thought: *"Naw, now I'm back
to my original idea… if I wanna read Kavita, I don't wanna have to go back to the main menu,
select 'Kavita', and then select 'Bob'… I select 'Bob' from a list, and all my stuff is
there."*

## Why

- **The indirection is load-bearing, not ceremony.** The two backends disagree about who
  anyone is — Plex knows `sawtaytoes`, Kavita knows `Bob`. Without a QueuePilot-side
  identity there is nothing to hang "all of Bob's stuff" on, which is the whole ask.
- **Explicit-beats-derived is the rule the feature lives or dies on.** Nearly every curated
  queue is gated to `sawtaytoes`, so an account-first resolution sweeps every audience into
  "Bob" — `Bob & Alice — Movies` and `Bob & Erin — Movies` included — and the
  distinction the feature exists for silently disappears. It would still *look* like a working
  feature, with one over-full chip. The opposite failure is just as real: without derivation,
  account-only groups like Kids and Demo come out empty.
- **Provider-first costs a trip to the root every time the medium changes**, for a distinction
  the person already knows.
- **A path URL is the fleet rule anyway**
  ([owned web apps use React Router with path URLs](2026-08-16-routing-is-paths-not-hashes.md)),
  and it buys bookmarks, middle-click and the back button for free. `localStorage` alone
  cannot be linked to; a path with no persistence forgets you every visit.
- **Repeating the group's name on every row is noise** — you just picked it.

## Evidence

- Owner quotes above, 2026-08-16/17, recorded verbatim in the design doc.
- `requires_profile: sawtaytoes` on the live curated queues is what makes rule 2 sharp rather
  than theoretical: `Bob & Erin — Movies` matches Bob *by account*, but Bob & Erin
  **names** it, so it stays put instead of being swallowed.
- Gate: `e2e/groups-test.ts`, 14 offline checks, in CI. It pins **both** directions of the
  membership rule (a named set does not follow its account; an unnamed one does), that a
  superseded tier is in no group and no count, that a rename keeps the id, that a PATCH
  omitting a field leaves it alone while an explicitly empty `sets: []` does clear it, that
  `all` cannot be created or edited, and that the hand-written `groups.yaml` header survives
  every write.
- 92 web unit tests, including `setLabel` (the row-shortening rule) and the `/g/<id>` route
  parser.

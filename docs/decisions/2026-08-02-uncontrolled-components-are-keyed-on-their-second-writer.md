# An uncontrolled `@charcuterie/ui` control is keyed on its SECOND writer, never on its value

- **Status:** Accepted
- **Date:** 2026-08-02
- **Type:** Frontend convention
- **Supersedes:** —
- **Superseded by:** —

## Decision

`Select`, `Accordion` and every other `@charcuterie/ui` control whose `value` /
`expandedKeys` prop is documented as **"initial only"** is uncontrolled: the prop
seeds a `defaultValue` and the DOM owns it from then on.

Where such a control is used in this app:

- Give it a **`key`** if, and only if, **something other than the user** can change
  its value or replace its option set.
- Derive that key from **the second writer** — the async fetch, the route, the
  modal's open/close, the parent selection — and **never from the control's own
  value**, which the user's pick writes.
- Say which writer, in a comment, at the site.

A control with exactly one writer (a `useState` local to the component that
renders it) gets **no key**.

## Context

Twelve native `<select>`s became `Select`, and one `<details>` became
`Accordion`. `Select`'s own source states the reason it is uncontrolled: a
`<select>` holds the chosen option in the DOM, so a `useSinglePicker` beside it
would create two owners of one fact.

That is correct, and it moves a problem to the caller. An uncontrolled control
seeded once at mount cannot hear:

- a value arriving from a fetch (`#start-series`' collection members,
  `.b-profile`'s Plex Home profiles),
- a value replaced by the router (`#chchannel` under a back button, or a typed
  `#/channels/movies`),
- an option set that belongs to something else (`#chprofile`'s options belong to
  the channel; `#movetarget`'s are "every sibling queue except this one"),
- a re-seed on a modal that never unmounts (`#set-kind`, `#dyn-behavior` — both
  modals sit at App level for the life of the page and only toggle `isOpen`).

Keying on the **value** would fix all of those and break something worse: the
control remounts under the user's own pick, taking their focus with it.

## Why

The failure this prevents is silent in every gate. A stale uncontrolled select
renders, typechecks, passes axe, and shows a plausible value — just not the one
the app believes it has. `readForm()` in `StartModal` reads React state, so the
DOM and the persisted value would diverge with nothing reporting it.

Driven in a browser, `.b-profile` on the `younger` fixture is the concrete case:
its binding stores `user_uuid: 1111111111111111`, the profile list arrives from
Plex a beat after the modal opens, and **without `key={profiles.length}` the
control stays on the placeholder** — a channel that has a profile looks like a
channel that does not.

## Evidence

Every site, with its writer:

| Control | Key | The second writer |
| --- | --- | --- |
| `#chchannel` | `channel.id` | the router (back button, typed hash) |
| `#chprofile` | `channel.id` | its OPTIONS belong to the channel |
| `#movetarget` | `currentSet` | the derivation "every sibling but this one" |
| `#set-kind`, `#dyn-behavior` | openness | a re-seed effect on a never-unmounted modal |
| `.b-profile` | `profiles.length` | the Plex profile fetch |
| `#start-series` | `children.length` | the collection-members fetch |
| `#start-season` | the season numbers | `loadEpisodes`, on open and on member switch |
| `#start-episode` | season + loaded | `loadEpisodes`, and the season picker's `onChange` |
| `.advanced` (`Accordion`) | `profiles.length` | the auto-open rule, which reads `profiles` |
| `#addpos`, `#gaddpos`, `.rowtier` | **none** | one writer — local `useState` |
| `.eps` | `item.episodes` | the server (a PATCH round-trip, and SSE from another device) |

Browser-driven proof of the chained case: switching collection member 3 → 1 → 2
repaints the episode list (10 → 12 → 1 options) and preselects E1 each time; a
five-season show opens on S7·E6 and switching to Season 11 lands on E32. Both are
values an unkeyed uncontrolled select keeps stale.

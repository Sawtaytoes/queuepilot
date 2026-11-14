import { useState } from "react"
import { PeopleRow } from "../components/PeopleRow"
import { SelectListbox } from "../components/SelectListbox"
import { channelAccountLabel } from "../lib/channels"
import { queueTitle } from "../lib/people"
import type { RegistrySet } from "../lib/types"
import { openPlayMenu } from "../state/overlays"
import { usePeople } from "../state/people"
import { PlayCard } from "./PlayCard"

/** A tier-select value → `{set, profile?}` (JSON for a binding option, a bare id
 * otherwise). */
function parseTierValue(raw: string): {
  set: string
  profile?: string
} {
  if (raw?.startsWith("{")) {
    try {
      return JSON.parse(raw)
    } catch {
      /* fall through */
    }
  }

  return { set: raw }
}

/**
 * One filtered pool's card.
 *
 * **A pool is locked to ONE account, so there is normally no picker here.** The tier dropdown
 * existed because these pools predate being able to switch the Shield's Plex profile from the
 * app: one pool had to carry every tier's binding and you chose at play time. Every pool is
 * single-account now, and a control with one option is not a choice — it is a label wearing a
 * chevron. So the account moves into the card's meta line as TEXT, and the card gets the same
 * shape as a Curated Pool / Ordered Queue card: name, kind, meta, one start button.
 * (decision `2026-08-17-a-filtered-pool-is-locked-to-one-account`)
 *
 * The picker is not deleted, only conditional: a pool that still carries two or more bindings
 * (a hand-edit, an older `sets.yaml`) keeps choosing at play time rather than silently playing
 * as whichever binding happens to be first.
 */
export function ChannelCard({
  channel,
  duplicateNumber,
}: {
  channel: RegistrySet
  /** The number after the activity when two nameless pools would read identically, or null.
   *  Ignored outright when the pool has a name of its own. */
  duplicateNumber: number | null
}) {
  const people = usePeople()
  const isRewatch = channel.behavior === "rewatch"
  const options = channel.has_explicit_profiles
    ? (channel.profiles || []).map((binding) => ({
        label: binding.plex_user || channel.label,
        value: JSON.stringify({
          profile: binding.plex_user,
          set: channel.id,
        }),
      }))
    : [{ label: channel.label, value: channel.id }]

  // Seed to the channel's saved default profile when it names a real binding, so Play
  // reaches for the right tier without the user re-picking; else the first binding.
  // (decision `2026-08-07-default-profile-per-channel`)
  const defaultValue =
    channel.has_explicit_profiles && channel.default_profile
      ? (channel.profiles || [])
          .filter(
            (binding) =>
              binding.plex_user === channel.default_profile,
          )
          .map((binding) =>
            JSON.stringify({
              profile: binding.plex_user,
              set: channel.id,
            }),
          )[0]
      : undefined

  const [tierValue, setTierValue] = useState(
    defaultValue ?? options[0]?.value ?? channel.id,
  )

  const hasChoice = options.length > 1
  // `tierValue` is local state seeded ONCE, and the options are not: another tab (or a
  // hand-edit picked up over SSE) can delete the binding this card is still holding. Falling
  // back to the current default rather than trusting the stale value is what stops the card
  // from quietly playing as an account the pool no longer has.
  const value = options.some(
    (option) => option.value === tierValue,
  )
    ? tierValue
    : (defaultValue ?? options[0]?.value ?? channel.id)
  // The account this pool is locked to, for the meta line. Null when the tier picker is on
  // screen — the card is asking rather than telling.
  //
  // This used to gate on `has_explicit_profiles`, on the belief that a legacy flat set's
  // SYNTHESIZED binding reports the channel's own label and would read as "Shows · Shows".
  // The server does not do that — the synthesized binding carries the real `plex_user` — so
  // the gate was dropping the account from every legacy pool. It only ever looked right
  // against the live `sets.yaml`, where those pools are NAMED after the accounts they play
  // as. `channelAccountLabel` compares the two instead, which is the check that claim was
  // reaching for. (decision `2026-08-26-a-picks-queue-lives-on-the-picks-screen…`)
  const boundAccount = hasChoice
    ? null
    : channelAccountLabel(channel)
  // It is ALWAYS said now. It used to be dropped while you stood inside that account's own
  // group, where it was the heading repeated — but there is no group page to stand in any
  // more, so `accountInGroup` had one caller and one answer and is gone with the chips
  // (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`).
  const onlyAccount = boundAccount
  const behaviour = isRewatch
    ? "weighted rewatch"
    : "rotation · ratings-filtered"

  return (
    <PlayCard
      kind="rules"
      // Its own name when it has one — "Shorts", "Movies" — and its ACTIVITY when it has
      // not. A rules pool is as much a `watching` thing as a curated queue is, so the same
      // rule applies to both cards on this grid
      // (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`).
      label={queueTitle(channel, duplicateNumber)}
      set={channel}
      // Whose pool this is comes FIRST — "Shows" and "Shows & Shorts" are the same words
      // until you know one is Younger Kids and the other Older Kids, and that used to be
      // readable only off the dropdown this card no longer has.
      meta={
        onlyAccount
          ? `${onlyAccount} · ${behaviour}`
          : behaviour
      }
      // A rules pool has trays now, so it wears the same row of faces a picks card does.
      // The account in the meta line beside it is a DIFFERENT fact — which Plex profile
      // this pool signs in as — and the two disagree often enough to be worth showing
      // together (decision `2026-08-26-a-rules-queue-carries-people-too`).
      people={
        <PeopleRow
          groups={people.groups}
          members={people.byQueue[channel.id] ?? []}
          people={people.people}
        />
      }
      to={`/channels/${encodeURIComponent(channel.id)}`}
      onPlay={(anchor) => {
        // With one binding the card does not ask — it plays as the account the pool is
        // configured for, which is what `tierValue` already holds.
        const parsedTier = parseTierValue(value)

        openPlayMenu({
          anchor,
          behavior: isRewatch ? "rewatch" : undefined,
          profile: parsedTier.profile,
          setId: parsedTier.set,
        })
      }}
      tier={
        hasChoice ? (
          <SelectListbox
            className="rowtier"
            label={`Profile for ${channel.label}`}
            onChange={setTierValue}
            options={options}
            size="sm"
            value={value}
          />
        ) : null
      }
    />
  )
}

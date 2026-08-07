import { SelectListbox } from "../components/SelectListbox"
import { useEffect, useState } from "react"

import { activeBinding } from "../lib/channels"
import type { RegistrySet } from "../lib/types"
import {
  resolveChannel,
  setChannelSelection,
  useChannelSelection,
} from "../state/channelSelection"
import {
  openDynModal,
  openPlayMenu,
  openSetModal,
} from "../state/overlays"
import { navigate } from "../state/route"
import { channelSetIds, rotationChannels, useStore } from "../state/store"
import { ChannelFilters } from "./ChannelFilters"
import { ChannelMembers } from "./ChannelMembers"
import { ChannelPool } from "./ChannelPool"

/**
 * CHANNELS — the rule-based rotations: a computed pool plus its filter knobs,
 * deliberately distinct from the hand-ordered queues (it is a filter, not a list).
 *
 * The picker lists EVERY dynamic channel by id, plus the curated channels (which
 * configure in the grid view, so picking one navigates there). The tier picker
 * lists only THIS channel's bindings, so a tier never appears more than once.
 * (decision `2026-07-29-dynamic-channels-first-class-and-deletable`)
 *
 * `currentChannelKind` derives from the channel's `behavior` rather than from a
 * `sub`-view argument — that is what lets Shows & Shorts, Shows, Shorts and Movies
 * each be a first-class entry.
 */
/**
 * The profile to seed a channel on when it becomes the selection. A carried-over
 * in-session pick that still matches a binding wins (so browsing keeps your choice);
 * otherwise the channel's saved `default_profile`; otherwise its first binding.
 * (decision `2026-08-07-default-profile-per-channel`)
 */
function resolveInitialProfile(
  channel: RegistrySet,
  currentProfile: string | null,
): string | null {
  const bindings = channel.profiles || []
  const matches = (name: string | null) =>
    Boolean(name) && bindings.some((b) => b.plex_user === name)

  if (matches(currentProfile)) return currentProfile
  if (matches(channel.default_profile ?? null)) return channel.default_profile ?? null

  return activeBinding(channel, null).plex_user || null
}

export function ChannelsView({
  isHidden,
  routeId,
}: {
  isHidden: boolean
  routeId: string | null
}) {
  const { data, reg } = useStore()
  const { channelId: currentChannel, profile: currentProfile } =
    useChannelSelection()
  const [resampleToken, setResampleToken] = useState(0)

  const all = rotationChannels(reg)
  const channel = resolveChannel(reg, routeId, currentChannel)
  const isMovies = channel?.behavior === "rewatch"

  useEffect(() => {
    if (isHidden || !channel) return

    setChannelSelection(
      channel.id,
      channel.has_explicit_profiles
        ? resolveInitialProfile(channel, currentProfile)
        : null,
    )
    // Re-derive only when the selected channel changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel?.id, isHidden])

  if (!channel) {
    return <main className="view" hidden={isHidden} id="channels" />
  }

  const binding = activeBinding(channel, currentProfile)
  const profileOptions = channel.has_explicit_profiles
    ? (channel.profiles || []).map((b) => ({
        label: b.plex_user || channel.label,
        value: `${channel.id}::${b.plex_user || ""}`,
      }))
    : [{ label: channel.label, value: channel.id }]
  const profileValueNow = channel.has_explicit_profiles
    ? `${channel.id}::${binding.plex_user || ""}`
    : channel.id

  return (
    <main className="view" hidden={isHidden} id="channels">
      <div className="chhead">
        <label>
          Channel
          {/* `key={channel.id}` on BOTH pickers, for two different reasons, and
              neither is "the value changed".

              `Select` is uncontrolled by decision — `value` seeds `defaultValue`
              and the DOM owns it thereafter — so a key is needed exactly where a
              SECOND writer exists.

              - Channel: the second writer is the router. Picking here navigates,
                and the DOM is already right; but a back button or a typed
                `#/channels/movies` changes `channel.id` with nobody having touched
                the control, and without the key the picker would keep naming the
                channel you left.
              - Profile: its OPTIONS belong to the channel, so they must be
                re-seeded when the channel changes. Keying it on the channel rather
                than on `profileValueNow` is the point — picking a profile leaves
                `channel.id` alone, so the user's own change never remounts the
                control under their focus. */}
          <SelectListbox
            id="chchannel"
            key={channel.id}
            label="Channel"
            onChange={(v) => {
              // A curated channel configures in the grid editor.
              if (v.startsWith("q:")) navigate(`#/q/${v.slice(2)}`)
              else navigate(`#/channels/${v}`)
            }}
            // Flat list: `Listbox` has no option groups, so the old "Dynamic Channels" /
            // "Curated Channels" headers are dropped — dynamic channels first, then the
            // curated ones (the `q:` prefix still routes them to the grid editor).
            options={[
              ...all.map((s) => ({ label: s.label, value: s.id })),
              ...channelSetIds(data).map((id) => ({
                label: data!.sets[id]!.label,
                value: `q:${id}`,
              })),
            ]}
            value={channel.id}
          />
        </label>
        <label>
          Profile
          <SelectListbox
            id="chprofile"
            key={channel.id}
            label="Profile"
            onChange={(v) => {
              const i = v.indexOf("::")

              if (i >= 0) setChannelSelection(v.slice(0, i), v.slice(i + 2) || null)
              else setChannelSelection(v, null)
            }}
            options={profileOptions}
            value={profileValueNow}
          />
        </label>
        <button
          className="playbtn"
          id="chplay"
          onClick={(e) =>
            openPlayMenu({
              anchor: e.currentTarget.getBoundingClientRect(),
              kind: isMovies ? "movie" : undefined,
              profile: currentProfile || undefined,
              setId: channel.id,
            })}
          type="button"
        >
          ▶ Play on ▾
        </button>
        <button
          className="ghost"
          id="chresample"
          onClick={() => setResampleToken((n) => n + 1)}
          type="button"
        >
          Resample
        </button>
        <button
          className="ghost"
          id="chconfigure"
          onClick={() => openDynModal(channel.id)}
          title="Full channel config"
          type="button"
        >
          ⚙ Configure
        </button>
        <button
          className="ghost accent"
          id="newdyn"
          onClick={() => openDynModal(null)}
          type="button"
        >
          ＋ Dynamic channel
        </button>
        {/* "New channel" splits by category: a Curated channel is a hand-picked
            member set (the set modal, kind=anime); a Dynamic channel is a
            rule-based rotation. */}
        <button
          className="ghost accent"
          id="newcurated"
          onClick={() => openSetModal(null, "anime")}
          type="button"
        >
          ＋ Curated channel
        </button>
        <span className="chnote">
          A sample of what could play — the real rotation shuffles fresh every scan.
        </span>
      </div>
      <div id="chbody">
        <ChannelMembers channel={channel} isShown={!isHidden && !isMovies} />
        {isHidden
          ? <section className="chpool"><h2 id="chpool-title">Eligible pool</h2><ul className="grid" id="chpool" /></section>
          : (
              <ChannelPool
                channel={channel}
                currentProfile={currentProfile}
                key={channel.id}
                onChanged={() => setResampleToken((n) => n)}
                resampleToken={resampleToken}
              />
            )}
        <ChannelFilters
          channel={channel}
          currentProfile={currentProfile}
          isMovies={isMovies}
          key={`${channel.id}::${currentProfile ?? ""}`}
          onChanged={() => {}}
        />
      </div>
    </main>
  )
}

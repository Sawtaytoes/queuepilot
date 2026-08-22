import { Button } from "@charcuterie/ui"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router"
import {
  isPullSet,
  OpenQueueButton,
} from "../components/OpenQueueButton"
import { SelectListbox } from "../components/SelectListbox"
import { Tip } from "../components/Tip"
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
import {
  channelSetIds,
  rotationChannels,
  useStore,
} from "../state/store"
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
    Boolean(name) &&
    bindings.some((b) => b.plex_user === name)

  if (matches(currentProfile)) return currentProfile
  if (matches(channel.default_profile ?? null))
    return channel.default_profile ?? null

  return activeBinding(channel, null).plex_user || null
}

export function ChannelsView({
  isHidden,
  routeId,
}: {
  isHidden: boolean
  routeId: string | null
}) {
  const navigate = useNavigate()
  const { data, reg } = useStore()
  const {
    channelId: currentChannel,
    profile: currentProfile,
  } = useChannelSelection()
  const [resampleToken, setResampleToken] = useState(0)
  // Distinct from `resampleToken`: a blocklist / exclude write moves the pool but
  // must NOT trigger a `fresh=1` reshuffle — it re-reads the (already
  // blocklist-filtered) preview in place. `PATCH /api/sets/:id` busts the server
  // preview cache, so this cheap re-read returns the excluded show already gone.
  const [reloadToken, setReloadToken] = useState(0)

  const all = rotationChannels(reg)
  const channel = resolveChannel(
    reg,
    routeId,
    currentChannel,
  )
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
    return (
      <main
        className="view"
        hidden={isHidden}
        id="channels"
      />
    )
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
  /**
   * A pool is locked to ONE account, so there is normally nothing to pick here either.
   *
   * Same rule the Play landing row got on 2026-08-17, and it has to be the same rule: this
   * page and that row are two views of one pool, and a chevron on one but not the other says
   * they disagree about whether the account is a choice. It is not — it is a fact, so it
   * prints as text beside the pool's name.
   * (decision `2026-08-17-a-filtered-pool-is-locked-to-one-account`)
   */
  const hasProfileChoice = profileOptions.length > 1
  const onlyAccount = channel.has_explicit_profiles
    ? (channel.profiles || [])[0]?.plex_user || null
    : null

  return (
    <main
      className="view"
      // The pool editor wears its provider's accent, exactly as the queue grid does — this
      // page was the ONE view that forgot to, so a Plex pool's "▶ Play on ▾" came out in the
      // app's neutral violet while the same pool's row on the Play landing (and its own grid
      // at `/q/<id>`) came out Plex-amber. One page, two colours, same provider.
      // (decision `2026-08-15-a-queue-wears-its-providers-colour`)
      data-provider={channel.provider_kind || undefined}
      hidden={isHidden}
      id="channels"
    >
      <div className="chhead">
        <label>
          Pool
          {/* `key={channel.id}` on BOTH pickers, for two different reasons, and
              neither is "the value changed".

              A picker is uncontrolled by decision — `value` seeds the `Listbox`,
              which owns the selection thereafter (it was a native `Select` seeding
              `defaultValue` when this was written; the reasoning survived the
              2026-08-07 move to `Listbox` unchanged) — so a key is needed exactly
              where a SECOND writer exists.

              - Channel: the second writer is the router. Picking here navigates,
                and the DOM is already right; but a back button or a typed
                `/channels/movies` changes `channel.id` with nobody having touched
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
            label="Pool"
            onChange={(v) => {
              // A curated pool configures in the grid editor.
              if (v.startsWith("q:"))
                navigate(`/q/${v.slice(2)}`)
              else navigate(`/channels/${v}`)
            }}
            // Flat list: `Listbox` has no option groups, so the Play landing's
            // "Filtered Pools" / "Curated Pools" headings are dropped — filtered pools
            // first, then the curated ones (the `q:` prefix still routes them to the
            // grid editor).
            options={[
              ...all.map((s) => ({
                label: s.label,
                value: s.id,
              })),
              ...channelSetIds(data).map((id) => ({
                label: data!.sets[id]!.label,
                value: `q:${id}`,
              })),
            ]}
            value={channel.id}
          />
        </label>
        {hasProfileChoice ? (
          <label>
            Profile
            <SelectListbox
              id="chprofile"
              key={channel.id}
              label="Profile"
              onChange={(v) => {
                const i = v.indexOf("::")

                if (i >= 0)
                  setChannelSelection(
                    v.slice(0, i),
                    v.slice(i + 2) || null,
                  )
                else setChannelSelection(v, null)
              }}
              options={profileOptions}
              value={profileValueNow}
            />
          </label>
        ) : onlyAccount ? (
          <span className="chaccount" id="chprofile-fixed">
            Plays as <strong>{onlyAccount}</strong>
          </span>
        ) : null}
        {isPullSet(channel) ? (
          <OpenQueueButton set={channel} />
        ) : (
          <>
            {/* A Charcuterie `Button`. `.playbtn` was a SOLID accent skin — background, on-solid
            text, no border, 600 weight — which is the component's default `appearance` with
            `intent="accent"`.

            ⚠️ THE CLASS STAYS, and it is a DOM HANDLE now, not a skin. `PlayMenu`'s
            outside-click handler asks `t.closest(".playbtn")` so that pressing a play button
            does not immediately close the menu it just opened; drop the class and every one
            of these opens a menu that shuts on the same click. `.playcard .playbtn`'s
            `flex-shrink: 0` is the other survivor, and that is app layout.
            (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`) */}
            <Button
              className="playbtn"
              id="chplay"
              intent="accent"
              onClick={(e) =>
                openPlayMenu({
                  anchor:
                    e.currentTarget.getBoundingClientRect(),
                  kind: isMovies ? "movie" : undefined,
                  profile: currentProfile || undefined,
                  setId: channel.id,
                })
              }
            >
              ▶ Play on ▾
            </Button>
          </>
        )}
        {/* Four Charcuterie `Button`s, configured by PROPS. They were raw `<button>`s
            wearing `ghost` (which paints) and `accent` (which did NOT — its only rules
            are `#tools button.accent` and `.playlinks button.accent`, and this row is
            neither, so the two pool-creation buttons had never once shown the accent
            treatment their class asked for).
            (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`)

            The intents are the row's meaning, not decoration: Resample and Configure act
            on the pool you are already looking at, so they are `neutral`; the two `＋`
            buttons MAKE something, which is what `accent` was reaching for and what
            `＋ New queue` gets in the Home toolbar. `outline` throughout, because the
            row already has one solid control (`▶ Play on`) and a second would stop it
            reading as the thing to press. */}
        <Button
          appearance="outline"
          id="chresample"
          intent="neutral"
          onClick={() => setResampleToken((n) => n + 1)}
        >
          Resample
        </Button>
        <Tip label="Full pool config">
          <Button
            appearance="outline"
            id="chconfigure"
            intent="neutral"
            onClick={() => openDynModal(channel.id)}
          >
            ⚙ Configure
          </Button>
        </Tip>
        <Button
          appearance="outline"
          id="newdyn"
          intent="accent"
          onClick={() => openDynModal(null)}
        >
          ＋ Filtered pool
        </Button>
        {/* "New pool" splits by how membership is decided: a Curated pool is a
            hand-picked member set (the set modal, kind=anime); a Filtered pool
            derives its members from rules. */}
        <Button
          appearance="outline"
          id="newcurated"
          intent="accent"
          onClick={() => openSetModal(null, "anime")}
        >
          ＋ Curated pool
        </Button>
        <span className="chnote">
          A sample of what could play — the real rotation
          re-draws fresh every scan.
        </span>
      </div>
      <div id="chbody">
        <ChannelMembers
          channel={channel}
          currentProfile={currentProfile}
          isShown={!isHidden && !isMovies}
        />
        {isHidden ? (
          <section className="chpool">
            <h2 id="chpool-title">Eligible pool</h2>
            <ul className="grid" id="chpool" />
          </section>
        ) : (
          <ChannelPool
            channel={channel}
            currentProfile={currentProfile}
            key={channel.id}
            onChanged={() => setReloadToken((n) => n + 1)}
            reloadToken={reloadToken}
            resampleToken={resampleToken}
          />
        )}
        <ChannelFilters
          channel={channel}
          currentProfile={currentProfile}
          isMovies={isMovies}
          key={`${channel.id}::${currentProfile ?? ""}`}
          onChanged={() => setReloadToken((n) => n + 1)}
        />
      </div>
    </main>
  )
}

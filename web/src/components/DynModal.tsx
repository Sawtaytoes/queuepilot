import { Accordion, Checkbox } from "@charcuterie/ui"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useNavigate } from "react-router"

import { api } from "../lib/api"
import {
  fetchProfiles,
  fetchRatings,
  fetchScopedRatings,
  libSelection,
  profileValue,
  ratingOptions,
} from "../lib/channels"
import { LINEUP_PRESET_COMMON } from "../lib/countPicker"
import type {
  Binding,
  LineupDefaults,
  Profile,
  RegistrySet,
} from "../lib/types"
import {
  closeDynModal,
  useOverlays,
} from "../state/overlays"
import { load, setStatus, useStore } from "../state/store"
import { CheckboxGroup } from "./CheckboxGroup"
import { CountPicker } from "./CountPicker"
import { Modal } from "./Modal"
import { SelectListbox } from "./SelectListbox"

/**
 * Create / configure a DYNAMIC (rule-based rotation) channel — the "full access"
 * path: everything the Python engine reads from a rotation entry in sets.yaml,
 * authored from the UI.
 *
 * The interesting part is the per-profile **bindings** sub-editor. A rotation
 * channel binds one or more Plex Home profiles, each with its OWN rating caps; the
 * library fieldsets stay channel-level. Two rules here are bug fixes, both of them
 * about a binding's ratings being its own data:
 *
 * - A card's option universe is seeded with **`union(known, that binding's saved
 *   ratings)`**, where `known` is scoped to whichever profile happens to be active.
 *   Seeding from `known` alone left a non-active binding's card blank, and the very
 *   next Save persisted that blankness — silent data loss.
 * - Re-scoping a card keeps any **currently-checked** rating as an option even when
 *   the per-profile fetch omits it, for the same reason.
 *
 * (decision `2026-07-29-binding-ratings-render-per-profile-not-shared-scope`)
 */

/**
 * First-paint fallback ONLY, for the render before `GET /api/sets` has answered. The real
 * numbers are that response's `lineup` (server env), and every number the user can actually
 * commit is validated against those — see `LineupDefaults`.
 */
const LINEUP_FALLBACK: LineupDefaults = {
  length: 12,
  max: 200,
  topup_at: 3,
}

type BindingDraft = {
  /** Stable across renders so React can key the cards through add/remove. */
  uid: number
  plexUser: string
  accountId: string
  userUuid: string
  showOptions: string[]
  showChecked: string[]
  movieOptions: string[]
  movieChecked: string[]
  isAdvancedOpen: boolean
}

let nextUid = 1

const toDraft = (
  b: Binding,
  known: string[],
): BindingDraft => ({
  accountId:
    b.account_id != null ? String(b.account_id) : "",
  isAdvancedOpen: false,
  movieChecked: b.movie_ratings || [],
  movieOptions: ratingOptions(known, b.movie_ratings || []),
  plexUser: b.plex_user || "",
  showChecked: b.allowed_ratings || [],
  showOptions: ratingOptions(
    known,
    b.allowed_ratings || [],
  ),
  uid: nextUid++,
  userUuid: b.user_uuid || "",
})

const readBinding = (d: BindingDraft): Binding => ({
  account_id: d.accountId.trim()
    ? Number(d.accountId.trim())
    : null,
  allowed_ratings: d.showChecked,
  movie_ratings: d.movieChecked,
  plex_user: d.plexUser.trim() || null,
  user_uuid: d.userUuid.trim() || null,
  watch_count_accounts: d.accountId.trim()
    ? [Number(d.accountId.trim())]
    : [],
})

const hasData = (b: Binding) =>
  Boolean(
    b.plex_user ||
      b.account_id != null ||
      b.user_uuid ||
      b.allowed_ratings.length ||
      b.movie_ratings.length,
  )

export function DynModal() {
  const navigate = useNavigate()
  const { dynModal } = useOverlays()
  const { reg } = useStore()

  const setId = dynModal?.setId ?? null
  const editing = useMemo(
    () =>
      setId
        ? (reg?.sets.find((s) => s.id === setId) ?? null)
        : null,
    [reg, setId],
  )

  const [label, setLabel] = useState("")
  const [kind, setKind] = useState("cartoons")
  const [behavior, setBehavior] = useState<
    "progress" | "rewatch"
  >("progress")
  const [audio, setAudio] = useState("")
  const [showSections, setShowSections] = useState<
    number[]
  >([])
  const [itemSections, setItemSections] = useState<
    number[]
  >([])
  const [bindings, setBindings] = useState<BindingDraft[]>(
    [],
  )
  const [profiles, setProfiles] = useState<Profile[]>([])
  // Which binding the Play/Channels dropdowns seed to (a binding's plex_user); "" = none
  // (fall back to the first binding). (decision `2026-08-07-default-profile-per-channel`)
  const [defaultProfile, setDefaultProfile] = useState("")
  // The LINEUP knobs (decision `2026-08-17-a-lineup-refills-instead-of-ending`). All three
  // were API-and-YAML-only until now, which meant the answer to "why did the kids' card stop"
  // lived in a file the owner never opens.
  //
  // `lineupLength` holds the EFFECTIVE number, seeded from the app default rather than from 0
  // or null, so the picker can chip that option Default instead of showing a number nobody
  // chose. Storing it back sparsely is the server's job (`toLineupLength`), same split the
  // entry counts use.
  const [lineupLength, setLineupLength] = useState(
    LINEUP_FALLBACK.length,
  )
  const [isRefilling, setIsRefilling] = useState(false)
  const [onComplete, setOnComplete] = useState("drop")

  const knownRef = useRef<string[]>([])
  // The engine's own defaults, so the picker's Default chip and its ceiling are the server's
  // numbers and not a second copy of them in this bundle.
  const lineup = reg?.lineup ?? LINEUP_FALLBACK
  // Identity of the open modal instance — every uncontrolled Charcuterie control here
  // (Checkbox / SelectListbox) seeds on mount only, so it remounts in lockstep with the
  // re-seed effect below. Keyed on OPENNESS, never on a value the user's own pick writes
  // (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`).
  const modalKey = dynModal ? (setId ?? "new") : "closed"

  const showLibs = useMemo(
    () =>
      (reg?.libraries ?? []).filter(
        (l) => l.video && l.type === "show",
      ),
    [reg],
  )
  // Both groups are Plex movie-type sections feeding the same `item_sections` —
  // split in the UI the way Plex does: real Movie libraries vs "Other Videos".
  const movieLibs = useMemo(
    () =>
      (reg?.libraries ?? []).filter(
        (l) => l.video && l.type === "movie" && !l.other,
      ),
    [reg],
  )
  const otherLibs = useMemo(
    () =>
      (reg?.libraries ?? []).filter(
        (l) => l.video && l.type === "movie" && l.other,
      ),
    [reg],
  )

  useEffect(() => {
    if (!dynModal) return

    let isStale = false

    setLabel(editing ? editing.label : "")
    setKind(
      editing ? editing.kind || "cartoons" : "cartoons",
    )
    // `behavior` supersedes the old `mode`; map a legacy set's mode when it has no
    // behavior yet (rewatch → rewatch, everything else → progress).
    setBehavior(
      editing
        ? editing.behavior ||
            (editing.mode === "rewatch"
              ? "rewatch"
              : "progress")
        : "progress",
    )
    setAudio(editing ? editing.audio_language || "" : "")
    setDefaultProfile(
      editing ? editing.default_profile || "" : "",
    )
    // A channel with no `length:` of its own follows the app default — show THAT number, not
    // a placeholder, because it is what the pool will actually queue tonight.
    setLineupLength(editing?.length ?? lineup.length)
    setIsRefilling(Boolean(editing?.refill))
    setOnComplete(
      editing?.on_complete === "restart"
        ? "restart"
        : "drop",
    )

    const checked = libSelection(editing)

    setShowSections(checked.show)
    setItemSections(checked.item)

    const run = async () => {
      const [ps, known] = await Promise.all([
        fetchProfiles(),
        fetchRatings(editing || undefined, undefined),
      ])

      if (isStale) return

      knownRef.current = known
      setProfiles(ps)

      // Every rotation set exposes a `profiles` array (PR 2a synthesizes one from
      // legacy fields), so an existing channel fills its cards from it; a brand-new
      // channel starts with one empty card to fill in.
      const list = editing?.profiles?.length
        ? editing.profiles
        : [{} as Binding]

      setBindings(list.map((b) => toDraft(b, known)))
    }

    void run()

    return () => {
      isStale = true
    }
    // Re-seed only when the modal is (re-)opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dynModal])

  const sectionScope = useCallback(
    () =>
      [...new Set([...showSections, ...itemSections])].join(
        ",",
      ),
    [itemSections, showSections],
  )

  /** Re-scope ONE card's ratings pickers to its profile's restricted view of the
   * currently-checked libraries, preserving that card's existing selections. */
  const scopeCard = useCallback(
    async (uid: number, uuid: string) => {
      const ratings = await fetchScopedRatings(
        uuid,
        sectionScope(),
      )

      setBindings((prev) =>
        prev.map((d) =>
          d.uid === uid
            ? {
                ...d,
                movieOptions: ratingOptions(
                  ratings,
                  d.movieChecked,
                ),
                showOptions: ratingOptions(
                  ratings,
                  d.showChecked,
                ),
              }
            : d,
        ),
      )
    },
    [sectionScope],
  )

  /** Ratings depend on which libraries are picked, so a library change re-scopes
   * EVERY binding — each to its own profile's restricted view. */
  const rescopeAll = useCallback(() => {
    for (const d of bindings) {
      if (d.userUuid.trim())
        void scopeCard(d.uid, d.userUuid.trim())
    }
  }, [bindings, scopeCard])

  const patchBinding = (
    uid: number,
    patch: Partial<BindingDraft>,
  ) =>
    setBindings((prev) =>
      prev.map((d) =>
        d.uid === uid ? { ...d, ...patch } : d,
      ),
    )

  const onSubmit = async () => {
    const name = label.trim()

    if (!name) {
      setStatus("Name required", "err")

      return
    }

    // The server requires at least one library on a rotation channel — show OR item
    // (a Shorts-only channel has no show library at all); enforce here so the user
    // gets a clear message rather than a 400.
    if (!showSections.length && !itemSections.length) {
      setStatus("Pick at least one library", "err")

      return
    }

    // Collect the bindings; drop empty cards. When ≥1 has data, send `profiles[]`
    // (the canonical shape); Node writes it and drops the legacy top-level fields.
    const collected = bindings
      .map(readBinding)
      .filter(hasData)

    const body: Record<string, unknown> = {
      audio_language: audio.trim(),
      behavior,
      blocklist: [],
      item_sections: itemSections,
      kind: kind.trim() || "cartoons",
      label: name,
      movie_excludes: [],
      // Sent unconditionally, including from a rewatch channel where the controls are hidden:
      // the values round-trip whatever that channel already stored, so switching a pool to
      // Rewatch and back cannot quietly lose its refill. The server stores all three SPARSELY
      // (a length equal to the app default, a `refill: false` and an `on_complete: drop` are
      // stored by absence), which is what keeps this Save from writing three keys that say
      // nothing onto every channel it touches.
      length: lineupLength,
      on_complete: onComplete,
      refill: isRefilling,
      sections: showSections,
      source: "rotation",
    }

    if (collected.length) body.profiles = collected

    // Only persist a default that still names one of the saved bindings; anything else
    // (blank, or a since-renamed profile) clears it so the dropdowns fall back to the first.
    const named = collected
      .map((b) => b.plex_user)
      .filter(Boolean)

    body.default_profile =
      defaultProfile && named.includes(defaultProfile)
        ? defaultProfile
        : ""

    setStatus("Saving channel…")

    try {
      if (setId)
        await api("PATCH", `/api/sets/${setId}`, body)
      else await api("POST", "/api/sets", body)

      closeDynModal()
      setStatus(
        setId ? "Channel updated" : "Channel created",
        "ok",
      )
      await load()
      navigate("/channels")
    } catch (err) {
      setStatus(
        `Save failed: ${(err as Error).message}`,
        "err",
      )
    }
  }

  const onDelete = async () => {
    if (!setId) return

    const ch: RegistrySet | undefined = reg?.sets.find(
      (s) => s.id === setId,
    )
    const name = ch ? ch.label : setId

    if (
      !confirm(
        `Delete the “${name}” channel?\n\n` +
          "This removes it permanently. Any NFC card or HA button set to play " +
          `"${setId}" will stop working until you repoint it — this app can't ` +
          "change Home Assistant.",
      )
    ) {
      return
    }

    setStatus("Deleting channel…")

    try {
      await api(
        "DELETE",
        `/api/sets/${encodeURIComponent(setId)}`,
      )
      closeDynModal()
      setStatus("Channel deleted", "ok")
      await load()
      navigate("/channels")
    } catch (e) {
      setStatus(
        `Delete failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  const libOptions = (libs: typeof showLibs) =>
    libs.map((l) => ({ label: l.title, value: l.id }))

  // The bindings the default-profile picker can point at — a default is only meaningful
  // once a channel binds more than one named profile.
  const namedProfiles = [
    ...new Set(
      bindings
        .map((d) => d.plexUser.trim())
        .filter(Boolean),
    ),
  ]

  return (
    <Modal
      footer={
        <>
          <button
            className="danger"
            hidden={!editing}
            id="dyn-delete"
            onClick={() => void onDelete()}
            type="button"
          >
            Delete channel
          </button>
          <span className="spacer" />
          <button
            className="ghost"
            id="dyn-cancel"
            onClick={closeDynModal}
            type="button"
          >
            Cancel
          </button>
          <button id="dyn-save" type="submit">
            Save
          </button>
        </>
      }
      id="dynmodal"
      isOpen={Boolean(dynModal)}
      onClose={closeDynModal}
      onSubmit={() => void onSubmit()}
      title={
        editing
          ? `Configure “${editing.label}”`
          : "New dynamic channel"
      }
      titleId="dynmodal-title"
    >
      <label className="field">
        Name
        <input
          id="dyn-label"
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Older Kids — Anime"
          required
          type="text"
          value={label}
        />
      </label>
      <label className="field">
        Behavior
        {/* Keyed on openness for the same reason as `#set-kind`: this modal is
            mounted at App level for the life of the page and re-seeds `behavior`
            from the edited channel in an effect on `[dynModal]`. */}
        <SelectListbox
          id="dyn-behavior"
          key={modalKey}
          label="Behavior"
          onChange={(v) =>
            setBehavior(v as "progress" | "rewatch")
          }
          options={[
            {
              label:
                "Progress — next unwatched (shows & shorts, in order)",
              value: "progress",
            },
            {
              label:
                "Rewatch — weighted least-watched replay",
              value: "rewatch",
            },
          ]}
          value={behavior}
        />
      </label>
      <label className="field">
        Kind tag
        <input
          id="dyn-kind"
          maxLength={30}
          onChange={(e) => setKind(e.target.value)}
          placeholder="cartoons"
          type="text"
          value={kind}
        />
      </label>

      <div id="dyn-libs">
        <fieldset className="field">
          <legend>Show libraries</legend>
          <CheckboxGroup
            checked={showSections}
            id="dyn-showlibs"
            onToggle={(v, isChecked) => {
              setShowSections((prev) =>
                isChecked
                  ? [...prev, v]
                  : prev.filter((x) => x !== v),
              )
              rescopeAll()
            }}
            options={libOptions(showLibs)}
            seedKey={modalKey}
          />
        </fieldset>
        <fieldset className="field">
          <legend>Movie libraries</legend>
          <CheckboxGroup
            checked={itemSections}
            id="dyn-movielibs"
            onToggle={(v, isChecked) => {
              setItemSections((prev) =>
                isChecked
                  ? [...prev, v]
                  : prev.filter((x) => x !== v),
              )
              rescopeAll()
            }}
            options={libOptions(movieLibs)}
            seedKey={modalKey}
          />
        </fieldset>
        <fieldset
          className="field"
          hidden={!otherLibs.length}
          id="dyn-otherbox"
        >
          <legend>Other videos</legend>
          <CheckboxGroup
            checked={itemSections}
            id="dyn-otherlibs"
            onToggle={(v, isChecked) => {
              setItemSections((prev) =>
                isChecked
                  ? [...prev, v]
                  : prev.filter((x) => x !== v),
              )
              rescopeAll()
            }}
            options={libOptions(otherLibs)}
            seedKey={modalKey}
          />
        </fieldset>
      </div>

      {/* A show library means different things per behavior: episodes to progress
          through, or (on a rewatch channel) its one-episode films. Note it only
          where it applies. */}
      <p
        className="subhint"
        hidden={behavior !== "rewatch"}
        id="dyn-libnote"
      >
        A show library contributes its FILMS here —
        one-episode entries (that is how anime movies are
        scanned). Multi-episode series never enter a rewatch
        pool.
      </p>

      {/* THE LINEUP — how much a scan queues, whether it is topped back up, and what a
          finished show does. All three shipped 2026-08-17 as YAML + `PATCH /api/sets/:id`
          only (decision `2026-08-17-a-lineup-refills-instead-of-ending`), which left the
          answer to "why did the kids' card stop mid-evening" in a file the owner never opens.

          HIDDEN on a rewatch pool rather than reworded, the same call `batch_stops_at` gets
          on a queue with no Plex source: `behavior: rewatch` returns exactly one film per
          scan and honours neither `length` nor `refill`, so every control here would be a
          knob that does nothing. The note below says so instead of leaving a gap. */}
      <fieldset
        className="field flags"
        hidden={behavior === "rewatch"}
        id="dyn-lineup"
      >
        <legend>Lineup</legend>
        {/* A <div>+<span>, not a <label>: CountPicker is a group of BUTTONS, not an input, so
            a <label> would have no control to name. Same shape the set editor uses. */}
        <div className="field">
          <span className="fieldlbl">
            Items queued ahead
          </span>
          <CountPicker
            defaultValue={lineup.length}
            id="dyn-length"
            label="Items queued ahead"
            max={lineup.max}
            onChange={setLineupLength}
            presets={LINEUP_PRESET_COMMON}
            value={lineupLength}
          />
        </div>
        <p className="subhint" id="dyn-length-hint">
          {`How many items one scan queues. With top-up off that is the whole sitting — ${lineup.length}
            is four hours of half-hour shows but only about half an hour of shorts, which is
            how the Shorts card ran dry mid-evening. With top-up on it becomes the WINDOW:
            how far ahead to stay.`}
        </p>
        {/* Charcuterie Checkbox is uncontrolled (isChecked seeds once), so it remounts with
            the modal — same treatment the set editor's flags get. */}
        <Checkbox
          id="dyn-refill"
          isChecked={isRefilling}
          key={`${modalKey}-refill`}
          label="Keep it topped up — refill instead of ending"
          onChange={setIsRefilling}
        />
        <p className="subhint" id="dyn-refill-hint">
          {`Tops the lineup back up whenever ${lineup.topup_at} or fewer items are left ahead, so a
            card that is still playing never runs out. Home Assistant ticks while something
            is playing; whether the lineup is actually low is judged here, so a tick on a
            full lineup does nothing. Off, the lineup simply ends when it ends.`}
        </p>
        <label className="field">
          When a show has nothing left to watch
          {/* Keyed on modal-open identity, same reason as the selects above. */}
          <SelectListbox
            className="fieldselect"
            id="dyn-on-complete"
            key={modalKey}
            label="When a show has nothing left to watch"
            onChange={setOnComplete}
            options={[
              {
                label: "Drop it — it leaves this pool",
                value: "drop",
              },
              {
                label: "Start it over from the beginning",
                value: "restart",
              },
            ]}
            value={onComplete}
          />
        </label>
        <p className="subhint" id="dyn-on-complete-hint">
          Only fires when a show is genuinely finished — not
          when this lineup merely stopped drawing from it.
          Dropping is what every pool has always done.
          Starting over is what keeps a topped-up rotation
          from withering as the kids finish shows, and on a
          shorts-only pool it brings the whole library back
          around.
        </p>
      </fieldset>
      {/* Not a gap where the fieldset was: a rewatch pool's owner should be told these knobs
          do not reach it, rather than left to wonder where they went. */}
      <p
        className="subhint"
        hidden={behavior !== "rewatch"}
        id="dyn-lineup-rewatch-note"
      >
        A rewatch pool returns a single film per scan, so
        the lineup length and top-up settings do not apply
        to it yet.
      </p>

      <fieldset className="field" id="dyn-profilesbox">
        <legend>Profiles &amp; ratings</legend>
        <p className="subhint">
          One or more Plex Home profiles this channel plays
          under — each with its own rating caps (scoped to
          what that profile can pick). At play time the
          signed-in profile decides which applies.
        </p>
        <div id="dyn-bindings">
          {bindings.map((d) => (
            <div className="binding" key={d.uid}>
              <div className="binding-head">
                <label className="subfield bprof">
                  Plex profile
                  {/* Keyed on how many profiles arrived. The list is fetched from
                      Plex after the modal opens, so the options are empty on the
                      first paint and replaced wholesale a moment later — an
                      uncontrolled select seeded against the empty list would be
                      stuck on the placeholder even for a binding that already names
                      a profile. Not keyed on the resolved value, which the user's
                      own pick writes (through `patchBinding`). */}
                  <SelectListbox
                    className="b-profile"
                    key={profiles.length}
                    label="Plex profile"
                    onChange={(v) => {
                      const p = profiles.find(
                        (x) => profileValue(x) === v,
                      )

                      if (!p) return

                      patchBinding(d.uid, {
                        accountId:
                          p.id != null ? String(p.id) : "",
                        plexUser: p.name || "",
                        userUuid: p.uuid || "",
                      })
                      void scopeCard(d.uid, p.uuid || "")
                    }}
                    options={profiles.map((p) => ({
                      label: p.admin
                        ? `${p.name} (admin)`
                        : p.name,
                      value: profileValue(p),
                    }))}
                    /* Was a real `<option value="">` the user could re-pick, which
                       did nothing (`if (!p) return`). `placeholder` renders it
                       DISABLED, so the control can no longer be put back into a
                       state that silently means "unset". */
                    placeholder={
                      profiles.length
                        ? "— pick a profile —"
                        : "— none found (use Advanced) —"
                    }
                    value={
                      profiles.find(
                        (p) =>
                          (d.userUuid &&
                            p.uuid === d.userUuid) ||
                          (d.accountId &&
                            p.id === Number(d.accountId)),
                      )
                        ? profileValue(
                            profiles.find(
                              (p) =>
                                (d.userUuid &&
                                  p.uuid === d.userUuid) ||
                                (d.accountId &&
                                  p.id ===
                                    Number(d.accountId)),
                            )!,
                          )
                        : ""
                    }
                  />
                </label>
                <button
                  aria-label="Remove this profile"
                  className="b-remove ghost"
                  /* A channel keeps ≥1 binding, so the button only exists once
                     there is more than one card. */
                  hidden={bindings.length <= 1}
                  onClick={() =>
                    setBindings((prev) =>
                      prev.filter((x) => x.uid !== d.uid),
                    )
                  }
                  type="button"
                >
                  Remove
                </button>
              </div>
              {/* Was a `<details>`, and it was the exact two-owners case
                  `Accordion`'s own docs describe: `<details>` owns `open`, while
                  the app wants it opened for a REASON — a hand-set mapping that
                  matches no dropdown option, which is the only time these manual
                  fields are not noise.

                  `expandedKeys` is initial-only (charcuterie owns it after), so
                  the auto-open needs a `key` on the one input it cannot see
                  coming: `profiles` arrives from Plex a beat after the modal
                  opens, and until it does EVERY binding looks unmatched, so an
                  unkeyed accordion would open Advanced on all of them and stay
                  that way. Not keyed on `isAdvancedOpen`, which the user's own
                  toggle writes. */}
              <Accordion
                className="advanced b-advanced"
                expandedKeys={
                  d.isAdvancedOpen ||
                  (!profiles.some(
                    (p) =>
                      (d.userUuid &&
                        p.uuid === d.userUuid) ||
                      (d.accountId &&
                        p.id === Number(d.accountId)),
                  ) &&
                    Boolean(
                      d.plexUser ||
                        d.accountId ||
                        d.userUuid,
                    ))
                    ? ["advanced"]
                    : []
                }
                headingLevel={4}
                items={[
                  {
                    content: (
                      <>
                        <label className="subfield">
                          Plex user
                          <input
                            className="b-plexuser"
                            onChange={(e) =>
                              patchBinding(d.uid, {
                                plexUser: e.target.value,
                              })
                            }
                            placeholder="e.g. Older Kids"
                            type="text"
                            value={d.plexUser}
                          />
                        </label>
                        <label className="subfield">
                          Account id
                          <input
                            className="b-accountid"
                            inputMode="numeric"
                            onChange={(e) =>
                              patchBinding(d.uid, {
                                accountId: e.target.value,
                              })
                            }
                            placeholder="e.g. 22222222"
                            type="text"
                            value={d.accountId}
                          />
                        </label>
                        <label className="subfield">
                          User uuid
                          <input
                            className="b-useruuid"
                            onChange={(e) =>
                              patchBinding(d.uid, {
                                userUuid: e.target.value,
                              })
                            }
                            placeholder="e.g. 2222222222222222"
                            type="text"
                            value={d.userUuid}
                          />
                        </label>
                      </>
                    ),
                    key: "advanced",
                    label:
                      "Advanced — set the account mapping by hand",
                  },
                ]}
                key={profiles.length}
                onChange={(keys) =>
                  patchBinding(d.uid, {
                    isAdvancedOpen:
                      keys.includes("advanced"),
                  })
                }
              />
              <fieldset className="field">
                <legend>Allowed ratings (shows)</legend>
                <div className="b-ratings libs">
                  {/* Keyed on the BINDING, whose ratings are re-scoped from Plex when its
                      profile or the channel's libraries change — a second writer the user
                      never touched. Not keyed on the checked set, which their own click
                      writes. */}
                  {d.showOptions.map((r) => (
                    <Checkbox
                      isChecked={d.showChecked.includes(r)}
                      key={`${d.uid}:${r}`}
                      label={r}
                      onChange={(isChecked) =>
                        patchBinding(d.uid, {
                          showChecked: isChecked
                            ? [...d.showChecked, r]
                            : d.showChecked.filter(
                                (x) => x !== r,
                              ),
                        })
                      }
                      size="sm"
                      value={r}
                    />
                  ))}
                </div>
              </fieldset>
              <fieldset className="field">
                <legend>Movie ratings</legend>
                <div className="b-mratings libs">
                  {/* Keyed on the BINDING, whose ratings are re-scoped from Plex when its
                      profile or the channel's libraries change — a second writer the user
                      never touched. Not keyed on the checked set, which their own click
                      writes. */}
                  {d.movieOptions.map((r) => (
                    <Checkbox
                      isChecked={d.movieChecked.includes(r)}
                      key={`${d.uid}:${r}`}
                      label={r}
                      onChange={(isChecked) =>
                        patchBinding(d.uid, {
                          movieChecked: isChecked
                            ? [...d.movieChecked, r]
                            : d.movieChecked.filter(
                                (x) => x !== r,
                              ),
                        })
                      }
                      size="sm"
                      value={r}
                    />
                  ))}
                </div>
              </fieldset>
            </div>
          ))}
        </div>
        <button
          className="ghost addbinding"
          id="dyn-addprofile"
          onClick={() =>
            setBindings((prev) => [
              ...prev,
              toDraft({} as Binding, knownRef.current),
            ])
          }
          type="button"
        >
          + Add profile
        </button>
        {/* The default only means something with ≥2 bindings — with one profile there is
            nothing to pick between, and Play already lands on it. */}
        <label
          className="subfield"
          hidden={namedProfiles.length < 2}
          id="dyn-default-wrap"
        >
          Default profile
          {/* Keyed on modal-open identity like the other seeded selects here: the control
              is uncontrolled (value seeds defaultValue), so it must re-mount to pick up the
              value set when a channel is (re-)opened for editing. */}
          <SelectListbox
            id="dyn-default-profile"
            key={modalKey}
            label="Default profile"
            onChange={setDefaultProfile}
            options={namedProfiles.map((p) => ({
              label: p,
              value: p,
            }))}
            placeholder="— first profile —"
            value={
              namedProfiles.includes(defaultProfile)
                ? defaultProfile
                : ""
            }
          />
          <span className="subhint">
            The tier the Play and Channels dropdowns start
            on. Leave unset to use the first.
          </span>
        </label>
      </fieldset>

      <label className="field">
        Audio language
        <input
          id="dyn-audio"
          maxLength={8}
          onChange={(e) => setAudio(e.target.value)}
          placeholder="e.g. jpn, eng — blank = default"
          type="text"
          value={audio}
        />
      </label>
      <p className="idnote" id="dyn-idnote">
        {editing
          ? `id: ${setId} — immutable; HA / cards reference it. Renaming the label never breaks them.`
          : "A rule-based rotation. Playable the moment it is saved (and from HA by its new id); an NFC card needs its HA mapping added separately."}
      </p>
    </Modal>
  )
}

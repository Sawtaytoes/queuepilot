import {
  Accordion,
  Button,
  Checkbox,
  Field,
  FieldGroup,
} from "@charcuterie/ui"
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
import { CountPicker, type INFINITE } from "./CountPicker"
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
  /**
   * CARRIED, NOT EDITED. The rewatch excludes are per-BINDING, and this editor sends the
   * whole `profiles[]` array back — so a field it merely forgets is a field it deletes. It
   * renders no control for these (they live beside Blocked in the Pool-filters panel), so
   * the draft's only job is to hand them back untouched.
   */
  movieExcludes: string[]
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
  movieExcludes: b.movie_excludes || [],
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
  // Round-tripped, never edited here — see BindingDraft.movieExcludes.
  movie_excludes: d.movieExcludes,
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
  // PLAYBACK LENGTH — how many things this pool plays before it stops.
  //
  // There is no top-up checkbox any more: top-up is DERIVED from this (owner, 2026-08-17), on
  // exactly when the length exceeds one queue window. That removes the only combination that
  // could be wrong — Infinite with top-up off, which silently stops at 12.
  //
  // Holds the EFFECTIVE value, seeded from this set's own default rather than from null, so
  // the picker can chip that option Default instead of showing a number nobody chose. Storing
  // it back sparsely is the server's job, the same split the entry counts use.
  const [playbackLength, setPlaybackLength] = useState<
    number | typeof INFINITE
  >(LINEUP_FALLBACK.length)
  const [isPoweringOff, setIsPoweringOff] = useState(false)
  const [onComplete, setOnComplete] = useState("drop")
  // 'whole' | 'split' — what a Collection MEMBER contributes to this pool. Seeded from the
  // set's effective value, which the server always sends (never the absence it stores).
  const [collectionMembers, setCollectionMembers] =
    useState("whole")

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
    // A pool with no length of its own follows ITS KIND's default — show that number, not a
    // placeholder, because it is what the pool will actually play tonight. The server sends
    // the default per set, so the rule that picks it lives in one place.
    setPlaybackLength(
      editing?.length ??
        editing?.length_default ??
        lineup.length,
    )
    setIsPoweringOff(Boolean(editing?.power_off_when_done))
    setOnComplete(
      editing?.on_complete === "restart"
        ? "restart"
        : "drop",
    )
    setCollectionMembers(
      editing?.collection_members === "split"
        ? "split"
        : "whole",
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

    // No library gate. A channel that ticks nothing pools from EVERY video library
    // (decision `2026-08-17-no-libraries-checked-means-every-library`); the server stopped
    // rejecting it in the same change, so blocking it here would be the only thing left
    // standing between the owner and the behaviour the empty group promises.

    // Collect the bindings; drop empty cards. When ≥1 has data, send `profiles[]`
    // (the canonical shape); Node writes it and drops the legacy top-level fields.
    const collected = bindings
      .map(readBinding)
      .filter(hasData)

    // NOT IN THE BODY: `blocklist` and `movie_excludes`.
    //
    // This editor has no control for either — Blocked lives in the inline Pool-filters
    // panel and the rewatch excludes live beside it — so it never reads their stored
    // values into state. It used to send `blocklist: []` / `movie_excludes: []` anyway,
    // which on a CREATE is the right empty default and on an EDIT is silent data loss:
    // every Save from ⚙ Configure wiped every show the owner had excluded (reported
    // 2026-08-17, after the Lineup box gave him a reason to open this editor at all).
    //
    // Omitting a key is what leaves it alone — `updateSet` walks its allowlist with
    // `if (!(k in patch)) continue`, and `createSet` defaults both to []. So the same
    // body is correct on both paths, and the rule generalises: THIS EDITOR MAY ONLY SEND
    // A KEY IT RENDERS A CONTROL FOR. The lineup trio below is the other side of that
    // rule — it does render them, so it round-trips them rather than omitting them.
    const body: Record<string, unknown> = {
      audio_language: audio.trim(),
      behavior,
      item_sections: itemSections,
      kind: kind.trim() || "cartoons",
      label: name,
      // The server stores these SPARSELY — a length equal to THIS KIND's default, an
      // `on_complete: drop` and a `power_off_when_done: false` are all stored by absence —
      // which is what keeps this Save from writing keys that say nothing onto every pool it
      // touches. `refill` is deliberately NOT sent: saving a pool is what migrates it off the
      // deprecated flag and onto `length: infinite`.
      //
      // These ARE sent rather than omitted, which is the other side of the rule above: this
      // editor renders a control for each, so it owns their values and round-trips them.
      collection_members: collectionMembers,
      length: playbackLength,
      on_complete: onComplete,
      power_off_when_done: isPoweringOff,
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

    setStatus("Saving pool…")

    try {
      if (setId)
        await api("PATCH", `/api/sets/${setId}`, body)
      else await api("POST", "/api/sets", body)

      closeDynModal()
      setStatus(
        setId ? "Pool updated" : "Pool created",
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
        `Delete the “${name}” filtered pool?\n\n` +
          "This removes it permanently. Any NFC card or HA button set to play " +
          `"${setId}" will stop working until you repoint it — this app can't ` +
          "change Home Assistant.",
      )
    ) {
      return
    }

    setStatus("Deleting pool…")

    try {
      await api(
        "DELETE",
        `/api/sets/${encodeURIComponent(setId)}`,
      )
      closeDynModal()
      setStatus("Pool deleted", "ok")
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
          {/* THE FOOTER IS THREE CHARCUTERIE `Button`s, configured by props. Each one used to
            be a raw `<button>` wearing an app class, and `app.css` painted every skin by
            hand across five modals: `.modalbtns button` set the radius, the padding and the
            font, `[type="submit"]` painted the confirm accent, `.danger` painted the
            destructive one, and `#groupsmodal`/`#entrymodal` restated the accent under
            `.primary` because their confirms are click handlers rather than submits.

            ⚠️ `.ghost` is Charcuterie's `outline`, NOT its `ghost`. The app class sets a
            surface background AND a border, which is what `outline` means here; Charcuterie's
            `ghost` is the borderless one (`PlayMenu`'s rows). Matching on the NAME would have
            quietly flattened every secondary button in the app.
            (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`) */}
          <Button
            hidden={!editing}
            id="dyn-delete"
            intent="danger"
            onClick={() => void onDelete()}
          >
            Delete pool
          </Button>
          <span className="spacer" />
          <Button
            appearance="outline"
            id="dyn-cancel"
            intent="neutral"
            onClick={closeDynModal}
          >
            Cancel
          </Button>
          <Button
            id="dyn-save"
            intent="accent"
            type="submit"
          >
            Save
          </Button>
        </>
      }
      id="dynmodal"
      isOpen={Boolean(dynModal)}
      onClose={closeDynModal}
      onSubmit={() => void onSubmit()}
      title={
        editing
          ? `Configure “${editing.label}”`
          : "New filtered pool"
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
        {/* The three groups are ONE scope — a channel with nothing ticked anywhere pools
            from every video library (decision
            `2026-08-17-no-libraries-checked-means-every-library`). */}
        <p className="subhint" id="dyn-alllibs">
          {!showSections.length && !itemSections.length
            ? "Every video library — check a box to narrow it."
            : "Uncheck every box to pool from all of them."}
        </p>
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

      {/* PLAYBACK LENGTH — how many things this pool plays before it stops.

          Replaces the "Items queued ahead" knob that shipped hours earlier. That one named
          the QUEUE WINDOW, which is an implementation detail nobody sitting on the sofa has
          an opinion about; the question they actually have is "play some and stop", and the
          window is now just 12 with top-up behind it (owner, 2026-08-17).

          NOT hidden on a rewatch pool any more — that pool's hardcoded one-film-per-scan is
          exactly what this control now expresses, and making it configurable was the point
          ("Movies are gonna be 1 based on _my_ configuration today, but we _should_ be able
          to change that"). */}
      {/* A Charcuterie `FieldGroup`, configured by props — a `<fieldset>` + `<legend>` over
          SEVERAL controls, which is exactly what this box is. It replaces a hand-rolled
          `<fieldset className="field flags">`, whose `flags` class matched nothing here:
          the only rules for it are `#setmodal .flags…`, and this is `#dynmodal`, so the box
          never got the flex column, the gap or the margin it was asking for.
          (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`)

          `id`, not a `className` DOM handle: `FieldGroupProps` was a closed six-key type
          that forwarded nothing but `className`, so this box wore `dyn-lineup` as a class
          carrying no rule and the shot scripts took the class. `@charcuterie/ui@3.7.0`
          spreads the rest props onto the `<fieldset>` it owns, so the id reaches the element
          and the fake class is gone. */}
      <FieldGroup id="dyn-lineup" label="Playback">
        {/* A <div>+<span>, not a <label>: CountPicker is a group of BUTTONS, not an input, so
            a <label> would have no control to name. Same shape the set editor uses. */}
        <div className="field">
          <span className="fieldlbl">Playback length</span>
          <CountPicker
            defaultValue={
              editing?.length_default ?? lineup.length
            }
            hasInfinite
            id="dyn-length"
            label="Playback length"
            max={lineup.max}
            onChange={setPlaybackLength}
            presets={LINEUP_PRESET_COMMON}
            value={playbackLength}
          />
        </div>
        <p className="subhint" id="dyn-length-hint">
          {behavior === "rewatch"
            ? `How many films this pool plays before it stops. Each one is drawn least-watched-first
               and never twice in the same sitting.`
            : `How many episodes this pool plays before it stops. Infinite keeps going — it queues
               ${lineup.length} ahead and tops back up whenever ${lineup.topup_at} or fewer are left, so a
               card that is still playing never runs out.`}
        </p>
        {/* Charcuterie Checkbox is uncontrolled (isChecked seeds once), so it remounts with
            the modal — same treatment the set editor's flags get. */}
        <Checkbox
          id="dyn-power-off"
          isChecked={isPoweringOff}
          key={`${modalKey}-poweroff`}
          label="Turn everything off when it finishes"
          onChange={setIsPoweringOff}
        />
        <p className="subhint" id="dyn-power-off-hint">
          Starting a card wakes the room, so this is the
          other half of it. QueuePilot announces that the
          sitting ended and Home Assistant does the turning
          off — which is what lets the rule check who is
          still in the room. Nothing happens on an Infinite
          pool: it never finishes.
        </p>
        {/* A Charcuterie `Field`, configured by props: the label and the control, wired
            together by the component. It replaces a `<label className="field">` wrapping a
            `<SelectListbox className="fieldselect">`, and `fieldselect` matched nothing here
            — its one rule is `#setmodal .fieldselect`, and this is `#dynmodal` — so the
            trigger never had the 10px gutter that class asks for.
            (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`)

            `Field` CLONES onto its child, so this only works because `SelectListbox` is a
            pass-through — see the `SlotProps` note in that file. The `<label htmlFor>` now
            names the trigger's real `id`.

            **No `description`, deliberately.** `Field`'s hint slot renders `text-sm` /
            `content-secondary`, and the two hints directly above are `.subhint` (0.8rem,
            muted) — one of which belongs to a `Checkbox`, which has no description slot at
            all, so it CANNOT follow. Using the slot for this one control alone leaves a box
            with two hint typographies and the odd one in the middle. Moving this editor's
            hints onto Charcuterie's slots is worth doing; it is a uniform change across
            every modal, not a side effect of this one. */}
        <Field label="When a show has nothing left to watch">
          {/* Keyed on modal-open identity, same reason as the selects above. */}
          <SelectListbox
            id="dyn-on-complete"
            key={modalKey}
            label="When a show has nothing left to watch"
            onChange={setOnComplete}
            options={[
              {
                // NOT "it leaves this pool", which is what this said and what it does not do.
                // Nothing is written, nothing is deleted: a finished show simply has no
                // unwatched episodes to contribute, so no bucket is built for it (select.ts).
                // A filtered pool is recomputed from libraries every scan, so the show returns
                // by itself the moment a new episode lands. Removal is the CURATED queue's
                // `done` flag and its TTL sweep, which is a different mechanism on a different
                // kind of set.
                label:
                  "Let it finish — nothing plays from it",
                value: "drop",
              },
              {
                label: "Start it over from the beginning",
                value: "restart",
              },
            ]}
            value={onComplete}
          />
        </Field>
        <p className="subhint" id="dyn-on-complete-hint">
          Only fires when a show is genuinely finished — not
          when this lineup merely stopped drawing from it.
          Letting it finish is what every pool has always
          done: nothing is removed, and the show comes back
          on its own when a new episode lands. Starting over
          keeps a topped-up rotation from withering as the
          kids finish shows, and on a shorts-only pool it
          brings the whole library back around. Any single
          show can override this from the pool grid.
        </p>
      </FieldGroup>

      {/* WHAT A COLLECTION MEMBER CONTRIBUTES. Either way its shows leave the rule pool —
          that part is not a choice, it is the fix for a collection being listed twice. What
          IS a choice is whether the collection comes in as one ordered run or as its shows.

          Filtered pools only, which is where it lands by construction: this editor is the
          filtered-pool editor. Hidden on a rewatch pool for the same reason the Lineup box
          is — a rewatch pool draws from watch history, not from members, so the control
          would do nothing. */}
      {/* A Charcuterie `FieldGroup`, configured by props — the `<fieldset>` + `<legend>` this
          box hand-rolled, minus the `.field` class it borrowed. `#dynmodal .field` sets
          `display: block`, which cancels the component's own flex column; the 14px block
          rhythm comes from `#dynmodal fieldset`, an ELEMENT rule, so nothing is lost.
          (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`)

          `FieldGroup` and not `Field`, and the old comment here got the reason wrong twice.
          It said a `Field` would print the name a second time — it would not, because
          converting takes the `<legend>` with it — and it said `FieldProps` could not carry
          `hidden`, which `@charcuterie/ui@3.7.0` fixed. The real reason is the one the
          component's own docs give: `Field` CLONES onto one child, and this box holds two
          (the picker and its hint), so `hidden` and `id` would land on the picker instead of
          the box. `FieldGroup` wraps, so its props are the `<fieldset>`'s.

          No `className="fieldselect"` either. Its one rule is `#setmodal .fieldselect`, so on
          this modal it was decoration — and there is nothing to restore, because a trigger
          that starts a block-level line after a `<legend>` never wanted a 10px inline-start
          gutter in the first place. */}
      <FieldGroup
        hidden={behavior === "rewatch"}
        id="dyn-collections"
        label="Preferred queued items"
      >
        <SelectListbox
          id="dyn-collection-members"
          key={modalKey}
          label="Preferred queued items"
          onChange={setCollectionMembers}
          options={[
            {
              label: "Use collections",
              value: "whole",
            },
            {
              label: "Don't use collections",
              value: "split",
            },
          ]}
          value={collectionMembers}
        />
        <p
          className="subhint"
          id="dyn-collection-members-hint"
        >
          {collectionMembers === "split"
            ? "A collection you add as a member comes in as its individual shows, each taking its own turn in the rotation — the same way a show you added by hand does."
            : "A collection you add as a member plays through in its own order, one item per turn, and its shows stop coming up separately. Pick the other option to have them take their own turns instead."}
        </p>
      </FieldGroup>

      <fieldset className="field" id="dyn-profilesbox">
        <legend>Profiles &amp; ratings</legend>
        <p className="subhint">
          One or more Plex Home profiles this pool plays
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
                {/* `.ghost` is Charcuterie's `outline`; `size="sm"` is what
                    `#dynmodal .binding .b-remove`'s 6px/12px and 0.82rem were asking for.
                    The `b-remove` class STAYS and now carries only layout — `flex: none`,
                    `align-self: flex-end` and the danger-tinted hover, which is a state this
                    control has and `intent="neutral"` does not describe. */}
                <Button
                  appearance="outline"
                  aria-label="Remove this profile"
                  className="b-remove"
                  /* A channel keeps ≥1 binding, so the button only exists once
                     there is more than one card. */
                  hidden={bindings.length <= 1}
                  intent="neutral"
                  onClick={() =>
                    setBindings((prev) =>
                      prev.filter((x) => x.uid !== d.uid),
                    )
                  }
                  size="sm"
                >
                  Remove
                </Button>
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
        {/* `.ghost` is Charcuterie's `outline`. `addbinding` keeps its `margin-top: 12px`
            (app layout); its padding, radius and font-size are the component's now, and its
            hand-rolled `:focus-visible` outline is deleted — `Button` brings its own, and the
            app's version fired on `:focus` semantics the token system already settled. */}
        <Button
          appearance="outline"
          className="addbinding"
          id="dyn-addprofile"
          intent="neutral"
          onClick={() =>
            setBindings((prev) => [
              ...prev,
              toDraft({} as Binding, knownRef.current),
            ])
          }
        >
          + Add profile
        </Button>
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
            The tier the Play and Pools dropdowns start on.
            Leave unset to use the first.
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

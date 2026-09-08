import { Button, Checkbox } from "@charcuterie/ui"
import { useEffect, useMemo, useState } from "react"

import { api } from "../lib/api"
import { fetchProfiles } from "../lib/channels"
import {
  COMPLETION_MODE_HINTS,
  COMPLETION_MODE_LABELS,
  COMPLETION_MODES,
  type CompletionMode,
  completionFlagsFor,
  completionModeOf,
} from "../lib/completionMode"
import { SET_LENGTH_PRESETS } from "../lib/countPicker"
import { normalizeAddAs } from "../lib/kind"
import {
  clampDay,
  dayOptions,
  monthOptions,
} from "../lib/monthDay"
import { ACTIVITY_LABELS, queueTitle } from "../lib/people"
import {
  parseSeasonDay,
  seasonDayValue,
} from "../lib/season"
import type {
  Activity,
  Profile,
  ProviderBlockValue,
  ProviderInfo,
  QueueMember,
} from "../lib/types"
import {
  closeSetModal,
  useOverlays,
} from "../state/overlays"
import { saveQueuePeople, usePeople } from "../state/people"
import { load, setStatus, useStore } from "../state/store"
import { CountPicker, type INFINITE } from "./CountPicker"
import { EPISODES_MAX } from "./EntrySettings"
import { Modal } from "./Modal"
import { PeopleTrays } from "./PeopleTrays"
import { ProviderBlock } from "./ProviderBlock"
import { SelectListbox } from "./SelectListbox"

/**
 * Create / edit a curated set. Create: empty; edit: prefilled + rename/delete.
 *
 * Both options are a Picks queue. The Type control picks the default lane (`add_as`:
 * priority vs random). Product `kind` is always `picks`
 * (decision `2026-08-23-kind-is-picks-or-rules`).
 *
 * The id is immutable and NFC cards / HA reference it, so the note says so on both
 * paths — renaming the label never breaks a card.
 * (decision `2026-07-21-sets-registry-immutable-ids`)
 *
 * Queue consumption flags are editable here rather than hand-YAML only
 * (decision `2026-08-08-set-modal-queue-flags`). The two that answer the SAME question —
 * `keep_completed` and `reel` — are ONE four-value `Picker` as of 2026-09-08, which is also
 * where `restart_when_exhausted` lives (decision
 * `2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes`). `remove_completed_after`
 * is a different question and keeps its own row.
 *
 * `batch_stops_at` is the set-wide default for WHERE a multi-episode batch may stop; an
 * individual entry can override it from the queue view.
 */
/** A block plus a stable client-only identity; `uid` never reaches the server. */
type EditableBlock = ProviderBlockValue & { uid: string }

let uidSeq = 0
const newUid = () => {
  uidSeq += 1

  return `blk-${uidSeq}`
}

/**
 * The month half of the seasonal reset date. Value is the 1-based month number as a string;
 * `""` is OFF, which is what every queue written before 2026-09-08 means.
 *
 * Named months, not numbers: "11" is 1 November here and 11 January in half the world, and
 * this is the one setting whose value is next read a year after it was chosen. The list itself
 * is `lib/monthDay.ts`, which is also what the season row below and the calendar view read —
 * three copies of it is three chances for one to offer 31 February.
 */
const RESET_MONTH_OPTIONS = monthOptions({
  emptyLabel: "Never — this queue does not reset",
  isLongName: true,
})

/** The season row's months, in the short spelling: four pickers share one line there. */
const SEASON_MONTH_OPTIONS = monthOptions({
  emptyLabel: "—",
})

export function SetModal() {
  const { setModal } = useOverlays()
  const { data, reg } = useStore()

  const setId = setModal?.setId ?? null
  const editing = useMemo(
    () =>
      setId
        ? (reg?.sets.find((s) => s.id === setId) ?? null)
        : null,
    [reg, setId],
  )

  /*
   * A NEW SET JOINS NO GROUP, as of 2026-08-26.
   *
   * It used to join whichever group was on screen behind this modal, read off the URL —
   * `/g/<id>` was the one truth about which group was active, and creating from a group page
   * and landing in All was a reported bug. There is no group page any more: the landing
   * filters by PEOPLE, in the query string, and a filter is not a claim about where a thing
   * belongs (decision `2026-08-26-the-landing-filters-by-people-and-the-group-chips-go`).
   * Filing a new queue into every person you happened to have ticked would be exactly the
   * failure the old rule's own comment warned about, one control over.
   *
   * `POST /api/sets` still ACCEPTS a `group`, and `fileSetIntoGroup` is still gated by
   * `groups-test.ts`. Nothing about the server changed — the browser simply has nothing to
   * name. A queue gets its audience from the list in the editor below this.
   */

  const [label, setLabel] = useState("")
  /** Default lane for new entries: priority | random. Product kind is always picks. */
  const [addAs, setAddAs] = useState<"priority" | "random">(
    "priority",
  )
  const [requiresProfile, setRequiresProfile] = useState("")
  /**
   * WP-5. What you are DOING with this queue. Seeded from the EFFECTIVE value, so the control
   * shows the provider's answer for a queue that has never overridden it and the person
   * editing never has to know which of the two they are looking at.
   */
  const [activity, setActivity] =
    useState<Activity>("watching")
  /**
   * ONE question about completion, four answers — never two booleans where one force-disables
   * the other, which is a four-state control drawn as two two-state ones
   * (decision `2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes`).
   *
   * The three booleans are still what goes on disk. `lib/completionMode.ts` owns the
   * translation both ways, so nothing here re-derives it.
   */
  const [completionMode, setCompletionMode] =
    useState<CompletionMode>("consume")
  const [watchHistory, setWatchHistory] = useState<
    "provider" | "queue"
  >("provider")
  const [removeCompletedAfter, setRemoveCompletedAfter] =
    useState("")
  /**
   * THE SEASONAL RESET DATE — the day each year this queue clears its own watched state.
   * Held as two pieces because that is what a person picks, and joined into the stored
   * `MM-DD` only on Save
   * (decision `2026-09-08-a-queue-can-clear-its-own-watched-state-on-a-date-each-year`).
   *
   * A blank month is OFF, which is what every queue written before this control means. The
   * day is never blank on its own: choosing a month seeds it to 1, so the pair can never be
   * half a date.
   */
  const [resetMonth, setResetMonth] = useState("")
  const [resetDay, setResetDay] = useState("1")
  /**
   * How long a PROMOTED entry stays led-out before it may lead again.
   *
   * Free text rather than a preset list, and that is the point of the control: the right
   * number is a property of WHEN this queue is watched, not a value a menu can guess. A
   * sitting that runs past midnight stamps its lead after midnight, so a flat 24h puts the
   * next eligible time LATER on the clock than the following night's scan and the promote
   * skips a night. Blank follows the 16h product default, which is short enough that an
   * ordinary evening always clears it.
   * (decision `2026-08-26-the-promote-window-is-a-queue-setting`)
   */
  const [promoteWindow, setPromoteWindow] = useState("")
  /**
   * THE SEASON WINDOW — a start date and an end date that repeat every year. Out of season the
   * queue is unavailable, and that is ALL it does: it clears nothing and marks nothing
   * (decision `2026-09-08-a-season-window-gates-the-existing-enabled-flag`).
   *
   * Four controls rather than one date field, and neither half is a preference. A DATE input
   * carries a YEAR, which is a lie the first time the window rolls over; and a native picker
   * paints as the OS widget, which is the whole reason this app has no `<select>` left.
   *
   * Held as four strings so the picker seeds are ordinary option values. Blanking either MONTH
   * clears the window, which is how a seasonal queue becomes an all-year one again.
   */
  const [seasonStartMonth, setSeasonStartMonth] =
    useState("")
  const [seasonStartDay, setSeasonStartDay] = useState("")
  const [seasonEndMonth, setSeasonEndMonth] = useState("")
  const [seasonEndDay, setSeasonEndDay] = useState("")
  const [batchStopsAt, setBatchStopsAt] = useState("none")
  // This queue's default batch. 1 is the engine default everywhere, and the point of the
  // control is that the right number differs per queue — one episode for TV, three chapters
  // for a reading queue — not that reading queues get a different global.
  const [episodes, setEpisodes] = useState(1)
  // Volumes are not chapters. Independent count, default 1 — a queue at 3 chapters
  // must not dump 3 whole manga volumes into one visit.
  const [volumes, setVolumes] = useState(1)
  // PLAYBACK LENGTH — how many things this queue plays before it stops. On an ORDERED queue
  // that is counted in ENTRIES: one entry is the film at the top, or a show entry's own
  // `episodes:` batch, which is why the default of 1 is exactly what this queue does today.
  const [playbackLength, setPlaybackLength] = useState<
    number | typeof INFINITE
  >(1)
  const [isPoweringOff, setIsPoweringOff] = useState(false)
  const [profiles, setProfiles] = useState<Profile[]>([])
  // The repeating {provider, profile, libraries} blocks. Always a list — a set written
  // before blocks existed arrives as the single implicit Plex block it has always meant, so
  // there is no legacy shape to special-case here.
  //
  // `uid` is client-only and never persisted. It exists because the array index is NOT a
  // usable React key here: removing a middle block shifts every index after it, so React
  // would reuse the wrong component instance and each surviving block would show the
  // library list it had already fetched for a different provider.
  const [blocks, setBlocks] = useState<EditableBlock[]>([])
  const [providers, setProviders] = useState<
    ProviderInfo[]
  >([])

  // Identity of the open modal instance — used to remount uncontrolled Charcuterie
  // controls (Checkbox/SelectListbox seed only on mount). Keyed on openness, never on
  // the values the user is currently editing (decision
  // `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`).
  const modalKey = setModal ? (setId ?? "new") : "closed"

  // WP-5. The roster and this queue's audience. Its own slice, so an audience move re-renders
  // the editor and not every shelf poster behind it.
  const people = usePeople()
  const members = setId ? (people.byQueue[setId] ?? []) : []

  /** Save the audience as it moves, rather than on Submit.
   *
   * Deliberately NOT folded into `onSubmit`: a move that only takes effect on Save reads as a
   * move that failed, and the write is its own idempotent endpoint. `saveQueuePeople` is
   * optimistic and snaps back on a refusal — an unknown member, or a group offering two
   * provider profiles — so the screen never ends up disagreeing with the store. */
  const onPeopleChange = async (next: QueueMember[]) => {
    if (!setId) return
    try {
      await saveQueuePeople(setId, next)
    } catch (e) {
      setStatus(
        `Could not move them: ${(e as Error).message}`,
        "err",
      )
    }
  }

  useEffect(() => {
    if (!setModal) return

    // The TYPED name only. `editing.label` falls back to the id, so seeding from it would
    // pre-fill a nameless queue's input with `movies_shows` and the next Save would store
    // that slug as its name.
    setLabel(
      editing?.has_explicit_label ? editing.label : "",
    )
    const nextAddAs = editing
      ? normalizeAddAs(editing.add_as, {
          kind: editing.kind,
          source: editing.source,
        })
      : (setModal.presetAddAs ?? "priority")
    setAddAs(nextAddAs)
    setRequiresProfile(
      editing ? editing.requires_profile || "" : "",
    )
    setActivity(editing?.activity ?? "watching")
    setCompletionMode(completionModeOf(editing))
    setWatchHistory(editing?.watch_history ?? "provider")
    setBatchStopsAt(
      editing ? editing.batch_stops_at || "none" : "none",
    )
    setEpisodes(editing?.episodes ?? 1)
    setVolumes(editing?.volumes ?? 1)
    setPlaybackLength(
      editing?.length ?? editing?.length_default ?? 1,
    )
    setIsPoweringOff(Boolean(editing?.power_off_when_done))
    // Prefill: edit uses the stored TTL; a new priority picks queue defaults to 24h
    // (matches the seeded movie queues in sets.yaml). Random-pool picks stay blank =
    // keep forever (legacy anime).
    if (editing) {
      setRemoveCompletedAfter(
        editing.remove_completed_after || "",
      )
    } else {
      setRemoveCompletedAfter(
        nextAddAs === "random" ? "" : "24h",
      )
    }
    // The seasonal reset is OFF on a new queue and on every queue that has never carried the
    // key — an off queue must behave exactly as it does today. Split back into the two
    // controls; a stored value is always `MM-DD`, and anything else the server refused to
    // write, so a bad split is not reachable.
    const storedReset = (
      editing?.reset_watched_on || ""
    ).split("-")
    setResetMonth(
      storedReset.length === 2
        ? String(Number(storedReset[0]))
        : "",
    )
    setResetDay(
      storedReset.length === 2
        ? String(Number(storedReset[1]))
        : "1",
    )
    // No create-time default: a blank window IS the 16h product default, and seeding "16h"
    // here would write the key onto every new queue and make the sparse file lie about
    // which queues have an opinion.
    setPromoteWindow(editing?.promote_window || "")
    // No create-time default either: a queue is available all year until somebody says
    // otherwise, and seeding a window here would make every new queue seasonal.
    const startDay = parseSeasonDay(editing?.season_start)
    const endDay = parseSeasonDay(editing?.season_end)
    setSeasonStartMonth(
      startDay ? String(startDay.month) : "",
    )
    setSeasonStartDay(startDay ? String(startDay.day) : "")
    setSeasonEndMonth(endDay ? String(endDay.month) : "")
    setSeasonEndDay(endDay ? String(endDay.day) : "")
    // Seed the blocks. An existing set always reports at least one (the implicit Plex block
    // for a pre-blocks set); a NEW set starts with one block on the first configured
    // provider, so creating a queue is exactly as many clicks as it was before.
    setBlocks(
      editing?.providers?.length
        ? editing.providers.map((b) => ({
            libraries: [...b.libraries],
            profile: b.profile ?? "",
            provider: b.provider,
            uid: newUid(),
          }))
        : [
            {
              // A queue created FOR an item starts with that item's library ticked, so the
              // add that follows has somewhere to land. Empty for every other opener.
              libraries: setModal.presetLibraries ?? [],
              profile: "",
              provider: "",
              uid: newUid(),
            },
          ],
    )
    void fetchProfiles().then(setProfiles)
    void api<{ providers: ProviderInfo[] }>(
      "GET",
      "/api/providers",
    )
      .then((r) => {
        const list = (r.providers ?? []).filter(
          (p) => p.supported && p.configured,
        )
        setProviders(list)
        // A new set has no provider yet; default it to the first configured one rather
        // than leaving an empty block that cannot fetch libraries.
        setBlocks((prev) =>
          prev.map((b) =>
            b.provider
              ? b
              : { ...b, provider: list[0]?.id ?? "plex" },
          ),
        )
      })
      .catch(() => setProviders([]))
    // Only re-seed when the modal is (re-)opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setModal])

  // The DAY options for the chosen month. February offers 29; a month nobody has chosen offers
  // the full 31 so the disabled control is not also empty.
  const resetDayOptions = useMemo(
    () => dayOptions(resetMonth),
    [resetMonth],
  )

  // Choosing a month is the DAY's second writer: February cannot hold the 31 January left
  // behind. Clamp here rather than in render, so the day picker's remount (keyed on the
  // month) seeds from a value that is already valid.
  const onResetMonthChange = (value: string) => {
    setResetMonth(value)
    if (!value) return
    setResetDay(clampDay(value, resetDay))
  }

  // Profile-gate options. The play gate matches the PMS-log stamp: managed users stamp
  // their title, the owner stamps the plex.tv username. Blank = ungated. A current hand-set
  // value that is no longer a live profile is kept as its own option so an edit never
  // silently drops it.
  const profileOptions = useMemo(() => {
    const opts = [
      { label: "Any — no profile lock", value: "" },
      ...profiles.map((p) => ({
        label: p.admin ? `${p.name} (owner)` : p.name,
        value: p.admin ? p.username || p.name : p.name,
      })),
    ]
    if (
      requiresProfile &&
      !opts.some((o) => o.value === requiresProfile)
    ) {
      opts.push({
        label: `${requiresProfile} (current)`,
        value: requiresProfile,
      })
    }
    return opts
  }, [profiles, requiresProfile])

  /**
   * The profile options for one block, scoped to ITS provider.
   *
   * Plex's are the Plex Home profiles the registry already knows. A pull provider's
   * "profile" is whoever owns the configured API key, so there is exactly one and it is not
   * a choice — offering a picker there would imply a freedom that does not exist. Both are
   * driven off `delivery`, never off the provider's name.
   */
  const profileOptionsFor = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId)

    if (p && p.delivery === "pull") {
      return [
        {
          label: `The ${p.label} account this app is connected as`,
          value: "",
        },
      ]
    }

    return profileOptions
  }

  // Does this queue draw from Plex at all? Drives the Plex-only knobs below. Keyed on
  // `delivery` rather than the provider id, so a future push backend behaves correctly
  // without another edit here.
  const hasPlexSource = blocks.some(
    (b) =>
      providers.find((p) => p.id === b.provider)
        ?.delivery !== "pull",
  )

  // The words this queue's medium is described in, taken from the block being edited rather
  // than from the saved set — so switching the source repaints the copy immediately, before
  // anything is written. Plex's words are the fallback, which is what every queue said before
  // providers carried a vocabulary at all.
  const vocab = (blocks[0]
    ? providers.find((p) => p.id === blocks[0].provider)
        ?.vocabulary
    : null) ?? {
    done: "watched",
    member: "show",
    name: "Plex",
    unit: "episode",
    units: "episodes",
    verb: "Play",
  }

  const onSubmit = async () => {
    // No name gate. An empty Name is a legitimate save: the queue is then called after its
    // ACTIVITY, and the server seeds its immutable id from the activity too
    // (decision `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`). On an EDIT
    // it clears the stored name; `PATCH /api/sets/:id` deletes the `label:` line rather than
    // storing a blank.
    const name = label.trim()

    // A block with NO library ticked is valid and means every library the source has
    // (decision `2026-08-17-no-libraries-checked-means-every-library`). This used to be a
    // save gate, which forced a scope onto queues that wanted the whole shelf — the
    // Board Game Picker case, where ticking every box narrowed the search to a category
    // and lost every uncategorised game.

    // The completion picker is ONE value on screen and THREE booleans on the wire, which is
    // the same pair of keys this modal has always posted plus one more beside them. Storage
    // did not change, so nothing migrates and a hand-edited `sets.yaml` keeps working.
    // A SINGLE Plex block is written back through the legacy `sections` /
    // `requires_profile` fields rather than as a `providers:` list. That keeps every
    // existing set byte-identical on disk after an unrelated edit — the block shape only
    // appears once it is actually needed, which is what makes this additive rather than a
    // migration that rewrites everyone's config the first time they rename a queue.
    const isLegacyShape =
      blocks.length === 1 && blocks[0].provider === "plex"

    const body = {
      kind: "picks" as const,
      // WP-5. Sent as the EFFECTIVE value and stored SPARSELY by the writer: a value equal
      // to the provider's own answer drops the key rather than freezing today's
      // provider→activity opinion into `sets.yaml`. So a plain rename still writes no
      // `activity:` line.
      activity,
      add_as: addAs,
      label: name,
      // `sections` stays in sync with the PLEX blocks' libraries even when blocks are
      // written, because the engine's curated/rotation readers still resolve Plex through
      // `queue_sections` / `episodic_sections`, which derive from this field. Letting the
      // two disagree would leave a set whose editor says one thing and whose playback does
      // another — the exact silent-divergence class that `requires_profile` already taught
      // this codebase to avoid.
      sections: isLegacyShape
        ? blocks[0].libraries.map(Number)
        : [
            ...new Set(
              blocks
                .filter((b) => b.provider === "plex")
                .flatMap((b) => b.libraries.map(Number)),
            ),
          ],
      requires_profile: isLegacyShape
        ? blocks[0].profile
        : requiresProfile,
      ...completionFlagsFor(completionMode),
      watch_history: watchHistory,
      // Empty string clears the TTL (keep forever). Explicit never/0 also clears server-side.
      remove_completed_after: removeCompletedAfter.trim(),
      // `MM-DD`, or an empty string for "this queue does not reset" — which drops the key
      // server-side, so a queue that never touched the control stays byte-identical on disk.
      reset_watched_on: resetMonth
        ? `${resetMonth.padStart(2, "0")}-${resetDay.padStart(2, "0")}`
        : "",
      // Empty string drops the key and falls back to the 16h product default; `never`/`0`
      // clears it to "no window", which means a promoted entry may lead every sitting.
      promote_window: promoteWindow.trim(),
      // Sent as a PAIR, always both, because the pair rule lives on the writer: it refuses a
      // half-written window by name rather than guessing an open end. Two blanks clear it.
      season_start: seasonDayValue(
        seasonStartMonth,
        seasonStartDay,
      ),
      season_end: seasonDayValue(
        seasonEndMonth,
        seasonEndDay,
      ),
      // "none" is the engine default, so it is stored as the absence of the key.
      batch_stops_at: batchStopsAt,
      // Likewise 1 — the server drops the key at <= 1, so a queue that never touched this
      // control stays byte-identical on disk.
      episodes,
      volumes,
      // Stored sparsely against THIS kind's own default, so a queue that never touched the
      // control gains no key. `power_off_when_done` is likewise absent unless it is on.
      length: playbackLength,
      power_off_when_done: isPoweringOff,
      // An empty list drops the key server-side, which is how the single-Plex-block case
      // stays on the legacy shape above.
      providers: isLegacyShape
        ? []
        : blocks.map(({ uid: _uid, ...b }) => b),
    }

    try {
      const word =
        addAs === "random"
          ? "Picks queue (random)"
          : "Picks queue (priority)"

      if (setId) {
        await api("PATCH", `/api/sets/${setId}`, body)
        closeSetModal()
        setStatus(`${word} updated`, "ok")
        await load()

        return
      }

      const made = await api<{ id: string }>(
        "POST",
        "/api/sets",
        body,
      )

      /*
        Whoever asked for this queue gets told which one it is, BEFORE the modal state is
        cleared. The Pending screen's "New queue…" adds the item that prompted it; nothing
        else passes a callback, so nothing else changes.
      */
      setModal?.onCreated?.(made.id)
      closeSetModal()
      setStatus(`${word} created`, "ok")
      await load()
    } catch (err) {
      setStatus(
        `Save failed: ${(err as Error).message}`,
        "err",
      )
    }
  }

  const onDelete = async () => {
    if (!editing || !setId) return

    const n = (data?.sets[setId]?.items || []).length

    if (
      !confirm(
        `Delete “${queueTitle(editing, null)}”${n ? ` and its ${n} entries` : ""}? This cannot be undone.`,
      )
    ) {
      return
    }

    try {
      await api("DELETE", `/api/sets/${setId}`)
      closeSetModal()
      setStatus("Queue deleted", "ok")
      await load()
    } catch (e) {
      setStatus(
        `Delete failed: ${(e as Error).message}`,
        "err",
      )
    }
  }

  return (
    <Modal
      footer={
        <>
          {/* THE FOOTER IS THREE CHARCUTERIE `Button`s, configured by props. Each one used to
            be a raw `<button>` wearing an app class, and `app.css` painted every skin by
            hand across five modals: `.modalbtns button` set the radius, the padding and the
            font, `[type="submit"]` painted the confirm accent, `.danger` painted the
            destructive one, and a modal-specific rule restated the accent under `.primary`
            because those confirms are click handlers rather than submits.

            ⚠️ `.ghost` is Charcuterie's `outline`, NOT its `ghost`. The app class sets a
            surface background AND a border, which is what `outline` means here; Charcuterie's
            `ghost` is the borderless one (`PlayMenu`'s rows). Matching on the NAME would have
            quietly flattened every secondary button in the app.
            (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`) */}
          <Button
            hidden={!editing}
            id="set-delete"
            intent="danger"
            onClick={() => void onDelete()}
          >
            Delete queue
          </Button>
          <span className="spacer" />
          <Button
            appearance="outline"
            id="set-cancel"
            intent="neutral"
            onClick={closeSetModal}
          >
            Cancel
          </Button>
          <Button
            id="set-save"
            intent="accent"
            type="submit"
          >
            Save
          </Button>
        </>
      }
      // The editor wears the source being edited, so the selected "Kavita" chip in the
      // Source-app control comes out Kavita-green instead of Plex amber — which is the exact
      // thing that read wrong: a segmented control whose Kavita option was painted in Plex's
      // brand. Taken from the LIVE block, so it repaints the moment the source is switched.
      dataProvider={
        (blocks[0]
          ? providers.find(
              (p) => p.id === blocks[0].provider,
            )?.kind
          : null) || undefined
      }
      id="setmodal"
      isOpen={Boolean(setModal)}
      onClose={closeSetModal}
      onSubmit={() => void onSubmit()}
      title={
        editing
          ? `Edit “${queueTitle(editing, null)}”`
          : "New picks queue"
      }
      titleId="setmodal-title"
    >
      {/* THE NAME IS OPTIONAL, and the hint says exactly what an empty one does rather than
          leaving the editor contradicting the page behind it. A queue with a name is called
          that everywhere; a queue without one is called after its ACTIVITY, numbered only
          when two nameless ones would read identically, and the faces below say which is
          which (decision
          `2026-08-26-a-queue-name-is-optional-and-the-activity-fills-in`).

          NOT `required`, as of 2026-08-26. It was, because the queue's immutable id is
          slugged from it at create — the server seeds that from the ACTIVITY now when
          nothing is typed, so the one thing the field was load-bearing for has another
          answer. Clearing it on an edit deletes the `label:` line rather than storing a
          blank.

          The owner kept the right to type one and uses it: *"If I want to customize queue
          names, I can. And in this case, I've already customized my one Kavita queue."* */}
      <label className="field">
        Name
        <input
          id="set-label"
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Movies & Shows"
          type="text"
          value={label}
        />
      </label>
      <p className="subhint" id="set-label-hint">
        Optional. Leave it empty and this queue is called
        after its activity — the faces below are what tell
        two of them apart. A name you do type is used
        everywhere, and is what the config file carries.
      </p>
      <label className="field">
        Type
        {/* Keyed on OPENNESS, because this modal never unmounts — `<SetModal />`
            sits at App level all the time and only toggles `isOpen`, so a plain
            `defaultValue` would be seeded once at first paint and then keep
            whatever the previous open left behind. The re-seed is an effect on
            `[setModal]`; the key cycles through `"closed"` on every close, so the
            control remounts in lockstep with it. Not keyed on `kind`, which the
            user's own pick writes. */}
        <SelectListbox
          className="fieldselect"
          id="set-kind"
          key={modalKey}
          label="Type"
          onChange={(v) =>
            setAddAs(v === "random" ? "random" : "priority")
          }
          options={[
            {
              // Both are Picks. The value is the default lane (`add_as`)
              // (decision `2026-08-23-kind-is-picks-or-rules`).
              label:
                "Picks — priority by default (top plays next)",
              value: "priority",
            },
            {
              label: "Picks — random by default",
              value: "random",
            },
          ]}
          value={addAs}
        />
      </label>
      {/* ── WHO IS THIS QUEUE FOR ────────────────────────────────────────────────────
          One vertical audience list, with the whole house visible in three ordered sections.
          People groups show their own rule beside the queue placement.

          EDIT ONLY, and that is a real constraint rather than a shortcut: `queue_people` is
          keyed on the set id, and a set being created has not got one yet. The two-write
          alternative — POST the set, then PUT its people — half-fails exactly the way
          `POST /api/sets`' own comment describes, leaving a queue that exists and belongs to
          nobody. A new queue is created, then filed, which is one extra step on the rarest
          path.

          There is NO NAME CONTROL here. The mockup drew "Name it for me" / "I will name it",
          a written-name preview and a revert control in all three options, and none of them
          ship: the name is the activity and the people are the badges
          (decision `2026-08-25-a-queue-is-people-plus-an-activity` §4). */}
      {editing ? (
        <div className="setpeople" id="set-people">
          <p className="fieldlabel">
            Who is this queue for
          </p>
          <PeopleTrays
            groups={people.groups}
            members={members}
            onChange={(next) => {
              void onPeopleChange(next)
            }}
            people={people.people}
          />
        </div>
      ) : null}
      <label className="field">
        Activity
        {/* WHAT YOU ARE DOING, and the queue's whole name. Four options — Movies & Shows is
            ONE of them, because "Anime" and "Movies" are two queues under one activity, told
            apart by what is in them (decision §1). Never a native `<select>`: this repo bans
            one by lint and has never had a call site. */}
        <SelectListbox
          className="fieldselect"
          id="set-activity"
          key={modalKey}
          label="Activity"
          onChange={(v) => setActivity(v as Activity)}
          options={(
            Object.keys(ACTIVITY_LABELS) as Activity[]
          ).map((value) => ({
            label:
              ACTIVITY_LABELS[value] +
              (editing && value === editing.activity_default
                ? " (default for this source)"
                : ""),
            value,
          }))}
          value={activity}
        />
      </label>
      {/* The repeating source blocks. Everyday fields first (source, profile, libraries);
          playlist/reel/TTL sit below as advanced options so a normal edit doesn't scroll
          past them. (decision `2026-08-13-provider-block-repeats-and-picks-its-control`) */}
      <div id="set-blocks">
        {blocks.map((b, i) => (
          <ProviderBlock
            block={b}
            canRemove={blocks.length > 1}
            index={i}
            key={b.uid}
            onChange={(next) =>
              setBlocks((prev) => {
                const changedProvider =
                  next.provider !== prev[i].provider

                return prev.map((x, j) => {
                  // Carry the uid across: ProviderBlock speaks the WIRE shape and knows
                  // nothing about this component's identity bookkeeping.
                  if (j === i)
                    return { ...next, uid: x.uid }

                  // A QUEUE DRAWS FROM EXACTLY ONE PROVIDER (decision
                  // 2026-08-13-a-queue-draws-from-exactly-one-provider), so switching the
                  // provider on one block switches them all. Without this the editor happily
                  // builds a mixed queue that then behaves as Plex everywhere and silently
                  // ignores its Kavita libraries — which is exactly how the live
                  // "Manga & Webtoons" channel ended up half-configured.
                  //
                  // The other blocks' libraries and profiles are scoped to the OLD provider,
                  // so they are cleared rather than reinterpreted against the new one.
                  if (!changedProvider) return x

                  return {
                    ...x,
                    libraries: [],
                    profile: "",
                    provider: next.provider,
                  }
                })
              })
            }
            onRemove={() =>
              setBlocks((prev) =>
                prev.filter((_, j) => j !== i),
              )
            }
            profileOptionsFor={profileOptionsFor}
            providers={providers}
          />
        ))}
      </div>
      {/* "+ Add another source" is GONE (decision
          `2026-08-15-a-queue-has-one-source-so-the-add-source-button-is-gone`). A second
          block could never do anything: the engine reads no block's `profile` — only
          `resolveSingle().provider` and `.libraries` — and a second block's libraries were
          simply unioned into the same `sections` list, which is what more checkboxes on the
          first block already do. The two-Plex-profiles case the 2026-08-13 decision kept it
          for was never implemented.

          Existing multi-block sets still RENDER above, each with its Remove button, so one
          can be collapsed by hand; and storage stays a list, so nothing migrates. */}
      <fieldset className="field flags" id="set-flags">
        <legend>Playback &amp; completion</legend>
        {hasPlexSource ? (
          <>
            <label className="field">
              Watch history
              <SelectListbox
                id="set-watch-history"
                key={`${modalKey}-watch-history`}
                label="Default watch history"
                onChange={(value) =>
                  setWatchHistory(
                    value === "queue"
                      ? "queue"
                      : "provider",
                  )
                }
                options={[
                  {
                    label:
                      "Use Plex watch history (default)",
                    value: "provider",
                  },
                  {
                    label:
                      "Keep separate QueuePilot history",
                    value: "queue",
                  },
                ]}
                value={watchHistory}
              />
            </label>
            <p
              className="subhint"
              id="set-watch-history-hint"
            >
              Plex is the safe default: a play started in
              Plex, on another client, or while QueuePilot
              is unavailable still counts. Use separate
              history only when this queue must advance
              independently of the Plex profile. Each entry
              can override this default.
            </p>
          </>
        ) : null}
        {/* PLAYBACK LENGTH. Counted in ENTRIES here and not items, which is the one place the
            unit differs — a rule-based pool has no entries to count. It has to be: a show
            entry's batch is already the control right below this one, so counting items would
            make a length of 1 silently truncate a 2-episode entry to a single episode.

            1 is what an ordered queue has always done (it played its head entry and stopped),
            so the default changes nothing and the knob only ever adds. */}
        <div className="field">
          <span className="fieldlbl">Playback length</span>
          <CountPicker
            defaultValue={editing?.length_default ?? 1}
            hasInfinite
            id="set-length"
            label="Playback length"
            max={reg?.lineup?.max ?? 200}
            onChange={setPlaybackLength}
            presets={SET_LENGTH_PRESETS}
            value={playbackLength}
          />
        </div>
        <p className="subhint" id="set-length-hint">
          {`How many entries play before this ${addAs === "random" ? "pool" : "queue"} stops. One entry is
            the ${vocab.member} at the top — and if that ${vocab.member} is set to more than one
            ${vocab.unit} a visit, it still contributes all of them. Infinite plays the whole list.`}
        </p>
        <Checkbox
          id="set-power-off"
          isChecked={isPoweringOff}
          key={`${modalKey}-poweroff`}
          label="Turn off everything when it finishes"
          onChange={setIsPoweringOff}
        />
        <p className="subhint" id="set-power-off-hint">
          Starting a card wakes the room; this is the other
          half. QueuePilot announces that the sitting ended
          and Home Assistant does the turning off. Nothing
          happens on an Infinite queue — it never finishes.
        </p>
        {/* The queue's DEFAULT batch. Owner, 2026-08-15: "There's no way to globally set how
            many chapters to read before going to the next one… For Plex, 1 episode is no big
            [deal], but for Webtoons and Manga, I'd prefer to default to 3 chapters (by choice
            for this queue, not by default) and change it per-item if I have to."
            So: per QUEUE, 1 everywhere until asked otherwise, and an entry still overrides it.
            Worded from the PROVIDER's vocabulary, so a reading queue does not ask about
            episodes. */}
        {/* A <div>+<span>, not a <label>: CountPicker is a group of BUTTONS, not an input,
            so a <label> would have no control to name. Same shape the per-entry panel uses
            for the identical control. */}
        <div className="field">
          <span className="fieldlbl">
            {`${vocab.units[0]?.toUpperCase()}${vocab.units.slice(1)} per ${vocab.member} each visit`}
          </span>
          <CountPicker
            defaultValue={1}
            label={`${vocab.units} per ${vocab.member} each visit`}
            max={EPISODES_MAX}
            onChange={setEpisodes}
            value={episodes}
          />
        </div>
        <p className="subhint" id="set-episodes-hint">
          {`How many ${vocab.units} one entry contributes before the queue moves to the next
            ${vocab.member}. A single entry can override this from its own settings.`}
        </p>
        {vocab.unit === "chapter" ? (
          <>
            <div className="field">
              <span className="fieldlbl">
                Volumes per series each visit
              </span>
              <CountPicker
                defaultValue={1}
                label="Volumes per series each visit"
                max={EPISODES_MAX}
                onChange={setVolumes}
                value={volumes}
              />
            </div>
            <p className="subhint" id="set-volumes-hint">
              A volume is a collection of chapters, not a
              chapter — this count is independent of the
              chapter count above. Default is 1.
            </p>
          </>
        ) : null}
        {/* ONE question about completion, four answers. It replaced the `Playlist mode` and
            `Demo reel` CHECKBOXES, where checking Demo reel forced Playlist mode on and
            disabled it — a four-state control drawn as two two-state ones — and it is where
            `Start over when exhausted` went, which had nowhere else to go: a third checkbox
            makes eight combinations of which four are meaningless.
            (decision `2026-09-08-completion-behaviour-is-one-picker-not-two-checkboxes`)

            KEYED ON `modalKey`, the SECOND WRITER, never on the mode. `SelectListbox` seeds
            once, so the seed has to be re-taken when a different queue opens the modal;
            keying on the value would remount the control under the user’s own focus
            (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`). */}
        <label className="field">
          Completion mode
          <SelectListbox
            id="set-completion-mode"
            key={`${modalKey}-completion`}
            label="Completion mode"
            onChange={(value) =>
              setCompletionMode(value as CompletionMode)
            }
            options={COMPLETION_MODES.map((mode) => ({
              label: COMPLETION_MODE_LABELS[mode],
              value: mode,
            }))}
            value={completionMode}
          />
        </label>
        <p className="subhint" id="set-completion-hint">
          {COMPLETION_MODE_HINTS[completionMode]}
        </p>
        <label className="field" htmlFor="set-remove-after">
          Remove finished entries after
          <input
            id="set-remove-after"
            onChange={(e) =>
              setRemoveCompletedAfter(e.target.value)
            }
            placeholder="e.g. 24h — blank = keep forever"
            type="text"
            value={removeCompletedAfter}
          />
        </label>
        <p className="subhint" id="set-remove-hint">
          Opt-in TTL for auto-removing finished entries
          (`24h`, `7d`, `90m`). Blank or `never` keeps them
          tagged done until you clear them. Playlist / reel
          queues never mark done, so this only applies to
          ordinary consuming queues.
        </p>
        {/* THE SEASONAL RESET. A <div>+<span>, not a <label>: there are TWO controls under
            one caption, and a <label> may name only one.

            Two pickers rather than a text field, because this is the one setting whose value
            is next examined a YEAR from now — a typed `13-40` would be refused on Save, but a
            typed `01-11` for 11 January is a date, so nothing could refuse it and the queue
            would reset in the wrong month. A month and a day cannot be mistyped into a
            different valid date.

            The DAY picker is keyed on the MONTH, not on its own value: the month is the day's
            second writer (choosing February clamps 31 to 28), and keying a picker on its own
            value remounts it under the user's own focus
            (decision `2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`). */}
        <div className="field" id="set-reset-watched">
          <span className="fieldlbl">
            Clear watched state each year on
          </span>
          <SelectListbox
            className="fieldselect"
            id="set-reset-month"
            key={`${modalKey}-reset-month`}
            label="Reset month"
            onChange={onResetMonthChange}
            options={RESET_MONTH_OPTIONS}
            value={resetMonth}
          />
          <SelectListbox
            className="fieldselect"
            id="set-reset-day"
            isDisabled={!resetMonth}
            key={`${modalKey}-reset-day-${resetMonth}`}
            label="Reset day"
            onChange={setResetDay}
            options={resetDayOptions}
            value={resetDay}
          />
        </div>
        <p className="subhint" id="set-reset-watched-hint">
          On the first play after this date each year, every
          completion this queue owns is cleared and it plays
          from the start again — the done marks, the
          separate QueuePilot history and the promote
          cooldowns. Nothing is removed and nothing is
          written to Plex. There is no timer: a queue nobody
          plays until December resets in December.
          {removeCompletedAfter.trim() &&
          ![
            "0",
            "disabled",
            "never",
            "none",
            "off",
          ].includes(
            removeCompletedAfter.trim().toLowerCase(),
          )
            ? " Warning: “Remove finished entries after” above DEFEATS this. It deletes a finished entry instead of tagging it, so there is nothing left here to reset. Clear that field to use a reset date."
            : " Do not also set “Remove finished entries after”: that deletes a finished entry instead of tagging it, so there would be nothing left to reset."}
        </p>
        <label
          className="field"
          htmlFor="set-promote-window"
        >
          A promoted entry leads again after
          <input
            id="set-promote-window"
            onChange={(e) =>
              setPromoteWindow(e.target.value)
            }
            placeholder="e.g. 20h — blank = 16h"
            type="text"
            value={promoteWindow}
          />
        </label>
        <p className="subhint" id="set-promote-hint">
          How long a promoted entry stays out of the lead
          after it plays (`20h`, `24h`, `7d`). It is a
          rolling timer from the moment playback started,
          not a calendar day — so set it SHORTER than the
          gap between your sittings. A queue watched late at
          night stamps its lead after midnight, and a flat
          24h then blocks the next night’s scan. Blank means
          16h; `never` or `0` means a promoted entry leads
          every sitting.
        </p>
        {/* THE SEASON WINDOW. Its own row, below the promote window and above the batch
            control, because it is the only setting here that is about WHEN the queue is
            offered rather than about what it plays.

            Four `SelectListbox`es and not an `<input type="date">`: a date input carries a
            YEAR, which is a lie the first time this window rolls over, and it paints as the
            OS widget. Both are the reason this app has no native picker left. */}
        <label className="field">
          In season from
          <span className="seasonrow" id="set-season">
            <SelectListbox
              className="fieldselect"
              id="set-season-start-month"
              key={`${modalKey}-ssm`}
              label="Season start month"
              onChange={setSeasonStartMonth}
              options={SEASON_MONTH_OPTIONS}
              value={seasonStartMonth}
            />
            <SelectListbox
              className="fieldselect"
              id="set-season-start-day"
              /* Keyed on the MONTH too: the day list narrows with it, so a stored 31 has to
                 be re-seeded when somebody moves the window to a 30-day month. Keying a
                 picker on its second writer is the house rule
                 (`2026-08-02-uncontrolled-components-are-keyed-on-their-second-writer`). */
              key={`${modalKey}-ssd-${seasonStartMonth}`}
              label="Season start day"
              onChange={setSeasonStartDay}
              options={dayOptions(seasonStartMonth)}
              value={seasonStartDay}
            />
            <span className="seasonto">to</span>
            <SelectListbox
              className="fieldselect"
              id="set-season-end-month"
              key={`${modalKey}-sem`}
              label="Season end month"
              onChange={setSeasonEndMonth}
              options={SEASON_MONTH_OPTIONS}
              value={seasonEndMonth}
            />
            <SelectListbox
              className="fieldselect"
              id="set-season-end-day"
              key={`${modalKey}-sed-${seasonEndMonth}`}
              label="Season end day"
              onChange={setSeasonEndDay}
              options={dayOptions(seasonEndMonth)}
              value={seasonEndDay}
            />
          </span>
        </label>
        <p className="subhint" id="set-season-hint">
          Optional. Out of season this queue is not offered
          on What to Watch/Play and will not start. It still
          appears on this page, still opens and is still
          editable, marked with the date it returns. The
          window repeats every year and may cross New Year
          (1 Dec to 6 Jan). It changes nothing about what
          has been watched: no entry is cleared, marked or
          removed at a season boundary. Leave the months
          blank for a queue that is available all year.
        </p>
        {/* `batch_stops_at` is PLEX-ONLY: it is read by the curated resolver
            (engine/resolve.js) and by nothing else, so on a queue with no Plex source it is
            a control that does nothing — and its wording ("episode", "season finale",
            "show") is Plex vocabulary that reads as nonsense next to chapters and series.
            Hidden rather than reworded, per the owner's call 2026-08-13. Kavita's own
            chapters-per-series batching lives on the source block as `batch`. */}
        {hasPlexSource ? (
          <>
            <label className="field">
              Stop a multi-episode batch at
              {/* Keyed on modal-open identity, same reason as the selects above. */}
              <SelectListbox
                className="fieldselect"
                id="set-batch-stops-at"
                key={modalKey}
                label="Stop a multi-episode batch at"
                onChange={setBatchStopsAt}
                options={[
                  {
                    label:
                      "Nothing — fill the batch across anything",
                    value: "none",
                  },
                  {
                    label:
                      "Season boundary — never cross a finale",
                    value: "season",
                  },
                  {
                    label:
                      "Show boundary — stay inside one show",
                    value: "member",
                  },
                ]}
                value={batchStopsAt}
              />
            </label>
            <p
              className="subhint"
              id="set-batch-stops-hint"
            >
              Only matters for entries set to play more than
              one episode per visit. “Season boundary” ends
              the batch at a season finale instead of
              rolling into the next season (or, inside a
              collection, the next show) — so a finale isn’t
              followed by someone else’s episode 1. A single
              entry can override this.
            </p>
          </>
        ) : null}
      </fieldset>
      <p className="idnote" id="set-idnote">
        {editing
          ? `id: ${setId} — NFC cards / HA reference this id; renaming the label never breaks them.`
          : "Plays from here (and HA, by its new id) once created; an NFC card needs its HA mapping added separately."}
      </p>
    </Modal>
  )
}

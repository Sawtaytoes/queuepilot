import { Checkbox } from "@charcuterie/ui"
import { useEffect, useMemo, useState } from "react"

import { api } from "../lib/api"
import { fetchProfiles } from "../lib/channels"
import type {
  Profile,
  ProviderBlockValue,
  ProviderInfo,
} from "../lib/types"
import {
  closeSetModal,
  useOverlays,
} from "../state/overlays"
import { load, setStatus, useStore } from "../state/store"
import { Modal } from "./Modal"
import { ProviderBlock } from "./ProviderBlock"
import { SelectListbox } from "./SelectListbox"

/**
 * Create / edit a curated set. Create: empty; edit: prefilled + rename/delete.
 *
 * The two kinds are the taxonomy decision, not a cosmetic label: `movies` is an
 * ordered QUEUE (top plays next), `anime` is a CHANNEL whose members play in random
 * order (decision `2026-07-21-queues-vs-channels-taxonomy-play-first-ia`).
 *
 * The id is immutable and NFC cards / HA reference it, so the note says so on both
 * paths — renaming the label never breaks a card.
 * (decision `2026-07-21-sets-registry-immutable-ids`)
 *
 * Queue consumption flags (`keep_completed`, `reel`, `remove_completed_after`) are
 * editable here via Charcuterie `Checkbox` — previously hand-YAML only.
 * (decision `2026-08-08-set-modal-queue-flags`)
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

  const [label, setLabel] = useState("")
  const [kind, setKind] = useState("movies")
  const [requiresProfile, setRequiresProfile] = useState("")
  const [isKeepCompleted, setIsKeepCompleted] =
    useState(false)
  const [isReel, setIsReel] = useState(false)
  const [removeCompletedAfter, setRemoveCompletedAfter] =
    useState("")
  const [batchStopsAt, setBatchStopsAt] = useState("none")
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

  useEffect(() => {
    if (!setModal) return

    setLabel(editing ? editing.label : "")
    const nextKind = editing
      ? editing.kind
      : setModal.presetKind || "movies"
    setKind(nextKind)
    setRequiresProfile(
      editing ? editing.requires_profile || "" : "",
    )
    setIsKeepCompleted(
      editing
        ? Boolean(editing.keep_completed || editing.reel)
        : false,
    )
    setIsReel(editing ? Boolean(editing.reel) : false)
    setBatchStopsAt(
      editing ? editing.batch_stops_at || "none" : "none",
    )
    // Prefill: edit uses the stored TTL; a new movie queue defaults to 24h (matches the
    // seeded movie queues in sets.yaml). Anime stays blank = keep forever.
    if (editing) {
      setRemoveCompletedAfter(
        editing.remove_completed_after || "",
      )
    } else {
      setRemoveCompletedAfter(
        nextKind === "anime" ? "" : "24h",
      )
    }
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
              libraries: [],
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

  const onSubmit = async () => {
    const name = label.trim()

    if (!name) {
      setStatus("Name required", "err")

      return
    }

    const emptyBlock = blocks.findIndex(
      (b) => !b.libraries.length,
    )

    if (emptyBlock >= 0) {
      setStatus(
        blocks.length > 1
          ? `Source ${emptyBlock + 1}: pick at least one library`
          : "Pick at least one library",
        "err",
      )

      return
    }

    // reel implies keep_completed at the engine; always send the effective pair so a
    // re-opened edit prefill matches what was saved.
    // A SINGLE Plex block is written back through the legacy `sections` /
    // `requires_profile` fields rather than as a `providers:` list. That keeps every
    // existing set byte-identical on disk after an unrelated edit — the block shape only
    // appears once it is actually needed, which is what makes this additive rather than a
    // migration that rewrites everyone's config the first time they rename a queue.
    const isLegacyShape =
      blocks.length === 1 && blocks[0].provider === "plex"

    const body = {
      kind,
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
      keep_completed: isKeepCompleted || isReel,
      reel: isReel,
      // Empty string clears the TTL (keep forever). Explicit never/0 also clears server-side.
      remove_completed_after: removeCompletedAfter.trim(),
      // "none" is the engine default, so it is stored as the absence of the key.
      batch_stops_at: batchStopsAt,
      // An empty list drops the key server-side, which is how the single-Plex-block case
      // stays on the legacy shape above.
      providers: isLegacyShape
        ? []
        : blocks.map(({ uid: _uid, ...b }) => b),
    }

    try {
      if (setId) {
        await api("PATCH", `/api/sets/${setId}`, body)
      } else {
        await api("POST", "/api/sets", body)
      }

      const word = kind === "anime" ? "Channel" : "Queue"

      closeSetModal()
      setStatus(
        setId ? `${word} updated` : `${word} created`,
        "ok",
      )
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
        `Delete “${editing.label}”${n ? ` and its ${n} entries` : ""}? This cannot be undone.`,
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

  const onReelChange = (nextIsReel: boolean) => {
    setIsReel(nextIsReel)
    // reel ⇒ keep_completed. When reel turns on, force the playlist flag on so the
    // submitted body and the disabled checkbox both read the implied state.
    if (nextIsReel) setIsKeepCompleted(true)
  }

  return (
    <Modal
      footer={
        <>
          <button
            className="danger"
            hidden={!editing}
            id="set-delete"
            onClick={() => void onDelete()}
            type="button"
          >
            Delete queue
          </button>
          <span className="spacer" />
          <button
            className="ghost"
            id="set-cancel"
            onClick={closeSetModal}
            type="button"
          >
            Cancel
          </button>
          <button id="set-save" type="submit">
            Save
          </button>
        </>
      }
      id="setmodal"
      isOpen={Boolean(setModal)}
      onClose={closeSetModal}
      onSubmit={() => void onSubmit()}
      title={
        editing
          ? `Edit “${editing.label}”`
          : setModal?.presetKind === "anime"
            ? "New channel"
            : "New queue"
      }
      titleId="setmodal-title"
    >
      <label className="field">
        Name
        <input
          id="set-label"
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Alice — Shorts"
          required
          type="text"
          value={label}
        />
      </label>
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
          onChange={setKind}
          options={[
            {
              label: "Queue — ordered, top plays next",
              value: "movies",
            },
            {
              label:
                "Channel — members play in random order",
              value: "anime",
            },
          ]}
          value={kind}
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
              setBlocks((prev) =>
                prev.map((x, j) =>
                  // Carry the uid across: ProviderBlock speaks the WIRE shape and knows
                  // nothing about this component's identity bookkeeping.
                  j === i ? { ...next, uid: x.uid } : x,
                ),
              )
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
      {/* Adding a source is only offered once there is a second provider to add — with one
          connected app there is nothing a second block could draw from that the first
          cannot. */}
      {providers.length > 1 ? (
        <button
          className="addblock"
          id="set-add-block"
          onClick={() =>
            setBlocks((prev) => [
              ...prev,
              {
                libraries: [],
                profile: "",
                provider:
                  providers[0]?.id ?? prev[0].provider,
                uid: newUid(),
              },
            ])
          }
          type="button"
        >
          + Add another source
        </button>
      ) : null}
      <fieldset className="field flags" id="set-flags">
        <legend>Playback &amp; completion</legend>
        {/* Charcuterie Checkbox is uncontrolled (isChecked seeds once). Remount on modal
            open AND when reel forces keep_completed on, so the box reflects the implied
            state without becoming a controlled input. */}
        <Checkbox
          id="set-keep-completed"
          isChecked={isKeepCompleted || isReel}
          isDisabled={isReel}
          key={`${modalKey}-keep-${isReel ? "reel" : "free"}`}
          label="Playlist mode — don’t mark entries done when played"
          onChange={setIsKeepCompleted}
        />
        <p className="subhint" id="set-keep-hint">
          Non-consuming queue: entries stay re-showable
          forever. Demo Reel and other showcase lineups want
          this. Forced on when Demo reel is checked.
        </p>
        <Checkbox
          id="set-reel"
          isChecked={isReel}
          key={`${modalKey}-reel`}
          label="Demo reel — play the whole lineup every scan"
          onChange={onReelChange}
        />
        <p className="subhint" id="set-reel-hint">
          Ignores watched-state and plays every entry each
          scan (implies playlist mode). Leave off for a
          normal ordered queue that advances one item at a
          time.
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
        <p className="subhint" id="set-batch-stops-hint">
          Only matters for entries set to play more than one
          episode per visit. “Season boundary” ends the
          batch at a season finale instead of rolling into
          the next season (or, inside a collection, the next
          show) — so a finale isn’t followed by someone
          else’s episode 1. A single entry can override
          this.
        </p>
      </fieldset>
      <p className="idnote" id="set-idnote">
        {editing
          ? `id: ${setId} — NFC cards / HA reference this id; renaming the label never breaks them.`
          : "Plays from here (and HA, by its new id) once created; an NFC card needs its HA mapping added separately."}
      </p>
    </Modal>
  )
}

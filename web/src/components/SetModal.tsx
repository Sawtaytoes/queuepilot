import { SelectListbox } from "./SelectListbox"
import { useEffect, useMemo, useState } from "react"

import { api } from "../lib/api"
import { fetchProfiles } from "../lib/channels"
import { byTitle } from "../lib/tileFace"
import type { Profile } from "../lib/types"
import { closeSetModal, useOverlays } from "../state/overlays"
import { load, setStatus, useStore } from "../state/store"
import { Modal } from "./Modal"

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
 */
export function SetModal() {
  const { setModal } = useOverlays()
  const { data, reg } = useStore()

  const setId = setModal?.setId ?? null
  const editing = useMemo(
    () => (setId ? (reg?.sets.find((s) => s.id === setId) ?? null) : null),
    [reg, setId],
  )

  const [label, setLabel] = useState("")
  const [kind, setKind] = useState("movies")
  const [sections, setSections] = useState<number[]>([])
  const [requiresProfile, setRequiresProfile] = useState("")
  const [profiles, setProfiles] = useState<Profile[]>([])

  useEffect(() => {
    if (!setModal) return

    setLabel(editing ? editing.label : "")
    setKind(editing ? editing.kind : setModal.presetKind || "movies")
    setSections(editing ? [...editing.sections] : [])
    setRequiresProfile(editing ? editing.requires_profile || "" : "")
    void fetchProfiles().then(setProfiles)
    // Only re-seed when the modal is (re-)opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setModal])

  // Every video library is opt-in; show them all, alphabetically (there is no
  // global hide list any more).
  const libraries = useMemo(
    () => (reg?.libraries ?? []).filter((l) => l.video).sort(byTitle),
    [reg],
  )

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
    if (requiresProfile && !opts.some((o) => o.value === requiresProfile)) {
      opts.push({ label: `${requiresProfile} (current)`, value: requiresProfile })
    }
    return opts
  }, [profiles, requiresProfile])

  const onSubmit = async () => {
    const name = label.trim()

    if (!name) {
      setStatus("Name required", "err")

      return
    }

    if (!sections.length) {
      setStatus("Pick at least one library", "err")

      return
    }

    try {
      if (setId) {
        await api("PATCH", `/api/sets/${setId}`, { kind, label: name, sections, requires_profile: requiresProfile })
      }
      else {
        await api("POST", "/api/sets", { kind, label: name, sections, requires_profile: requiresProfile })
      }

      const word = kind === "anime" ? "Channel" : "Queue"

      closeSetModal()
      setStatus(setId ? `${word} updated` : `${word} created`, "ok")
      await load()
    }
    catch (err) {
      setStatus("Save failed: " + (err as Error).message, "err")
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
    }
    catch (e) {
      setStatus("Delete failed: " + (e as Error).message, "err")
    }
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
          key={setModal ? (setId ?? "new") : "closed"}
          label="Type"
          onChange={setKind}
          options={[
            { label: "Queue — ordered, top plays next", value: "movies" },
            {
              label: "Channel — members play in random order",
              value: "anime",
            },
          ]}
          value={kind}
        />
      </label>
      <label className="field">
        Plays under profile
        {/* Keyed on modal-open identity, same reason as the Type select above: the control
            re-seeds from `value` only on remount, and this modal never unmounts. */}
        <SelectListbox
          className="fieldselect"
          id="set-profile"
          key={setModal ? (setId ?? "new") : "closed"}
          label="Plays under profile"
          onChange={setRequiresProfile}
          options={profileOptions}
          value={requiresProfile}
        />
      </label>
      <p className="subhint" id="set-profile-hint">
        Locks this queue to a Plex Home profile — a scan waits (and switches the Shield)
        until that profile is signed in before it plays. Leave “Any” for no lock. Needed when
        the queue’s libraries are only shared with one profile (e.g. Demos → Demo).
      </p>
      <fieldset className="field">
        <legend>Libraries this queue can search &amp; hold</legend>
        <div className="libs" id="set-libs">
          {libraries.map((l) => (
            <label key={l.id}>
              <input
                checked={sections.includes(l.id)}
                onChange={(e) =>
                  setSections((prev) =>
                    e.target.checked
                      ? [...prev, l.id]
                      : prev.filter((x) => x !== l.id),
                  )}
                type="checkbox"
                value={String(l.id)}
              />
              {` ${l.title}`}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="idnote" id="set-idnote">
        {editing
          ? `id: ${setId} — NFC cards / HA reference this id; renaming the label never breaks them.`
          : "Plays from here (and HA, by its new id) once created; an NFC card needs its HA mapping added separately."}
      </p>
    </Modal>
  )
}

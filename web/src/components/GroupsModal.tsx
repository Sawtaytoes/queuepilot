import { Button } from "@charcuterie/ui"
import { useEffect, useMemo, useState } from "react"

import { api } from "../lib/api"
import { fetchProfiles } from "../lib/channels"
import type { Group, Profile } from "../lib/types"
import {
  closeGroupsModal,
  selectGroupInModal,
  useOverlays,
} from "../state/overlays"
import {
  refreshGroups,
  setStatus,
  useStore,
} from "../state/store"
import { CheckboxGroup } from "./CheckboxGroup"
import { Modal } from "./Modal"

/**
 * THE GROUPS EDITOR — create, rename, refile and reorder the chips at the top of the app.
 *
 * It exists because the alternative was me editing `groups.yaml` for him, which is the exact
 * complaint that started this: *"All those configs are managed by you, not inside the app.
 * The only thing that should be via env vars are the Plex token and Kavita token."*
 *
 * ── Two ways in, and the editor shows both ───────────────────────────────────────────────
 * A set lands in a group either because the group NAMES it, or because the group's accounts
 * match the account that set plays as (and no group named it). The membership list therefore
 * has three states, not two:
 *
 *   ☑  named by this group          — an explicit tick, stored in `sets:`
 *   ☑  matched by account (locked)  — derived, shown ticked and disabled with a reason
 *   ☐  not in this group
 *
 * Rendering derived membership as a plain unticked box would be a lie the first time he
 * opened Kids and saw four pools he can see on the page listed as "not in this group".
 * Rendering it as a normal tick would be worse: unticking it would write an empty `sets:`
 * and change nothing, which looks like the save failed.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────
 * No id field. The id is the URL (`/g/<id>`), so it is generated once from the label and is
 * immutable after — same contract `sets.yaml` keeps, and for the same reason: a bookmark, an
 * HA link or a phone home-screen tile is a promise.
 */

type Draft = {
  label: string
  /** Explicit `sets:` membership. Derived membership is not editable and not in here. */
  sets: Set<string>
  /** Provider kind -> account names. Plex's come from the Home list; others are typed. */
  accounts: Record<string, string[]>
}

const draftFrom = (group: Group | null): Draft => ({
  accounts: { ...(group?.accounts ?? {}) },
  label: group?.label ?? "",
  sets: new Set(group?.sets ?? []),
})

export function GroupsModal() {
  const { groupsModal } = useOverlays()
  const { groups, reg } = useStore()
  const [draft, setDraft] = useState<Draft>(draftFrom(null))
  const [isSaving, setIsSaving] = useState(false)
  const [plexProfiles, setPlexProfiles] = useState<
    Profile[]
  >([])

  const list = useMemo(
    () => (groups?.groups ?? []).filter((g) => !g.isAll),
    [groups],
  )
  const selectedId = groupsModal?.selectedId ?? null
  const selected =
    list.find((g) => g.id === selectedId) ?? null

  // Re-seed the draft whenever the SELECTION changes — not whenever `groups` changes, or a
  // live refresh mid-edit would throw away what he is typing. The store is still the source
  // for the LIST beside it; only the open form is held locally.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(
    () => setDraft(draftFrom(selected)),
    [selectedId],
  )

  // The Plex Home profiles, so `accounts.plex` is a tick-list of real accounts rather than
  // free text somebody has to spell exactly. Kavita has no equivalent endpoint yet, so its
  // names stay typed — see the note by that field.
  useEffect(() => {
    if (!groupsModal) return

    void fetchProfiles()
      .then(setPlexProfiles)
      .catch(() => setPlexProfiles([]))
  }, [groupsModal])

  if (!groupsModal) return null

  const allSets =
    reg?.sets.filter((s) => !s.superseded_by) ?? []

  /** Set ids this group holds WITHOUT naming them — the locked ticks. */
  const derived = new Set(
    (selected?.setIds ?? []).filter(
      (id) => !draft.sets.has(id),
    ),
  )

  const save = async () => {
    const label = draft.label.trim()

    if (!label) {
      setStatus("A group needs a name", "err")

      return
    }

    setIsSaving(true)

    try {
      if (selected) {
        await api("PATCH", `/api/groups/${selected.id}`, {
          accounts: draft.accounts,
          label,
          sets: [...draft.sets],
        })
        await refreshGroups()
      } else {
        const made = await api<{ id: string }>(
          "POST",
          "/api/groups",
          {
            accounts: draft.accounts,
            label,
            sets: [...draft.sets],
          },
        )

        // ORDER MATTERS: refresh the store BEFORE selecting the new group.
        //
        // Selecting it changes `selectedId`, which re-seeds the draft from whatever the
        // store holds for that id — and if the store has not been refreshed yet, that is
        // NOTHING, so the draft resets to empty. The next Save then PATCHes `sets: []` and
        // silently un-files everything you just ticked. (Caught by the round-trip harness:
        // create with two sets, rename, and the two sets came back gone.)
        //
        // And it is `refreshGroups()` rather than `load()` for the second half of the same
        // bug: `load()` re-resolves every queue against Plex + Kavita and takes 7-9 s, so
        // the re-seed landed LONG after the save and overwrote whatever had been typed in
        // between — the harness renamed the group and the PATCH carried the OLD name.
        await refreshGroups()
        selectGroupInModal(made.id)
      }

      setStatus("Saved", "ok")
    } catch (e) {
      setStatus(
        `Save failed: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsSaving(false)
    }
  }

  const remove = async () => {
    if (!selected) return

    setIsSaving(true)

    try {
      await api("DELETE", `/api/groups/${selected.id}`)
      await refreshGroups()
      selectGroupInModal(null)
      setStatus("Group removed", "ok")
    } catch (e) {
      setStatus(
        `Could not remove: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsSaving(false)
    }
  }

  /** Move a group up or down the chip row. The order IS the file order. */
  const move = async (id: string, delta: number) => {
    const ids = list.map((g) => g.id)
    const at = ids.indexOf(id)
    const to = at + delta

    if (at < 0 || to < 0 || to >= ids.length) return

    ids.splice(to, 0, ...ids.splice(at, 1))

    try {
      await api("PATCH", "/api/groups-order", { ids })
      await refreshGroups()
    } catch (e) {
      setStatus(
        `Could not reorder: ${(e as Error).message}`,
        "err",
      )
    }
  }

  const setAccounts = (kind: string, names: string[]) =>
    setDraft((d) => ({
      ...d,
      accounts: { ...d.accounts, [kind]: names },
    }))

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
          {selected ? (
            <Button
              id="groupdelete"
              intent="danger"
              isDisabled={isSaving}
              onClick={remove}
            >
              Delete group
            </Button>
          ) : null}
          <Button
            appearance="outline"
            intent="neutral"
            onClick={closeGroupsModal}
          >
            Close
          </Button>
          <Button
            id="groupsave"
            intent="accent"
            isDisabled={isSaving}
            onClick={save}
          >
            {selected ? "Save" : "Create group"}
          </Button>
        </>
      }
      id="groupsmodal"
      isOpen
      onClose={closeGroupsModal}
      onSubmit={save}
      title="Groups"
      titleId="groupsmodal-title"
    >
      <div className="grouplayout">
        <aside className="grouplist">
          <ul>
            {list.map((g, i) => (
              <li key={g.id}>
                <button
                  aria-current={
                    g.id === selectedId ? "true" : undefined
                  }
                  className="grouppick"
                  onClick={() => selectGroupInModal(g.id)}
                  type="button"
                >
                  {g.label}
                  <span className="groupcount">
                    {g.setIds.length}
                  </span>
                </button>
                {/* Up/down rather than drag: the row is short, this is a settings panel
                    rather than the poster grid, and a keyboard reaches it. */}
                <span className="groupmove">
                  <button
                    aria-label={`Move ${g.label} earlier`}
                    disabled={i === 0}
                    onClick={() => move(g.id, -1)}
                    type="button"
                  >
                    ▲
                  </button>
                  <button
                    aria-label={`Move ${g.label} later`}
                    disabled={i === list.length - 1}
                    onClick={() => move(g.id, 1)}
                    type="button"
                  >
                    ▼
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {/* ⚠️ THIS ONE CHANGES ON SCREEN, deliberately. Its `accent` matched NEITHER
              `#tools button.accent` NOR `.playlinks button.accent` — the only two rules the
              class has ever had — and this panel is neither, so `＋ New group` has never once
              shown the treatment its class asked for. It is the same latent bug the channels
              toolbar's two pool buttons had, and it gets the same answer: a button that MAKES
              something is `intent="accent"`, which is what the class was reaching for.
              (decision `2026-08-21-a-component-configured-by-props-not-a-borrowed-class`) */}
          <Button
            appearance="outline"
            aria-current={selectedId ? undefined : "true"}
            id="groupnew"
            intent="accent"
            onClick={() => selectGroupInModal(null)}
          >
            ＋ New group
          </Button>
        </aside>

        <div className="groupform">
          <label className="field">
            Name
            <input
              autoComplete="off"
              id="grouplabel"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  label: e.target.value,
                }))
              }
              placeholder="Bob & Alice"
              type="text"
              value={draft.label}
            />
          </label>
          <p className="hint">
            {selected ? (
              <>
                The name is free to change; the address{" "}
                <code>/g/{selected.id}</code> never does, so
                bookmarks keep working.
              </>
            ) : (
              "The address is made from the name once, then never changes."
            )}
          </p>

          <fieldset>
            <legend>In this group</legend>
            <ul className="groupsets">
              {allSets.map((s) => {
                const isDerived = derived.has(s.id)

                return (
                  <li key={s.id}>
                    <label>
                      <input
                        checked={
                          isDerived || draft.sets.has(s.id)
                        }
                        // A derived tick is LOCKED, with the reason beside it. Letting it be
                        // unticked would write an empty `sets:` and change nothing — a
                        // control that looks like it did something and did not.
                        disabled={isDerived}
                        onChange={(e) =>
                          setDraft((d) => {
                            const next = new Set(d.sets)

                            if (e.target.checked)
                              next.add(s.id)
                            else next.delete(s.id)

                            return { ...d, sets: next }
                          })
                        }
                        type="checkbox"
                      />
                      <span data-provider={s.provider_kind}>
                        {s.label}
                      </span>
                      {isDerived ? (
                        <em className="derived">
                          matched by account
                        </em>
                      ) : null}
                    </label>
                  </li>
                )
              })}
            </ul>
          </fieldset>

          <fieldset>
            <legend>Plex accounts</legend>
            <CheckboxGroup
              checked={draft.accounts.plex ?? []}
              id="groupplex"
              onToggle={(value, isChecked) => {
                const now = new Set(
                  draft.accounts.plex ?? [],
                )

                if (isChecked) now.add(value)
                else now.delete(value)

                setAccounts("plex", [...now])
              }}
              options={plexProfiles.map((p) => ({
                label: p.name,
                // The value stored is what a set's `requires_profile` / `plex_user` says,
                // which for the OWNER is the plex.tv username (`sawtaytoes`) and for a
                // managed user is the Home title. Matching the wrong one of the two is the
                // whole failure mode this list exists to prevent.
                value: p.username || p.name,
              }))}
            />
            <p className="hint">
              Anything not ticked into a group by hand falls
              to whichever group claims the account it plays
              as. That is how <strong>Kids</strong> and{" "}
              <strong>Demo</strong> fill themselves.
            </p>
          </fieldset>

          <label className="field">
            Kavita users
            <input
              autoComplete="off"
              id="groupkavita"
              onChange={(e) =>
                setAccounts(
                  "kavita",
                  e.target.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                )
              }
              placeholder="Bob, Alice"
              type="text"
              value={(draft.accounts.kavita ?? []).join(
                ", ",
              )}
            />
          </label>
          <p className="hint">
            Typed, not ticked: Kavita has no endpoint that
            lists its users the way Plex does. Comma
            separated.
          </p>
        </div>
      </div>
    </Modal>
  )
}

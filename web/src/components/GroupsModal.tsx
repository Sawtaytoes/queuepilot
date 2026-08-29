import {
  Button,
  EmptyState,
  SegmentedControl,
} from "@charcuterie/ui"
import { useEffect, useMemo, useRef, useState } from "react"

import { describeRule } from "../lib/people"
import type {
  GroupWithRoster,
  MemberRole,
  Person,
} from "../lib/types"
import {
  closeGroupsModal,
  selectGroupInModal,
  useOverlays,
} from "../state/overlays"
import {
  createPeopleGroup,
  deletePeopleGroup,
  loadPeople,
  renamePeopleGroup,
  savePeopleGroupMembership,
  usePeople,
} from "../state/people"
import { setStatus } from "../state/store"
import { Modal } from "./Modal"
import { PersonFace } from "./PersonFace"
import { SelectListbox } from "./SelectListbox"

type DraftMember = {
  personId: string
  role: MemberRole
}

type Draft = {
  label: string
  minPresent: number | null
  roster: DraftMember[]
}

const MEMBER_CHOICES = [
  { label: "Not in group", value: "none" },
  { label: "Required", value: "required" },
  { label: "May join", value: "optional" },
] as const

const draftFrom = (
  group: GroupWithRoster | null,
): Draft => ({
  label: group?.label ?? "",
  minPresent: group?.minPresent ?? null,
  roster:
    group?.roster.map(({ personId, role }) => ({
      personId,
      role,
    })) ?? [],
})

const membershipFromDraft = (
  draft: Draft,
  id: string,
): GroupWithRoster => ({
  id,
  label: draft.label,
  minPresent: draft.minPresent,
  roster: draft.roster.map((member, position) => ({
    ...member,
    position,
  })),
})

const displayRule = (
  group: GroupWithRoster,
  people: readonly Person[],
) =>
  describeRule(
    group,
    (personId) =>
      people.find((person) => person.id === personId)
        ?.displayName ?? personId,
  )

/**
 * THE PEOPLE-GROUP EDITOR — one saved rule per group.
 *
 * A group's own rule is separate from the way a queue uses that group. Here, Required means a
 * person belongs to the counted part of the group, May join means they are optional, and the
 * minimum picker says how many Required people satisfy the group. The queue editor then places
 * the whole group under Must, Nice, or Exclude with one visible action.
 *
 * Provider profile and set-filing data are not copied into this form. Saving a label sends only
 * the label, so the group's playback settings stay unchanged while its people rule is edited.
 */
export function GroupsModal() {
  const { groupsModal } = useOverlays()
  const { byQueue, groups, isLoaded, people } = usePeople()
  const selectedId = groupsModal?.selectedId ?? null
  const selected =
    groups.find((group) => group.id === selectedId) ?? null
  const [draft, setDraft] = useState<Draft>(draftFrom(null))
  const [isSaving, setIsSaving] = useState(false)
  const [isConfirmingDelete, setIsConfirmingDelete] =
    useState(false)
  const labelRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  // Do not reseed on every people refresh. The open form owns unsaved typing until the user
  // chooses another group.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedRef intentionally reads the latest selected group without reseeding on a background refresh.
  useEffect(() => {
    setDraft(draftFrom(selectedRef.current))
    setIsConfirmingDelete(false)
    if (selectedId === null) labelRef.current?.focus()
  }, [selectedId])

  const preview = useMemo(
    () =>
      displayRule(
        membershipFromDraft(
          draft,
          selectedId ?? "new-people-group",
        ),
        people,
      ),
    [draft, people, selectedId],
  )
  const requiredCount = draft.roster.filter(
    (member) => member.role === "required",
  ).length
  const ruleOptions = [
    {
      label: "Anybody in this group",
      value: "anybody",
    },
    ...(requiredCount === 0
      ? Array.from(
          { length: draft.roster.length },
          (_, index) => {
            const count = index + 1
            return {
              label:
                count === draft.roster.length
                  ? "All people in this group"
                  : `At least ${count} ${count === 1 ? "person" : "people"}`,
              value:
                count === draft.roster.length
                  ? "all"
                  : String(count),
            }
          },
        )
      : [
          ...Array.from(
            { length: Math.max(requiredCount - 1, 0) },
            (_, index) => {
              const count = index + 1
              return {
                label: `At least ${count} ${count === 1 ? "person" : "people"}`,
                value: String(count),
              }
            },
          ),
          {
            label: "All required people",
            value: "all",
          },
        ]),
  ]
  const ruleValue =
    requiredCount === 0
      ? "anybody"
      : draft.minPresent == null ||
          draft.minPresent >= requiredCount
        ? "all"
        : String(Math.max(1, draft.minPresent))
  const queuesUsingGroup = useMemo(
    () =>
      selected
        ? Object.values(byQueue).filter((members) =>
            members.some(
              (member) =>
                member.kind === "group" &&
                member.id === selected.id,
            ),
          ).length
        : 0,
    [byQueue, selected],
  )

  if (!groupsModal) return null

  const setMemberRole = (
    personId: string,
    value: string | null,
  ) => {
    if (
      value !== "none" &&
      value !== "required" &&
      value !== "optional"
    ) {
      return
    }
    const role: MemberRole | null =
      value === "none"
        ? null
        : value === "required"
          ? "required"
          : "optional"

    setDraft((current) => {
      const without = current.roster.filter(
        (member) => member.personId !== personId,
      )
      const roster =
        role == null
          ? without
          : [...without, { personId, role }]
      const nextRequiredCount = roster.filter(
        (member) => member.role === "required",
      ).length

      return {
        ...current,
        minPresent:
          current.minPresent == null
            ? null
            : nextRequiredCount === 0
              ? null
              : Math.min(
                  current.minPresent,
                  nextRequiredCount,
                ),
        roster,
      }
    })
  }

  const setRule = (value: string) => {
    if (value === "anybody") {
      setDraft((current) => ({
        ...current,
        minPresent: null,
        roster: current.roster.map((member) => ({
          ...member,
          role: "optional",
        })),
      }))
      return
    }

    setDraft((current) => ({
      ...current,
      minPresent:
        value === "all"
          ? null
          : (() => {
              const next = Number(value)
              if (!Number.isInteger(next) || next < 1)
                return null
              return Math.min(next, current.roster.length)
            })(),
      // An all-optional group has no people for a minimum to count. Choosing a minimum is an
      // explicit request to make the current roster the counted half of the rule.
      roster: current.roster.some(
        (member) => member.role === "required",
      )
        ? current.roster
        : current.roster.map((member) => ({
            ...member,
            role: "required",
          })),
    }))
  }

  const startNewGroup = () => {
    setDraft(draftFrom(null))
    setIsConfirmingDelete(false)
    selectGroupInModal(null)
  }

  const save = async () => {
    const label = draft.label.trim()
    if (!label) {
      setStatus("A people group needs a name", "err")
      return
    }

    setIsSaving(true)
    try {
      let id = selectedId
      if (id) {
        await renamePeopleGroup(id, label)
      } else {
        id = await createPeopleGroup(label)
      }

      await savePeopleGroupMembership(
        id,
        draft.minPresent,
        draft.roster,
      )
      await loadPeople()
      if (!selectedId) selectGroupInModal(id)
      setStatus("People group saved", "ok")
    } catch (e) {
      setStatus(
        `Could not save people group: ${(e as Error).message}`,
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
      await deletePeopleGroup(selected.id)
      selectGroupInModal(null)
      setStatus("People group removed", "ok")
    } catch (e) {
      setStatus(
        `Could not remove people group: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsSaving(false)
      setIsConfirmingDelete(false)
    }
  }

  return (
    <Modal
      footer={
        <>
          {selected && isConfirmingDelete ? (
            <>
              <Button
                id="groupdelete-confirm"
                intent="danger"
                isDisabled={isSaving}
                onClick={() => void remove()}
              >
                Delete group
              </Button>
              <Button
                appearance="outline"
                intent="neutral"
                isDisabled={isSaving}
                onClick={() => setIsConfirmingDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : selected ? (
            <Button
              id="groupdelete"
              intent="danger"
              isDisabled={isSaving}
              onClick={() => setIsConfirmingDelete(true)}
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
        </>
      }
      id="groupsmodal"
      isOpen
      onClose={closeGroupsModal}
      onSubmit={save}
      title="People groups"
      titleId="groupsmodal-title"
    >
      <div className="grouplayout">
        <aside className="grouplist">
          <div className="grouplisthead">
            <h4>Saved groups</h4>
            <p>Reusable rules for several people.</p>
          </div>
          {!isLoaded ? (
            <p className="subhint">Loading…</p>
          ) : groups.length === 0 ? (
            <EmptyState
              description="Create one for a rule that you use on more than one queue."
              heading="No people groups"
              headingLevel={5}
              size="sm"
            />
          ) : (
            <ul>
              {groups.map((group) => (
                <li key={group.id}>
                  <button
                    aria-current={
                      group.id === selectedId
                        ? "true"
                        : undefined
                    }
                    className="grouppick"
                    onClick={() =>
                      selectGroupInModal(group.id)
                    }
                    type="button"
                  >
                    <span className="grouppickname">
                      <PersonFace
                        id={group.id}
                        label={group.label}
                        size="sm"
                      />
                      <strong>{group.label}</strong>
                    </span>
                    <span className="grouppickrule">
                      {displayRule(group, people)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button
            appearance="outline"
            aria-current={selectedId ? undefined : "true"}
            id="groupnew"
            intent="accent"
            onClick={startNewGroup}
          >
            + New people group
          </Button>
        </aside>

        <div className="groupform">
          <label className="field">
            Name
            <input
              autoComplete="off"
              id="grouplabel"
              maxLength={60}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  label: event.target.value,
                }))
              }
              placeholder="e.g. Younger Kids"
              ref={labelRef}
              type="text"
              value={draft.label}
            />
          </label>
          <p className="groupformhint">
            The group id stays the same after you rename it.
            Existing queues keep pointing to this group.
          </p>
          <div className="groupformactions">
            <Button
              id="groupsave"
              intent="accent"
              isDisabled={isSaving || isConfirmingDelete}
              onClick={() => void save()}
            >
              {selected ? "Save" : "Create group"}
            </Button>
          </div>

          <fieldset
            className="grouprule"
            aria-live="polite"
          >
            <legend>Rule</legend>
            <SelectListbox
              key={selectedId ?? "new"}
              id="group-rule"
              isDisabled={
                isSaving || ruleOptions.length < 2
              }
              label="Rule"
              onChange={setRule}
              options={ruleOptions}
              value={ruleValue}
            />
            <p className="grouprulesummary">{preview}.</p>
            <p className="groupformhint">
              Required people count toward the minimum.
              People marked May join are part of the group
              but do not block it. Choosing a minimum on an
              all-optional group makes its current members
              Required.
            </p>
          </fieldset>

          <fieldset className="groupmembers">
            <legend>People in this group</legend>
            {!isLoaded ? (
              <p className="subhint">Loading…</p>
            ) : people.length === 0 ? (
              <EmptyState
                description="Add people in the People editor first."
                heading="Nobody to add"
                headingLevel={5}
                size="sm"
              />
            ) : (
              <ul className="groupmemberlist">
                {people.map((person) => {
                  const member = draft.roster.find(
                    (entry) => entry.personId === person.id,
                  )
                  const selectedValue =
                    member?.role ?? "none"
                  return (
                    <li
                      className="groupmemberrow"
                      key={`${selectedId ?? "new"}:${person.id}`}
                    >
                      <span className="groupmemberidentity">
                        <PersonFace
                          id={person.id}
                          label={person.displayName}
                        />
                        <strong>
                          {person.displayName}
                        </strong>
                      </span>
                      <SegmentedControl
                        className="groupmemberchoices"
                        items={MEMBER_CHOICES}
                        label={`Membership for ${person.displayName}`}
                        onChange={(value) =>
                          setMemberRole(person.id, value)
                        }
                        selectedValue={selectedValue}
                        size="sm"
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>

          {selected && isConfirmingDelete ? (
            <p className="groupdeleteconfirm">
              This removes the group from {queuesUsingGroup}{" "}
              {queuesUsingGroup === 1 ? "queue" : "queues"}{" "}
              and deletes its saved rule. The people stay in
              the roster.
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}

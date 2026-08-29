import {
  EmptyState,
  SegmentedControl,
} from "@charcuterie/ui"
import { useMemo } from "react"

import {
  byTray,
  type Candidate,
  candidates,
  moveToTray,
  TRAYS,
  type TrayKey,
} from "../lib/people"
import type {
  GroupWithRoster,
  Person,
  QueueMember,
} from "../lib/types"
import { PersonFace } from "./PersonFace"

/** The three audience actions are visible on every row. */
const AUDIENCE_CHOICES = [
  { label: "Must", value: "required" },
  { label: "Nice", value: "optional" },
  { label: "Exclude", value: "roster" },
] as const

/**
 * THE QUEUE AUDIENCE — one vertical list of people and people groups.
 *
 * Every row has the same three actions: Must, Nice, and Exclude. The selected action is the
 * row's section, so a group rule never has to be interpreted through a lane name. The sections
 * are ordered Must be here, Nice to have, and Everyone else because that is the order the queue
 * uses when it decides whom it is for.
 *
 * The rule inside a people group stays visible under its name. A group is still one saved rule,
 * while its placement on a queue is a separate choice. This distinction is what lets "at least
 * one of these people" remain clear when the group is marked Must be here.
 */
export function PeopleTrays({
  groups,
  isBusy = false,
  members,
  onChange,
  people,
}: {
  people: readonly Person[]
  groups: readonly GroupWithRoster[]
  members: readonly QueueMember[]
  /** The WHOLE new member list. The write is all-or-nothing. */
  onChange: (members: QueueMember[]) => void
  isBusy?: boolean
}) {
  const all = useMemo(
    () => candidates(people, groups),
    [people, groups],
  )
  const sections = useMemo(
    () => byTray(all, members),
    [all, members],
  )

  if (all.length === 0) {
    return (
      <EmptyState
        description="Confirm the people mapping file in the config directory and restart, and the whole house appears here."
        heading="Nobody is in the roster yet"
        headingLevel={4}
        size="sm"
      />
    )
  }

  const move = (
    candidate: Candidate,
    tray: string | null,
  ) => {
    if (
      isBusy ||
      (tray !== "required" &&
        tray !== "optional" &&
        tray !== "roster")
    ) {
      return
    }

    onChange(
      moveToTray(
        members,
        { id: candidate.id, kind: candidate.kind },
        tray as TrayKey,
      ),
    )
  }

  return (
    <div className="audienceeditor">
      <p className="audienceintro">
        Choose who this queue is for. People groups keep
        their own rule, and their placement here only says
        how important that rule is to this queue.
      </p>
      <div className="audiencesections">
        {TRAYS.map((tray) => {
          const items = sections[tray.key]

          return (
            <section
              className="audiencesection"
              data-tray={tray.key}
              key={tray.key}
            >
              <header className="audiencesectionhead">
                <div>
                  <h5>
                    {tray.label}
                    <span className="audiencecount">
                      {items.length}
                    </span>
                  </h5>
                  <p>{tray.help}</p>
                </div>
              </header>
              {items.length === 0 ? (
                <div className="audienceempty">
                  <EmptyState
                    description={tray.help}
                    heading="Nobody here"
                    headingLevel={6}
                    size="sm"
                  />
                </div>
              ) : (
                <ul className="audiencelist">
                  {items.map((candidate) => (
                    <li
                      className="audiencerow"
                      key={`${candidate.kind}:${candidate.id}:${tray.key}`}
                    >
                      <div className="audienceidentity">
                        <PersonFace
                          id={candidate.id}
                          label={candidate.label}
                        />
                        <span className="audiencecopy">
                          <strong>{candidate.label}</strong>
                          <span className="audiencesub">
                            {candidate.kind === "group"
                              ? candidate.rule
                              : "Person"}
                          </span>
                        </span>
                      </div>
                      <SegmentedControl
                        className="audiencechoices"
                        items={AUDIENCE_CHOICES.map(
                          (choice) => ({
                            ...choice,
                            isDisabled: isBusy,
                          }),
                        )}
                        key={`${candidate.kind}:${candidate.id}:${tray.key}`}
                        label={`Placement for ${candidate.label}`}
                        onChange={(next) =>
                          move(candidate, next)
                        }
                        selectedValue={tray.key}
                        size="sm"
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

import { Button } from "@charcuterie/ui"
import { useState } from "react"
import { api } from "../lib/api"
import {
  knownHowFor,
  knownHowLabel,
  knownHowProposal,
} from "../lib/boardGames"
import type { ActivityId } from "../lib/tonight"
import type { KnownHowClaim, Person } from "../lib/types"
import { setStatus } from "../state/store"
import { CheckboxGroup } from "./CheckboxGroup"

/**
 * "WE PLAYED THIS" — and it asks who, because that is the only question the log exists to
 * answer.
 *
 * ## The defect this component is
 *
 * The absorbed app logged a play as a game id and a timestamp and nothing else. Three plays,
 * no participants, ever. The write was fine; every screen called it with an empty list, so
 * the log could not say who had played anything. This control cannot be used without
 * answering that question — the button itself says how many people it is about to record, so
 * "nobody named" is a thing you choose out loud rather than a thing that happens to you.
 *
 * ## Known-how is MARKED BY DEFAULT, with customize and undo
 *
 * Not a second yes/skip prompt after the play. Sitting through a game is decent evidence you
 * can start it again, so finishing proposes that everyone at the table knows it, writes it,
 * and offers **Change** and **Undo** — settled shape, and the reason it is a proposal rather
 * than an inference matters:
 *
 * ⚠️ **A play may RENEW a claim and may never INVENT one.** Nothing here derives "knows the
 * rules" from a play count, and the server refuses to: logging a play runs an `UPDATE` on the
 * claims of whoever was at the table and never an `INSERT`. What creates a claim is a person
 * ticking a box — which is what this panel does, on their behalf, in front of them, with the
 * undo still on screen.
 *
 * ## The wording is per activity
 *
 * "Knows the rules" for a board game, "Knows how to play" for a video game. Same fact, and
 * not the same sentence — one is something you read, the other something you learn.
 *
 * ## Guests get no row
 *
 * A guest is a seat with no roster row, so there is nobody to attach a claim or an attendance
 * row to. They count towards the head count that chose the game and towards nothing after it,
 * and the panel says so rather than quietly dropping them.
 */
export function MarkPlayed({
  activity,
  defaultPersonIds,
  gameId,
  gameName,
  guestCount = 0,
  idPrefix,
  knownHow,
  onLogged,
  people,
}: {
  activity: ActivityId
  /** Who to tick when the panel opens — the table Tonight already knows about. */
  defaultPersonIds: readonly string[]
  gameId: string
  gameName: string
  guestCount?: number
  /** Stable ids for the browser gates. One panel per card, so one prefix per card. */
  idPrefix: string
  /** Every claim about THIS game, as the server last answered. */
  knownHow: readonly KnownHowClaim[]
  onLogged: () => void | Promise<void>
  people: readonly Person[]
}) {
  const [step, setStep] = useState<
    "choosing" | "customizing" | "done" | "idle"
  >("idle")
  const [chosen, setChosen] = useState<string[]>([
    ...defaultPersonIds,
  ])
  const [isBusy, setIsBusy] = useState(false)
  /** Who this finish CREATED a claim for. Exactly what Undo takes back — no more. */
  const [created, setCreated] = useState<string[]>([])
  /** Seeded from what the server last said, so "Change" opens on the truth even before
   * anything is logged. */
  const [known, setKnown] = useState<string[]>(
    knownHowFor(knownHow, gameId),
  )

  const label = knownHowLabel(activity)
  const nameOf = (id: string) =>
    people.find((person) => person.id === id)
      ?.displayName ?? id
  const listOf = (ids: readonly string[]) =>
    ids.map(nameOf).join(", ")

  /** One claim, stated or withdrawn. The ONLY door that creates one. */
  const setClaim = async (
    personId: string,
    isKnown: boolean,
  ) => {
    const res = await api<{ knownHow: KnownHowClaim[] }>(
      "POST",
      `/api/board-games/${encodeURIComponent(gameId)}/known`,
      { isKnown, personId },
    )
    setKnown(knownHowFor(res.knownHow, gameId))
  }

  const logPlay = async () => {
    setIsBusy(true)
    try {
      const res = await api<{ knownHow: KnownHowClaim[] }>(
        "POST",
        "/api/board-games/plays",
        { gameId, personIds: chosen },
      )

      // The default: everyone at the table is proposed as knowing it. Only the people who
      // had NOT already said so are written, so `created` is exactly what Undo owns — undoing
      // must never withdraw a claim somebody stated months ago.
      const already = knownHowFor(res.knownHow, gameId)
      const proposal = knownHowProposal(chosen).filter(
        (id) => !already.includes(id),
      )

      for (const personId of proposal) {
        await setClaim(personId, true)
      }

      setKnown([...new Set([...already, ...proposal])])
      setCreated(proposal)
      setStep("done")
      setStatus(
        chosen.length
          ? `Logged ${gameName} for ${listOf(chosen)}.`
          : `Logged ${gameName}. Nobody named.`,
      )
      await onLogged()
    } catch (e) {
      setStatus(
        `Could not log the play: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsBusy(false)
    }
  }

  /** Take back exactly the claims this finish created, and say so. */
  const undo = async () => {
    setIsBusy(true)
    try {
      for (const personId of created) {
        await setClaim(personId, false)
      }
      setStatus(
        `Undone — nobody's "${label.toLowerCase()}" changed.`,
      )
      setCreated([])
    } catch (e) {
      setStatus(
        `Could not undo that: ${(e as Error).message}`,
        "err",
      )
    } finally {
      setIsBusy(false)
    }
  }

  if (step === "idle") {
    return (
      <Button
        id={`${idPrefix}-played`}
        onClick={() => {
          setChosen([...defaultPersonIds])
          setStep("choosing")
        }}
        size="sm"
      >
        We played this
      </Button>
    )
  }

  if (step === "choosing") {
    return (
      <div className="markplayed" id={`${idPrefix}-panel`}>
        <p className="mplabel">Who played?</p>

        {people.length === 0 ? (
          // A real state, not a failure: the roster arrives with an owner-confirmed import
          // that no agent may run. The play still logs — it just cannot be attributed, and
          // saying that is better than a control that looks broken.
          <p
            className="subhint"
            id={`${idPrefix}-nopeople`}
          >
            No people yet. The roster arrives with the
            owner-confirmed import, so this play can be
            logged but not attributed.
          </p>
        ) : (
          <div className="mppeople">
            <CheckboxGroup
              checked={chosen}
              id={`${idPrefix}-people`}
              onToggle={(value, isChecked) =>
                setChosen((prev) =>
                  isChecked
                    ? [...prev, value]
                    : prev.filter((id) => id !== value),
                )
              }
              options={people.map((person) => ({
                label: person.displayName,
                value: person.id,
              }))}
              // The DEFAULT is the second writer — reopening the panel reseeds it. Never
              // key on `chosen`, which the user's own clicks write.
              seedKey={`${gameId}:${[...defaultPersonIds].join(",")}`}
            />
          </div>
        )}

        {guestCount > 0 ? (
          <p className="subhint">
            {guestCount} guest
            {guestCount === 1 ? "" : "s"} at the table. A
            guest has no roster row, so nothing is recorded
            against them.
          </p>
        ) : null}

        <div className="mpactions">
          <Button
            id={`${idPrefix}-log`}
            intent="accent"
            isDisabled={isBusy}
            onClick={() => void logPlay()}
            size="sm"
          >
            {chosen.length === 0
              ? "Log it · nobody named"
              : `Log it · ${chosen.length} ${chosen.length === 1 ? "person" : "people"}`}
          </Button>
          <Button
            id={`${idPrefix}-cancel`}
            isDisabled={isBusy}
            onClick={() => setStep("idle")}
            size="sm"
          >
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  if (step === "customizing") {
    return (
      <div className="markplayed" id={`${idPrefix}-panel`}>
        <p className="mplabel">{label}</p>
        <div className="mppeople">
          <CheckboxGroup
            checked={known}
            id={`${idPrefix}-known`}
            onToggle={(value, isChecked) => {
              // Written straight through, one tick per call — the same door the person
              // lookup uses to answer "yes, still".
              setKnown((prev) =>
                isChecked
                  ? [...prev, value]
                  : prev.filter((id) => id !== value),
              )
              setCreated((prev) =>
                isChecked
                  ? prev
                  : prev.filter((id) => id !== value),
              )
              void setClaim(value, isChecked).catch(
                (e: unknown) =>
                  setStatus(
                    `Could not save that: ${(e as Error).message}`,
                    "err",
                  ),
              )
            }}
            options={people.map((person) => ({
              label: person.displayName,
              value: person.id,
            }))}
            seedKey={`${gameId}:known:${known.join(",")}`}
          />
        </div>
        <div className="mpactions">
          <Button
            id={`${idPrefix}-donecustom`}
            onClick={() => setStep("done")}
            size="sm"
          >
            Done
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="markplayed" id={`${idPrefix}-panel`}>
      <p className="mplabel" id={`${idPrefix}-result`}>
        {chosen.length === 0
          ? "Logged. Nobody named."
          : `Logged for ${listOf(chosen)}.`}
      </p>
      <p className="subhint" id={`${idPrefix}-known-line`}>
        {known.length === 0
          ? `Nobody is marked as "${label.toLowerCase()}" for this one.`
          : `${label}: ${listOf(known)}.`}
      </p>
      <div className="mpactions">
        <Button
          id={`${idPrefix}-change`}
          isDisabled={isBusy || people.length === 0}
          onClick={() => setStep("customizing")}
          size="sm"
        >
          Change
        </Button>
        {created.length > 0 ? (
          <Button
            id={`${idPrefix}-undo`}
            isDisabled={isBusy}
            onClick={() => void undo()}
            size="sm"
          >
            Undo
          </Button>
        ) : null}
      </div>
    </div>
  )
}

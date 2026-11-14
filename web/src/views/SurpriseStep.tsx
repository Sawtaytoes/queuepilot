import { RadioGroup } from "@charcuterie/ui"
import { useState } from "react"
import { useNavigate } from "react-router"
import { writePickSession } from "../lib/pickSession"
import { SURPRISE_SCOPES } from "../lib/tonight"
import { drawSurprise } from "../lib/tonightDraw"
import { setStatus } from "../state/store"

/**
 * Surprise Me's second screen.
 *
 * Tapping the tile chooses nothing. It brings you here, you narrow down, and only then does
 * it choose — and the narrowing list is COARSER than the tile row: "media" is one entry
 * spanning Movies, Shows and YouTube, which is why it cannot be derived from `ACTIVITIES`.
 *
 * The owner approved Media, Games and Reading on 2026-08-28. Choosing one starts the draw:
 * the scope chooses an activity, then that activity's existing engine supplies the result.
 */
export function SurpriseStep({
  guestCount,
  selectedPeople,
}: {
  guestCount: number
  selectedPeople: readonly string[]
}) {
  const navigate = useNavigate()
  const [isDrawing, setIsDrawing] = useState(false)

  const choose = async (scopeId: string) => {
    const scope = SURPRISE_SCOPES.find(
      (one) => one.id === scopeId,
    )
    if (!scope || isDrawing) return

    setIsDrawing(true)
    try {
      const outcome = await drawSurprise({
        guestCount,
        personIds: selectedPeople,
        scope,
      })
      if (!outcome.isDrawn) {
        setStatus(outcome.reason, "err")
        return
      }
      writePickSession(outcome.session)
      navigate("/result")
    } catch (error) {
      setStatus(
        `Could not pick: ${(error as Error).message}`,
        "err",
      )
    } finally {
      setIsDrawing(false)
    }
  }

  return (
    <section className="tsection" id="tonight-surprise">
      <h2 className="tlabel">Narrow it down</h2>
      <RadioGroup
        itemShape="tile"
        items={SURPRISE_SCOPES.map((scope) => ({
          hint: scope.hint,
          isDisabled: isDrawing,
          label: scope.label,
          value: scope.id,
        }))}
        label="Narrow it down"
        onChange={(value) => {
          if (value) void choose(value)
        }}
      />
      {isDrawing ? (
        <p className="subhint" role="status">
          Choosing from that group…
        </p>
      ) : null}
    </section>
  )
}

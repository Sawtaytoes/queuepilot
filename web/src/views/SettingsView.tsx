import { Alert, Button, Card, Field } from "@charcuterie/ui"
import { Lock, LockOpen, Tv } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { api } from "../lib/api"
import { queueNumbers, queueTitle } from "../lib/people"
import { usePeople } from "../state/people"
import { useStore } from "../state/store"

const PIN_PATTERN = /^[0-9]{4,8}$/

/**
 * SETTINGS — household settings that belong to no single queue.
 *
 * Today that is the QueuePilot TV PIN (decision
 * `2026-10-23-the-native-tv-plays-each-queue-as-its-own-profile-and-locks-queues-with-a-pin`).
 * A queue is marked "Locked on TV" in its own settings; this is the one PIN that opens every
 * locked queue on the TV. The server keeps only a hash and never sends the PIN back, so this
 * page can say whether a PIN exists and replace or clear it — it can never show it.
 */
export function SettingsView() {
  const { reg } = useStore()
  const people = usePeople()
  const [hasPin, setHasPin] = useState<boolean | null>(null)
  const [pin, setPin] = useState("")
  const [message, setMessage] = useState<{
    intent: "danger" | "success"
    text: string
  } | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    api<{ hasPin: boolean }>("GET", "/api/tv-lock")
      .then((answer) => setHasPin(answer.hasPin))
      .catch(() => setHasPin(null))
  }, [])

  const sets = useMemo(() => reg?.sets ?? [], [reg])
  const numbers = useMemo(
    () => queueNumbers(sets, people.byQueue),
    [people.byQueue, sets],
  )
  const lockedQueues = sets.filter(
    (set) => set.is_locked_on_tv,
  )
  const isPinValid = PIN_PATTERN.test(pin)

  const save = async () => {
    if (!isPinValid) return
    setIsSaving(true)
    try {
      await api("PUT", "/api/tv-lock/pin", { pin })
      setHasPin(true)
      setPin("")
      setMessage({
        intent: "success",
        text: "The TV PIN is saved. Every TV must enter the new PIN to open a locked queue.",
      })
    } catch (error) {
      setMessage({
        intent: "danger",
        text: `The TV PIN was not saved: ${(error as Error).message}`,
      })
    } finally {
      setIsSaving(false)
    }
  }

  const clear = async () => {
    setIsSaving(true)
    try {
      await api("DELETE", "/api/tv-lock/pin")
      setHasPin(false)
      setMessage({
        intent: "success",
        text: "The TV PIN is removed. No queue is locked on the TV now.",
      })
    } catch (error) {
      setMessage({
        intent: "danger",
        text: `The TV PIN was not removed: ${(error as Error).message}`,
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="settings-management" id="settings">
      <Card heading="QueuePilot TV PIN">
        <p
          className="settings-line"
          data-is-loaded={hasPin !== null}
          data-testid="tv-pin-status"
        >
          <Tv aria-hidden="true" size={20} />
          {hasPin === null
            ? "Loading the TV PIN status…"
            : hasPin
              ? "A TV PIN is set. The TV asks for it before it opens a queue that is locked on the TV."
              : "No TV PIN is set. No queue is locked on the TV, even a queue that is marked locked."}
        </p>
        <form
          className="settings-pin-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Field
            autoComplete="off"
            description="4 to 8 digits. The TV uses a number pad."
            id="tv-pin"
            inputMode="numeric"
            label={hasPin ? "New TV PIN" : "TV PIN"}
            maxLength={8}
            onChange={(event) =>
              setPin(
                event.currentTarget.value.replace(
                  /[^0-9]/g,
                  "",
                ),
              )
            }
            pattern="[0-9]{4,8}"
            type="password"
            value={pin}
          >
            <input />
          </Field>
          <div className="settings-pin-actions">
            <Button
              intent="accent"
              isDisabled={!isPinValid || isSaving}
              type="submit"
            >
              <Lock aria-hidden="true" size={16} />
              {hasPin ? "Change PIN" : "Set PIN"}
            </Button>
            {hasPin ? (
              <Button
                appearance="outline"
                intent="neutral"
                isDisabled={isSaving}
                onClick={() => void clear()}
              >
                <LockOpen aria-hidden="true" size={16} />
                Remove PIN
              </Button>
            ) : null}
          </div>
        </form>
        {message ? (
          <Alert
            heading={message.text}
            intent={message.intent}
          />
        ) : null}
      </Card>

      <Card heading="Queues locked on the TV">
        <p
          className="settings-line"
          data-testid="tv-locked-queues"
        >
          <Lock aria-hidden="true" size={20} />
          {lockedQueues.length
            ? lockedQueues
                .map((set) =>
                  queueTitle(
                    set,
                    numbers.get(set.id) ?? null,
                  ),
                )
                .join(", ")
            : "No queue is marked. Open a queue's settings and turn on “Locked on TV” to lock it."}
        </p>
      </Card>
    </div>
  )
}

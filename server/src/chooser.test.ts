import { afterEach, expect, test, vi } from "vitest"
import {
  type ChooserState,
  createChooser,
} from "./chooser.js"

const harness = () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const catalog = vi.fn(async (people: string[]) =>
    people.includes("ada")
      ? [
          { id: "films", title: "Movies", kind: "picks" },
          { id: "series", title: "Shows", kind: "rules" },
        ]
      : [],
  )
  const publish = vi.fn()
  const chooser = createChooser({
    catalog,
    person: (id) =>
      ["ada", "grace"].includes(id)
        ? { id, name: id }
        : undefined,
    publish,
  })
  const scan = (
    personId: string,
    eventId = `${personId}-${Date.now()}`,
    reader = "desk",
  ) =>
    chooser.handle(reader, {
      action: "scan",
      personId,
      eventId,
      atMs: Date.now(),
    })
  const state = () =>
    publish.mock.lastCall?.[1] as ChooserState
  const action = (name: string, rest = {}) =>
    chooser.handle("desk", {
      action: name,
      sessionId: state().sessionId,
      revision: state().revision,
      ...rest,
    })
  return { chooser, catalog, publish, scan, state, action }
}
afterEach(() => vi.useRealTimers())
test("scans accumulate only within a reader, never play, and duplicate delivery does not add or reopen", async () => {
  const fixture = harness()
  await fixture.scan("ada", "one")
  await fixture.scan("grace", "two")
  expect(
    fixture.state().people.map((person) => person.id),
  ).toEqual(["ada", "grace"])
  expect(
    fixture.publish.mock.calls.map((call) => call[2]),
  ).toEqual(["show", "show"])
  await fixture.action("dismiss")
  await fixture.scan("ada", "one")
  expect(fixture.state().isActive).toBe(false)
  await fixture.scan("grace", "three", "other")
  expect(
    fixture.state().people.map((person) => person.id),
  ).toEqual(["grace"])
  fixture.chooser.clear()
})
test("inactivity ends at sixty seconds after the last interaction and the next scan starts empty", async () => {
  const fixture = harness()
  await fixture.scan("ada")
  await vi.advanceTimersByTimeAsync(59_000)
  await fixture.action("touch")
  await vi.advanceTimersByTimeAsync(59_000)
  expect(fixture.state().isActive).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(fixture.state().isActive).toBe(false)
  await fixture.scan("grace")
  expect(
    fixture.state().people.map((person) => person.id),
  ).toEqual(["grace"])
  fixture.chooser.clear()
})
test("stale frames, unknown people, old scans and ineligible queues never request playback", async () => {
  const fixture = harness()
  await fixture.scan("stranger")
  expect(fixture.publish).not.toHaveBeenCalled()
  await fixture.chooser.handle("desk", {
    action: "scan",
    personId: "ada",
    atMs: 1,
    eventId: "old",
  })
  expect(fixture.publish).not.toHaveBeenCalled()
  await fixture.scan("ada")
  const old = fixture.state()
  await fixture.scan("grace")
  await fixture.chooser.handle("desk", {
    action: "choose",
    sessionId: old.sessionId,
    revision: old.revision,
    queueId: "films",
  })
  await fixture.action("choose", { queueId: "missing" })
  expect(
    fixture.publish.mock.calls.some(
      (call) => call[2] === "play",
    ),
  ).toBe(false)
  await fixture.action("remove", { personId: "ada" })
  expect(fixture.state().queues).toEqual([])
  await fixture.action("remove", { personId: "grace" })
  expect(fixture.state().isActive).toBe(false)
  fixture.chooser.clear()
})
test("tap revalidates eligibility and dispatches exactly once before dismissing", async () => {
  const fixture = harness()
  await fixture.scan("ada")
  const current = fixture.state()
  const input = {
    action: "choose",
    sessionId: current.sessionId,
    revision: current.revision,
    queueId: "series",
  }
  await Promise.all([
    fixture.chooser.handle("desk", input),
    fixture.chooser.handle("desk", input),
  ])
  expect(
    fixture.publish.mock.calls.filter(
      (call) => call[2] === "play",
    ),
  ).toHaveLength(1)
  expect(fixture.publish.mock.lastCall?.[3]).toEqual({
    id: "series",
    title: "Shows",
    kind: "rules",
  })
  expect(fixture.state().isActive).toBe(false)
  fixture.chooser.clear()
})
test("a delayed catalog cannot play after the selection expires", async () => {
  const fixture = harness()
  await fixture.scan("ada")
  const original = fixture.catalog.getMockImplementation()!
  fixture.catalog.mockImplementation(async (people) => {
    await new Promise((resolve) =>
      setTimeout(resolve, 61_000),
    )
    return original(people)
  })
  const pending = fixture.action("choose", {
    queueId: "films",
  })
  await vi.advanceTimersByTimeAsync(61_000)
  await pending
  expect(
    fixture.publish.mock.calls.some(
      (call) => call[2] === "play",
    ),
  ).toBe(false)
  fixture.chooser.clear()
})

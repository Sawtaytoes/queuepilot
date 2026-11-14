import { describe, expect, test } from "vitest"
import { defined } from "./defined.js"

describe("defined", () => {
  test("returns a present value, falsy ones included", () => {
    expect(defined("card")).toBe("card")
    expect(defined(0)).toBe(0)
    expect(defined("")).toBe("")
    expect(defined(false)).toBe(false)
  })

  test("throws for undefined and null", () => {
    expect(() => defined(undefined)).toThrow(
      "Expected a value, but it was undefined",
    )
    expect(() => defined(null)).toThrow(
      "Expected a value, but it was null",
    )
  })

  test("names the value in the error when given a label", () => {
    expect(() => defined(undefined, "the queue")).toThrow(
      "Expected the queue, but it was undefined",
    )
  })
})

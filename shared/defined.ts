/**
 * `value`, or a thrown error when it is `null` or `undefined`.
 *
 * For a value the code knows is there but the type cannot show: the
 * row an insert just wrote, the first match of a regex that matched,
 * the fixture a test just made. Unlike a `!` assertion, a wrong
 * assumption fails here, with a message, instead of somewhere later.
 *
 * `label` names the value in that message, so a failure says which
 * assumption broke.
 */
export const defined = <Value>(
  value: Value | null | undefined,
  label = "a value",
): Value => {
  if (value === null || value === undefined) {
    throw new Error(
      `Expected ${label}, but it was ${value}`,
    )
  }
  return value
}

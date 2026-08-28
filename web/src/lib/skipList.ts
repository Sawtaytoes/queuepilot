/**
 * The set's `skipped` list, edited a WHOLE ENTRY at a time.
 *
 * `skipQueueItem` writes one key at a time, which is right for the tile menu — "not this
 * one", once. The member list is the other shape: it shows every item inside one entry and
 * saves the whole answer at once, so it has to add and REMOVE keys in one write, and it must
 * not touch a key belonging to a different entry.
 *
 * That is the entire reason this is a function rather than an array spread at the call site.
 * The list is per SET, not per entry (matching a filtered pool's `blocklist`), so a naive
 * "replace `skipped` with what this panel shows" would clear every other entry's skips —
 * which is a silent data loss nobody would notice until a skipped episode played.
 */
export function mergeSkipped({
  current,
  managed,
  skipped,
}: {
  /** The set's `skipped` list as it stands. */
  current: readonly string[]
  /** Every key the panel is responsible for — the entry's members / episodes. */
  managed: Iterable<string>
  /** Which of `managed` must end up skipped. */
  skipped: Iterable<string>
}): string[] {
  const owned = new Set(managed)
  const want = new Set(skipped)
  // Order matters: the untouched keys keep the file's order, so a save does not reshuffle
  // another entry's rows in the Skipped panel. The panel's own keys land after them, in the
  // order the panel lists them.
  const kept = current.filter((key) => !owned.has(key))
  const added = [...owned].filter((key) => want.has(key))

  return [...kept, ...added]
}

/** Merge one entry's selective-special opt-ins without touching another entry's choices. */
export function mergeIncludedSpecials({
  current,
  managed,
  included,
}: {
  current: readonly string[]
  managed: Iterable<string>
  included: Iterable<string>
}): string[] {
  return mergeSkipped({
    current,
    managed,
    skipped: included,
  })
}

/** Does this save change anything? A PATCH that writes the identical list still costs a
 *  Plex re-resolve and still says "Saved", so the modal asks first. */
export function isSkipListChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  if (before.length !== after.length) return true

  const seen = new Set(before)

  return after.some((key) => !seen.has(key))
}

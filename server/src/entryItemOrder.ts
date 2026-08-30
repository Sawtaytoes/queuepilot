/** The per-entry order for playable leaves inside a Picks show or Collection. */
export type EntryItemOrder = 'in-order' | 'shuffle';

/**
 * Unknown and legacy values preserve the existing in-order behavior. Only the non-default
 * value is stored, so a typo must not silently turn a progress entry into a replay entry.
 */
export function normalizeEntryItemOrder(value: unknown): EntryItemOrder {
  return String(value ?? '').trim().toLowerCase() === 'shuffle' ? 'shuffle' : 'in-order';
}

import type { EntryValue, Start } from './types.js';

export type WatchHistorySource = 'provider' | 'queue';

/** Tolerant read rule for hand-edited YAML. Anything unknown keeps the safe provider default. */
export function normalizeWatchHistory(value: unknown): WatchHistorySource | null {
  const source = String(value ?? '').trim().toLowerCase();
  return source === 'provider' || source === 'queue' ? source : null;
}

/** The entry's explicit source. `start.history` is the compatibility read for the first model. */
export function storedEntryWatchHistory(value: EntryValue): WatchHistorySource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const direct = normalizeWatchHistory(value.watch_history);
  if (direct) return direct;
  return normalizeWatchHistory((value.start as Start | null | undefined)?.history);
}

/** Entry override, then queue default, then the product default: provider history. */
export function effectiveWatchHistory(
  value: EntryValue,
  queueDefault: unknown,
): WatchHistorySource {
  return storedEntryWatchHistory(value) ?? normalizeWatchHistory(queueDefault) ?? 'provider';
}

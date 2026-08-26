// The lead cooldown as a pure value: how long a promoted entry stays led-out.
//
// It lives here rather than in `promote.ts` — where it was written and from where it is still
// re-exported — because `promote.ts` reaches the book of record, and `engine/resolve.ts` must
// not. The engine is the deterministic core the parity corpus replays with no SQLite anywhere
// near it; a duration parser is exactly the part of promote it is allowed to know.

/** Product default when neither the entry nor the set names a window. */
export const DEFAULT_PROMOTE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Parse a promote_window duration (`24h`, `7d`, `30d`, `90m`, …) to milliseconds.
 * Returns null for blank / unrecognised (caller treats as "no window" / default).
 */
export function parsePromoteWindow(raw: unknown): number | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!;
  const mult = unit === 'ms' ? 1
    : unit === 's' ? 1000
      : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
          : 86_400_000; // d
  return n * mult;
}

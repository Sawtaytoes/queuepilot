// Background cache warmer (B6).
//
// The point: "post-deploy first load is always fully cold." Because the SQLite cache now
// survives restarts (it is a file, not an in-process Map), the warmer usually has nothing to
// do — but on a genuinely cold cache (first ever boot, or after someone `rm`'d it) it resolves
// every curated tile before a human asks, off the critical path. It re-runs every 10 minutes
// and on each SSE `data` event (debounced 5 s), so a fresh hand-edit warms too.
//
// This deliberately reuses the SAME code path the request handler uses (queues.listAll +
// tiles.resolveTile) rather than a parallel prefetch list, so the warmer can never warm the
// cache into a shape the request path won't hit. Low-priority: bounded concurrency, every
// failure swallowed — a warm miss just means the first real request pays for that one tile.
import * as queues from './queues.js';
import * as sets from './sets.js';
import * as tiles from './tiles.js';
import type { EntryValue, Start } from './types.js';

const WARM_INTERVAL_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 5000;
const CONCURRENCY = 4;

/**
 * One tile to warm: exactly the three arguments `tiles.resolveTile()` takes. Local rather
 * than in types.ts because it is this file's private work-queue row, not a domain shape —
 * nothing else builds or reads it.
 */
interface WarmJob {
  sections: number[];
  value: EntryValue;
  start: Start | null;
}

let isRunning = false;
let debounce: NodeJS.Timeout | undefined;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => unknown): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          // `idx < items.length` was just checked, so the read is in bounds —
          // noUncheckedIndexedAccess cannot see that.
          await fn(items[idx] as T);
        } catch {
          /* a warm miss is harmless — the first real request pays for it */
        }
      }
    }),
  );
}

async function warmOnce(): Promise<void> {
  if (isRunning) return; // never overlap a run with itself
  isRunning = true;
  try {
    const reg = await sets.getRegistry();
    const all = await queues.listAll();
    const work: WarmJob[] = [];
    for (const s of reg.sets) {
      if (s.source !== 'queue') continue;
      for (const e of all.get(s.id) || []) {
        const start = e.value && typeof e.value === 'object' && e.value.start ? e.value.start : null;
        work.push({ sections: s.sections, value: e.value, start });
      }
    }
    if (!work.length) return;
    await mapLimit(
      work,
      CONCURRENCY,
      ({ sections, value, start }: WarmJob) => tiles.resolveTile(sections, value, start),
    );
  } catch {
    /* Plex or config unreadable — try again next tick */
  } finally {
    isRunning = false;
  }
}

// Kick a warm, debounced — the SSE `data` handler calls this on every file change, and a burst
// of edits should coalesce into one warm rather than one per keystroke-over-SMB.
export function kick(): void {
  clearTimeout(debounce);
  debounce = setTimeout(() => void warmOnce(), DEBOUNCE_MS);
}

// Start the warmer. Called once after app.listen — a slight delay so it never competes with
// the first real page load, then every 10 minutes.
export function start(): void {
  setTimeout(() => void warmOnce(), 3000).unref?.();
  setInterval(() => void warmOnce(), WARM_INTERVAL_MS).unref?.();
}

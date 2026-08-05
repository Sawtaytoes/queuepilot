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

const WARM_INTERVAL_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 5000;
const CONCURRENCY = 4;

let running = false;
let debounce = null;

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          await fn(items[idx]);
        } catch {
          /* a warm miss is harmless — the first real request pays for it */
        }
      }
    }),
  );
}

async function warmOnce() {
  if (running) return; // never overlap a run with itself
  running = true;
  try {
    const reg = await sets.getRegistry();
    const all = await queues.listAll();
    const work = [];
    for (const s of reg.sets) {
      if (s.source !== 'queue') continue;
      for (const e of all.get(s.id) || []) {
        const start = e.value && typeof e.value === 'object' && e.value.start ? e.value.start : null;
        work.push({ sections: s.sections, value: e.value, start });
      }
    }
    if (!work.length) return;
    await mapLimit(work, CONCURRENCY, ({ sections, value, start }) => tiles.resolveTile(sections, value, start));
  } catch {
    /* Plex or config unreadable — try again next tick */
  } finally {
    running = false;
  }
}

// Kick a warm, debounced — the SSE `data` handler calls this on every file change, and a burst
// of edits should coalesce into one warm rather than one per keystroke-over-SMB.
export function kick() {
  clearTimeout(debounce);
  debounce = setTimeout(() => void warmOnce(), DEBOUNCE_MS);
}

// Start the warmer. Called once after app.listen — a slight delay so it never competes with
// the first real page load, then every 10 minutes.
export function start() {
  setTimeout(() => void warmOnce(), 3000).unref?.();
  setInterval(() => void warmOnce(), WARM_INTERVAL_MS).unref?.();
}

// The lineup a PULL set draws, in ONE place.
//
// This used to live inside `launchDescriptor`, which was fine while a launch was the only
// thing that ever built one. Then top-up needed the same lineup — and the version it had
// (`provider.buckets({ setName, cfg, binding, token })`, the Plex-shaped call) omitted
// `entries`, which for a CURATED reading queue is the difference between the owner's
// ninety-three series and the whole library shelf. That is the exact bug the `buckets()`
// header already records from the launch path; a second caller with its own copy of the call
// is how it was going to happen a second time.
//
// So: one builder, both callers. A launch rebuilds the reading list from it; a top-up appends
// from it. Neither knows how the other spells the arguments, because there is only one
// spelling.
import * as queues from '../queues.js';
import { splitEntry } from '../queues.js';
import { resolveSingle } from './blocks.js';
import type { BlockSourceCfg } from './blocks.js';
import type { CuratedEntryRef, PlayItem, Provider, RoutingSetCfg } from '../types.js';

/** A batch value off the YAML, or null when it is absent/unusable (never 0 — see setBatch). */
export const toBatch = (raw: unknown): number | null => {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A curated set's entries, reduced to `{ id, batch }` for a pull provider.
 *
 * DONE entries are dropped: a consuming queue marks them, and a reading list rebuilt from
 * them would re-serve what has already been read. A `keep_completed` / reel queue never
 * marks anything done, so nothing is dropped there and the flag needs no special case here.
 *
 * Returns `[]` for a rule-based channel, which is what tells `buckets()` to fall back to the
 * libraries — see the note on `BucketsContext.entries`.
 */
export async function curatedEntries(
  setId: string,
  only: string | null = null,
  { stampQueued = false }: { stampQueued?: boolean } = {},
): Promise<CuratedEntryRef[]> {
  let rows;
  try {
    rows = await queues.listSet(setId);
  } catch {
    // A missing/unparseable queues.yaml must not make a launch fail with a stack trace —
    // no entries reads as "rule-based", which is the pre-existing behaviour.
    return [];
  }
  const out: CuratedEntryRef[] = [];
  for (const e of rows) {
    // "Read THIS one now" — the ▶ on a single tile. A named entry is taken even when it is
    // marked done, because asking for it by key is an explicit choice; the `done` skip below
    // is for the unfiltered lineup, where re-serving finished reading is the bug.
    if (only) {
      if (e.key !== only) continue;
    } else if (e.done) continue;
    const { ratingKey, extras } = splitEntry(e.value);
    // A pull provider's items are addressed by the provider's own id, which an entry stores
    // in `ratingKey`. A title-only entry (no id) cannot be resolved against Kavita at all,
    // so it is skipped rather than guessed at by name.
    if (!ratingKey) continue;
    const batch = Number(extras.episodes);
    const volumes = Number(extras.volumes);
    const start = extras.start && typeof extras.start === 'object' ? extras.start : null;
    // Only for a provider that ASKED for it (Provider.stampsQueuedAt) — a Plex or Kavita
    // queue must not grow a key nothing will ever read. An entry added by hand has no
    // stamp; it gets one now rather than being read as "since the beginning of time",
    // which on a lifetime play log means "already finished".
    const stored = Number(extras.queued_at);
    let queuedAt = Number.isFinite(stored) && stored > 0 ? stored : null;
    if (stampQueued && queuedAt == null && e.key) {
      queuedAt = await queues.stampQueuedAt(setId, e.key);
    }
    out.push({
      id: String(ratingKey),
      batch: Number.isFinite(batch) && batch > 0 ? batch : null,
      volumes: Number.isFinite(volumes) && volumes > 0 ? volumes : null,
      queuedAt,
      start,
    });
  }
  return out;
}

/**
 * What a pull set would play right now, in lineup order.
 *
 * `only` names a single entry ("read THIS one"), which is a launch-side affordance — a
 * top-up never passes it, because a background tick has nobody's tap behind it.
 */
export async function pullLineup(
  setId: string,
  cfg: RoutingSetCfg,
  provider: Provider,
  { only = null }: { only?: string | null } = {},
): Promise<PlayItem[]> {
  const block = resolveSingle({ ...cfg } as BlockSourceCfg);
  const { play } = await provider.buckets({
    cfg,
    // A single named entry is not the queue's own pool, so the library fallback must not
    // apply: if that one entry has nothing unread the answer is "nothing left", never the
    // whole shelf.
    libraries: only ? [] : block.libraries,
    // What the owner actually put in this queue. Without it a curated reading queue plays
    // the library shelf instead of its own ninety-three entries.
    entries: await curatedEntries(setId, only, { stampQueued: provider.stampsQueuedAt === true }),
    // Same rule playbackRoutes uses to call a curated set random: `kind: anime` is the
    // "members play in random order" channel the editor offers.
    isRandomOrder: cfg.kind === 'anime',
    // The queue's own per-visit batch, overridable per entry inside buckets(). Same
    // precedence the Plex resolver uses (entry > set > env): `cfg.episodes` is the SET's,
    // and the block's older `batch` is honoured beneath it so a hand-written providers.yaml
    // keeps working.
    batch: toBatch(cfg.episodes) ?? block.batch ?? null,
    // Volumes are not chapters. A volume-based series reads this, never `batch`.
    // Absent = 1 inside the provider — never fall through to the chapter count.
    volumeBatch: toBatch(cfg.volumes) ?? null,
  });
  return play || [];
}

// ENTRY IDENTITY — which ITEM an entry names, as opposed to which LINE it occupies.
//
// A queue entry carries one of two identities on disk, and until now nothing reconciled them:
//
//     - "Detectives These Days Are Crazy!"                  a bare TITLE
//     - { ratingKey: 41234, title: "Detectives … (2024)" }   a RATING KEY
//
// `queues.entryKey()` answers "which LINE is this?" — `title:Detectives These Days Are Crazy!`
// for the first, `rk:41234` for the second. That is the right answer for what it does: address
// a line for a reorder, a move or a remove, byte-compatible with the Python writer that edits
// the same file. It is PINNED for that reason and this module does not touch it.
//
// It is the wrong question for two other callers, and both were wrong in production:
//
//   * Pending's coverage test asked "does a queue already name this item?" while reading only
//     rating keys, so the owner's 84 title-only entries covered nothing at all and every one
//     of those shows kept being reported as new.
//   * The add path deduped on `entryKey`, so adding by rating key an item a TITLE line already
//     named produced a SECOND copy — the owner ended up with two "Detectives" in one anime
//     queue and removed one by hand.
//
// So this module answers the ITEM question, and answers it with the ENGINE's own resolver
// (`engine/resolve.resolveQueueEntry`) rather than a third title matcher. "Covered" and
// "duplicate" then mean exactly what "is going to play" means, which is the whole premise of
// 2026-08-17-pending-is-what-nothing-will-play.
import { describe, resolveQueueEntry } from './engine/resolve.js';
import { mapLimit } from './routes/mapLimit.js';
import type { ResolveCfg } from './engine/resolve.js';
import type { PlexClient, QueueEntry } from './types.js';

/** A Plex auth token as this layer passes it: null = the admin/default `X-Plex-Token`. */
type Token = string | null;

/**
 * The rating key an entry names, or null when nothing in the library answers to it.
 *
 * A rating key entry is free — it IS an item identity, so there is no Plex call. A title entry
 * costs one section query per section the set draws from, first hit wins, exactly as the engine
 * pays when it builds a play list. A `Collection: <name>` entry returns null: a collection is
 * not an item, and its members are expanded by the caller that cares (see `pending.ts`).
 */
export async function itemKeyOf(
  client: PlexClient,
  cfg: ResolveCfg,
  value: unknown,
  token: Token = null,
): Promise<string | null> {
  const desc = describe(value);
  if (desc.ratingKey) return desc.ratingKey;
  if (desc.collection || !desc.title) return null;
  const [ratingKey] = await resolveQueueEntry(client, desc, cfg, token);
  return ratingKey;
}

/** The entry that already names the same item, as `findDuplicateItem` reports it. */
export interface DuplicateHit {
  /** The EXISTING line's `entryKey` — what a remove or a reorder would address it by. */
  key: string;
  /** The rating key both entries resolve to. */
  ratingKey: string;
}

/** `findDuplicateItem`'s knobs. */
export interface DuplicateOptions {
  token?: Token;
  /**
   * Milliseconds the title pass may spend before the check gives up and reports "no duplicate".
   *
   * The check must never be the reason an add hangs. With Plex unreachable every title lookup
   * costs three attempts at an 8 s timeout, so an unbounded scan of a forty-entry queue would
   * hold the request open for minutes to answer a question that only PREVENTS work. Failing
   * open here re-creates the old behaviour (the duplicate lands) for the seconds Plex is down,
   * which is strictly better than an add that appears to have frozen.
   */
  budgetMs?: number;
}

/** How many title lookups run at once. Matches the tile fan-out in `/api/queues`. */
const RESOLVE_CONCURRENCY = 6;

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * The existing entry in `entries` that names the SAME ITEM as `value`, or null.
 *
 * This is the second, LOOSER identity test the duplicate check needs — deliberately separate
 * from `entryKey`, which stays exactly as it is. `addItem` still refuses an exact key repeat;
 * this catches the case `entryKey` cannot see, where the same item is named two different ways.
 *
 * Scoped on purpose:
 *
 *   * Only an incoming value that CARRIES a rating key is checked. Every add from the UI does
 *     (Pending, the toolbar search, the queue search row), and it is what makes the free pass
 *     below possible. A hand-typed title add is left to `entryKey`'s exact-title test rather
 *     than paying to resolve both sides of a comparison.
 *   * A COLLECTION is not an item and is never reported. Whether adding a film that a queued
 *     collection contains should be refused is a real question, and a different one — it is
 *     coverage, not identity, and answering it here would silently refuse an add the owner may
 *     well mean.
 */
export async function findDuplicateItem(
  client: PlexClient,
  cfg: ResolveCfg,
  entries: readonly QueueEntry[],
  value: unknown,
  { token = null, budgetMs = 3000 }: DuplicateOptions = {},
): Promise<DuplicateHit | null> {
  const desc = describe(value);
  if (desc.collection) return null;
  const want = desc.ratingKey;
  if (!want) return null;

  // Pass 1, free: an entry that already carries a rating key needs no resolution at all.
  // Collects the title-only lines on the way past, so the file is walked once.
  const titled: QueueEntry[] = [];
  for (const entry of entries) {
    const d = describe(entry.value);
    if (d.ratingKey) {
      if (d.ratingKey === want) return { key: entry.key, ratingKey: want };
      continue;
    }
    if (d.collection || !d.title) continue;
    titled.push(entry);
  }
  if (!titled.length) return null;

  // Pass 2: the title lines, resolved through the engine. Short-circuits — once one matches
  // the rest of the fan-out stops starting new lookups.
  let hit: DuplicateHit | null = null;
  const scan = mapLimit(titled, RESOLVE_CONCURRENCY, async (entry) => {
    if (hit) return;
    const ratingKey = await itemKeyOf(client, cfg, entry.value, token);
    if (ratingKey === want && !hit) hit = { key: entry.key, ratingKey };
  });
  await Promise.race([scan, sleep(budgetMs)]);
  return hit;
}

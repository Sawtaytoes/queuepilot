// A FILTERED QUEUE — a queue that is a narrower view of another queue.
//
// `sets.yaml`:
//
//     - id: webtoons
//       label: Webtoons
//       filtered_from: manga_webtoons
//       filter:
//         libraries: [ "5" ]
//
// That is the whole record. Everything else — the provider block, the entries, the lanes, the
// per-visit batch, the skip list, the done flags — belongs to the PARENT and is read through
// it. A filtered queue owns exactly three things: its id, its name, and its filter.
//
// ## Why it is a view and not a copy
//
// The owner's case is one library that reads badly on one device. "Manga & Webtoons" holds
// both, and a mixed reading list bounces Kavita's reader between two variants
// (Kareadita/Kavita#4859 — see `providers/kavita.ts materialize()`), so on a phone the manga
// pages come out wrong. He wants the same queue with only the webtoons in it, and he wants to
// keep reading the same run: what he finishes on the phone must be finished on the tablet.
//
// A copy could not do that. Two lists of entries drift the moment either one is added to, and
// two sets of done flags are two different answers to "where am I". So the filter is applied
// at READ time and nothing is duplicated:
//
//   * ENTRIES and DONE FLAGS live under the parent's key in `queues.yaml`. `queues.ts` routes
//     every read and every write through `entryOwner()`, so adding a series from the filtered
//     queue's page adds it to the parent, and finishing one finishes it for both.
//   * The RUNTIME ARTIFACT is the one thing that is not shared. A reading list is what the
//     reader actually walks, and the whole point is that this one holds fewer things — so a
//     filtered queue names and titles its own Kavita list (`QueuePilot — Webtoons`), beside
//     the parent's, and neither rebuild touches the other.
//
// ## What a filter can say today
//
// `libraries` only, in the provider's own library ids. That is the owner's case and it is the
// one filter every provider block already speaks, so it needs no new vocabulary. The shape is
// a MAPPING rather than a bare list precisely so the next one (people, content rating, format)
// is a new key here and not a second field on every set.
//
// ## What is deliberately NOT here
//
// Filtering a PUSH queue (Plex) end to end. The read paths below are provider-neutral, but a
// Plex queue's progress is also written on the session/`finished.ts` path, which is keyed on
// the set id it was launched under and is not routed through `entryOwner()`. A filtered Plex
// queue would therefore record its watches against itself. Kavita has no such path — the read
// state lives in Kavita and is the same state either way — which is why the reading case is
// complete and the watching case is a documented follow-up.
import type { ProviderBlock, QueueFilter } from './types.js';

/** The on-disk key naming the parent. */
export const FILTERED_FROM = 'filtered_from';

/** The subset of a raw `sets:` entry this module reads. Anything else rides through. */
export interface FilterableEntry {
  id?: unknown;
  filtered_from?: unknown;
  filter?: unknown;
  providers?: unknown;
  [field: string]: unknown;
}

const toIdList = (v: unknown): string[] => (
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []
);

/** The parent queue's id, or null when this entry is an ordinary queue. */
export function parentIdOf(ent: FilterableEntry | null | undefined): string | null {
  const raw = ent ? ent[FILTERED_FROM] : null;
  const id = raw == null ? '' : String(raw).trim();
  return id || null;
}

/**
 * The entry's filter, or null when it has none.
 *
 * A filtered queue with an EMPTY filter is still a filtered queue — it just narrows nothing
 * yet, which is what a half-configured one looks like. Returning a filter with empty lists
 * rather than null keeps "is this a view" and "what does it exclude" two separate questions.
 */
export function filterOf(ent: FilterableEntry | null | undefined): QueueFilter | null {
  if (!parentIdOf(ent)) return null;
  const raw = ent && ent.filter && typeof ent.filter === 'object' && !Array.isArray(ent.filter)
    ? ent.filter as { libraries?: unknown }
    : {};
  return { libraries: toIdList(raw.libraries) };
}

/**
 * Does an item pass the filter? `libraryId` is the provider's own id for the library the item
 * sits in; an item that cannot say (a provider with no library concept, or a lookup that
 * failed) is KEPT.
 *
 * Kept and not dropped, deliberately: a filter is a narrowing of a list the owner curated by
 * hand, and silently losing one of his entries because a metadata read hiccuped is worse than
 * showing one that does not belong. The lineup shows it; he can see it is wrong.
 */
export function passesFilter(
  filter: QueueFilter | null,
  { libraryId = null }: { libraryId?: string | number | null | undefined },
): boolean {
  if (!filter || !filter.libraries.length) return true;
  if (libraryId == null || String(libraryId) === '') return true;
  return filter.libraries.includes(String(libraryId));
}

/**
 * The parent's provider blocks, narrowed to the filter's libraries.
 *
 * The block is what `search` and the pool preview scope themselves to, so a filtered queue
 * whose block still claimed both libraries would offer manga in its own search box. An empty
 * `libraries` on the parent means EVERY library (decision
 * `2026-08-17-no-libraries-checked-means-every-library`), so the child's filter is taken
 * whole in that case rather than intersected with nothing.
 */
function narrowBlocks(blocks: unknown, filter: QueueFilter): unknown {
  if (!Array.isArray(blocks) || !filter.libraries.length) return blocks;
  return blocks.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const b = block as Partial<ProviderBlock> & Record<string, unknown>;
    const own = toIdList(b.libraries);
    const narrowed = own.length
      ? own.filter((id) => filter.libraries.includes(id))
      : [...filter.libraries];
    return { ...b, libraries: narrowed };
  });
}

/** Keys a filtered queue always owns, whatever the parent says. */
const NEVER_INHERITED = ['id', 'label', 'enabled', FILTERED_FROM, 'filter'];

/**
 * Merge each filtered queue's parent underneath it, in place of the sparse record on disk.
 *
 * Run on the RAW entries, before either normalizer sees them, so `sets.ts` and
 * `engine/routing.ts` — which parse the same file twice, for different readers — inherit the
 * same way without either one learning what a filtered queue is.
 *
 * One level only. A filter of a filter is refused (the child keeps its own sparse record and
 * so resolves to a queue with no provider, which the registry already reports as unplayable)
 * rather than resolved, because a chain has an ordering question — whose `skipped` wins — that
 * nobody has asked for yet.
 */
export function inheritFilteredQueues<T extends FilterableEntry>(entries: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const ent of entries) {
    const id = ent && ent.id != null ? String(ent.id).trim() : '';
    if (id) byId.set(id, ent);
  }
  return entries.map((ent) => {
    const parentId = parentIdOf(ent);
    if (!parentId) return ent;
    const parent = byId.get(parentId);
    // A dangling parent is left exactly as written. The registry then reports a queue with no
    // provider and no entries, which is what a broken reference should look like — inventing a
    // default here would hide the typo behind a queue that half works.
    if (!parent || parentIdOf(parent)) return ent;
    const filter = filterOf(ent);
    const merged: Record<string, unknown> = { ...parent };
    for (const key of NEVER_INHERITED) delete merged[key];
    if (filter) merged.providers = narrowBlocks(merged.providers, filter);
    return { ...merged, ...ent } as T;
  });
}

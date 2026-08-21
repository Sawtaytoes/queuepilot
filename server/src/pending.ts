// PENDING — what has arrived in the libraries that no queue or pool will ever play.
//
// The owner's ask (2026-08-17): "a 'Pending' or 'New' area to show if there are new movies or
// shows added and allow me to specify the queues to add them IF they're not already picked up
// by one." The `if` is the whole feature. A list of everything recently added is Plex's own
// Recently Added and needs no app; the useful list is the one that has already subtracted
// everything the household is going to see anyway.
//
// TWO pieces of state, both durable and both small, in /config/pending.yaml:
//
//   seen_through  an epoch second. Everything added at or before it is not new any more.
//                 One number, moved by "Mark all as seen" — so the list can be emptied in one
//                 gesture without writing a row per item.
//   dismissed     ratingKeys you said no to individually. These have to be per-item: skipping
//                 one film must not also hide the twelve added after it, which is exactly what
//                 moving the watermark would do.
//
// It is NOT the derived cache: a dismissal is a decision, it is not recomputable from Plex,
// and it belongs in a file the owner can read and edit like every other decision this app
// stores (2026-08-03-sqlite-is-a-derived-plex-cache-not-the-store).
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';

import { PENDING_PATH } from './env.js';
import { errMessage, isNodeError } from './errors.js';
import * as queues from './queues.js';
import * as routing from './engine/routing.js';
import { describe, resolveQueueEntry, resolveSections } from './engine/resolve.js';
import { collectionChildren, findCollection } from './engine/select.js';
import { mapLimit } from './routes/mapLimit.js';
import type { EntryDescriptor } from './engine/resolve.js';
import type { PlexClient, PlexMetadata, RoutingRotationCfg, RoutingSetCfg } from './types.js';

export interface PendingState {
  /** Epoch SECONDS, matching Plex's own `addedAt`. */
  seen_through: number;
  dismissed: string[];
}

export interface PendingItem {
  ratingKey: string;
  title: string;
  year: number | null;
  type: 'movie' | 'show';
  sectionId: number;
  librarySectionTitle: string;
  contentRating: string | null;
  editionTitle: string | null;
  addedAt: number;
}

const HEADER = `# QueuePilot — what has arrived that nothing is going to play.
#
# seen_through  epoch seconds. Anything added at or before this is not "new" any more; the
#               "Mark all as seen" button moves it to now. One number, so clearing the list
#               costs one line rather than one line per item.
# dismissed     ratingKeys you said no to individually. Per-item on purpose: skipping ONE
#               film must not also hide everything added after it.
#
# Delete this file to start over — nothing else reads it.`;

export async function readState(): Promise<PendingState> {
  try {
    const doc = (parse(await fsp.readFile(PENDING_PATH, 'utf8')) as Partial<PendingState> | null) || {};
    return {
      // A file with no watermark means "everything is new", not "nothing is" — a fresh
      // install should show you the backlog rather than an empty page you cannot explain.
      seen_through: Number(doc.seen_through) || 0,
      dismissed: Array.isArray(doc.dismissed) ? doc.dismissed.map(String) : [],
    };
  } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') {
      console.log(`[pending] could not read ${PENDING_PATH}: ${errMessage(e)}`);
    }
    return { seen_through: 0, dismissed: [] };
  }
}

export async function writeState(next: PendingState): Promise<void> {
  await fsp.mkdir(path.dirname(PENDING_PATH), { recursive: true });
  await fsp.writeFile(
    PENDING_PATH,
    `${HEADER}\n${stringify({ seen_through: next.seen_through, dismissed: next.dismissed })}`,
  );
}

/** Dismiss one item. Idempotent — dismissing twice is not an error, it is a double-click. */
export async function dismiss(ratingKey: string): Promise<PendingState> {
  const state = await readState();
  if (!state.dismissed.includes(ratingKey)) state.dismissed.push(ratingKey);
  await writeState(state);
  return state;
}

/**
 * Move the watermark to `at` (default: now) and drop every dismissal at or before it.
 *
 * Pruning matters: without it the dismissed list grows for ever and keeps naming items the
 * watermark already covers. Anything added AFTER the watermark stays dismissed, because that
 * decision is still doing work.
 */
export async function markSeen(at?: number): Promise<PendingState> {
  const now = at ?? Math.floor(Date.now() / 1000);
  const state = await readState();
  const next: PendingState = { seen_through: now, dismissed: state.dismissed };
  await writeState(next);
  return next;
}

// --- coverage ------------------------------------------------------------------ //

/**
 * COULD `desc` name `item`? A cheap, deliberately OVER-inclusive pre-filter, and the reason
 * resolving title entries costs nothing on a normal page load.
 *
 * It is the engine's own scoring from `resolve.resolveTitle`, run offline against one candidate
 * we already hold, minus the guid term — the section listing Pending reads carries no `Guid`.
 * A guid hint therefore short-circuits to true rather than being scored: a +100 guid match can
 * carry a title that matches nothing at all, so scoring it as 0 would DROP a resolution the
 * engine would have made.
 *
 * Over-inclusive is the safe direction and the only correct one. `resolveTitle` never returns
 * an item it scored at or below zero, so anything the engine would resolve to `item` scores
 * above zero here too, and survives. The cost of a false positive is one Plex query that comes
 * back not matching; the cost of a false negative would be an item wrongly reported as new.
 */
function couldName(desc: EntryDescriptor, item: PendingItem): boolean {
  if (desc.guid) return true;
  const wanted = (desc.title || '').toLowerCase();
  if (!wanted) return false;
  const candidate = item.title.toLowerCase();
  let score = 0;
  if (desc.year != null && item.year === desc.year) score += 10;
  else if (desc.year != null && item.year != null && item.year !== desc.year) score -= 5;
  if (candidate === wanted) score += 5;
  else if (candidate.startsWith(wanted)) score += 1;
  return score > 0;
}

/** How many title lookups run at once. Matches the tile fan-out in `/api/queues`. */
const RESOLVE_CONCURRENCY = 6;

/**
 * Every ratingKey a CURATED set already names — queue entries and pool members alike.
 *
 * Three shapes name an item, and only the first two used to be read:
 *
 *   1. a rating key, free;
 *   2. `Collection: <name>`, which covers the collection's children;
 *   3. a bare TITLE (`- "Detectives These Days Are Crazy!"`) or a `{title: …}` mapping.
 *
 * The third contributed nothing, so every title-only entry covered nothing — 84 of them in the
 * owner's live file, which is why he could add a show to a queue that already held it. It now
 * resolves through the ENGINE's resolver, so a covered item is exactly an item the engine would
 * play, and not whatever a second title matcher happened to agree with.
 *
 * `fresh` is what makes that affordable: a title entry is only worth resolving when some new
 * arrival could plausibly be the thing it names, and on a normal load nothing can, so the
 * common case costs ZERO Plex calls. See `couldName`.
 *
 * FAIL-SAFE: a title nothing in Plex answers to contributes NOTHING, so the arrival stays on
 * the list. A hand-typed title that no longer matches the library is a broken entry — nothing
 * is going to play it, which is precisely what this screen reports.
 */
async function curatedKeys(
  client: PlexClient,
  sets: Record<string, RoutingSetCfg>,
  fresh: readonly PendingItem[],
): Promise<Set<string>> {
  const named = new Set<string>();
  const collections: { name: string; cfg: RoutingSetCfg }[] = [];
  const titled: { desc: EntryDescriptor; cfg: RoutingSetCfg }[] = [];

  const noteValue = (value: unknown, cfg: RoutingSetCfg): void => {
    if (value == null) return;
    // `describe()` is the engine's own entry parser. Using it instead of the hand-rolled
    // reader that stood here also repairs a shape that reader could not see: a
    // `{collection: <name>}` MAPPING never matched its `^collection:` regex (the prefix is in
    // the KEY, not the value), so that collection's children were all reported as pending.
    const desc = describe(value);
    if (desc.ratingKey) named.add(desc.ratingKey);
    if (desc.collection) collections.push({ name: desc.collection, cfg });
    else if (!desc.ratingKey && desc.title) titled.push({ desc, cfg });
  };

  for (const [id, cfg] of Object.entries(sets)) {
    for (const m of (cfg as RoutingRotationCfg).members || []) noteValue(m, cfg);
    // A curated queue's entries live in queues.yaml, not in the set.
    try {
      for (const entry of await queues.listSet(id)) noteValue(entry.value, cfg);
    } catch {
      /* a set with no queue file simply names nothing */
    }
  }

  // A collection entry covers its children — the same rule the pool engine and the blocklist
  // both apply. Without it, adding a franchise as one entry would leave every film in it
  // reported as pending.
  for (const { name, cfg } of collections) {
    for (const sec of routing.setSections(cfg) || []) {
      const crk = await findCollection(client, sec, name, null);
      if (!crk) continue;
      for (const ch of await collectionChildren(client, crk, null)) named.add(String(ch.ratingKey));
      break;
    }
  }

  // A title entry, resolved only where a new arrival could be what it names. The sections come
  // from the engine's own `resolveSections` rather than `routing.setSections`, because that is
  // the list `resolveQueueEntry` will search — filtering against a different one would skip a
  // resolution the engine goes on to make.
  const freshBySection = new Map<number, PendingItem[]>();
  for (const item of fresh) {
    const list = freshBySection.get(item.sectionId);
    if (list) list.push(item);
    else freshBySection.set(item.sectionId, [item]);
  }
  const worthResolving = titled.filter(({ desc, cfg }) =>
    resolveSections(cfg)
      .flatMap((sec) => (sec == null ? [] : freshBySection.get(Number(sec)) || []))
      .some((item) => couldName(desc, item)));
  await mapLimit(worthResolving, RESOLVE_CONCURRENCY, async ({ desc, cfg }) => {
    const [ratingKey] = await resolveQueueEntry(client, desc, cfg, null);
    if (ratingKey) named.add(ratingKey);
  });

  return named;
}

/**
 * Is `item` inside some filtered pool's RULE? That is the half a curated list cannot answer:
 * a rotation pool never names anything, it describes a shape, and a new show that matches the
 * shape is already going to play without anyone doing anything.
 *
 * Deliberately the same three tests the pool engine applies — the pool's own sections, its
 * rating cap, its blocklist — so "covered" here means the same thing it means there.
 */
function isInAnyRule(
  item: PendingItem,
  sets: Record<string, RoutingSetCfg>,
  blockedBySet: Map<string, Set<string>>,
): boolean {
  for (const [id, cfg] of Object.entries(sets)) {
    if (cfg.source !== 'rotation') continue;
    // A superseded tier is not a live pool; counting it would hide items nothing plays.
    if ((cfg as RoutingRotationCfg).superseded_by) continue;
    if (cfg.enabled === false) continue;
    if (!(routing.setSections(cfg) || []).map(Number).includes(item.sectionId)) continue;
    if (blockedBySet.get(id)?.has(item.ratingKey)) continue;

    // ANY binding that would accept it is enough — the pool plays for all of them.
    const bindings = (cfg as RoutingRotationCfg).profiles || [];
    const accepts = bindings.length
      ? bindings.some((b) => !b.allowed_ratings || b.allowed_ratings.has(String(item.contentRating)))
      : true;
    if (accepts) return true;
  }
  return false;
}

/**
 * Has the household already SEEN this? Then it is not a new arrival, whatever covers it.
 *
 * A separate axis from coverage, and it belongs beside the watermark and the dismissals rather
 * than beside the pool rules: those three all answer "is this still news?", while coverage
 * answers "is anything going to play it?".
 *
 * The rule, stated so it can be argued with:
 *
 *   * A MOVIE is watched when Plex reports ANY view activity — `viewCount > 0` (finished) or a
 *     `viewOffset > 0` resume point (started and abandoned). `tiles.ts` already names those two
 *     states "Completed" and "In Progress" and this matches its fields rather than inventing a
 *     second definition. Both are excluded, because an arrival you have already started is one
 *     you have already noticed, and Plex's own Continue Watching is where a half-finished film
 *     belongs.
 *   * A SHOW is watched only when it is FULLY watched: `viewedLeafCount >= leafCount`. A series
 *     with one unplayed episode is still something to queue, so a partly-watched show stays on
 *     the list. `leafCount > 0` guards the empty show, whose 0 >= 0 would otherwise read as
 *     watched.
 *
 * WHOSE watch state: the ADMIN's. `listSection` runs on the admin token, `pending.yaml` holds
 * one watermark and one dismissal list for the whole household, and the owner asked for this
 * about his own viewing. A per-profile Pending screen would need an `AccountScope` and a
 * per-profile state file, and that is a feature, not a detail of this fix.
 *
 * Every field is read off the section listing `pendingItems` already fetched — Plex puts all
 * four on it — so the whole rule costs no extra request. Plex OMITS a count at 0, which is what
 * makes `Number(…) || 0` the right coercion: absent means zero, never unknown.
 */
function isWatched(md: PlexMetadata, kind: 1 | 2): boolean {
  if (kind === 2) {
    const leaves = Number(md.leafCount) || 0;
    return leaves > 0 && (Number(md.viewedLeafCount) || 0) >= leaves;
  }
  return (Number(md.viewCount) || 0) > 0 || (Number(md.viewOffset) || 0) > 0;
}

/** One library as `pendingItems` needs it — the slice of `plex.sections()` it reads. */
export interface PendingLibrary {
  id: number;
  title: string;
  video: boolean;
  type: string;
  /** Plex "Other Videos" — a Personal Media library with no metadata agent. */
  other?: boolean;
}

/**
 * Items added after the watermark, not already watched, that nothing is going to play. Newest
 * first.
 *
 * BOTH Plex reads are parameters rather than imports. That is not only for the gate: it is
 * the same seam the selection engine uses (`PlexClient`), and it keeps the SUBTRACTION rules
 * — which are the actual feature — testable without a server or a network.
 */
export async function pendingItems(
  client: PlexClient,
  libraries: readonly PendingLibrary[],
  listSection: (sectionId: number, type: 1 | 2) => Promise<PlexMetadata[]>,
): Promise<{ items: PendingItem[]; state: PendingState }> {
  const state = await readState();
  const reg = routing.loadSets();
  const sets = reg?.sets || {};
  const dismissed = new Set(state.dismissed);

  // Which libraries anything is CONFIGURED to draw from. Used only to decide whether an
  // "Other Videos" library is worth reporting on — see below.
  const usedSections = new Set<number>();
  for (const cfg of Object.values(sets)) {
    for (const sec of routing.setSections(cfg) || []) usedSections.add(Number(sec));
  }

  /**
   * Plex "Other Videos" (Personal Media, no metadata agent) are SKIPPED unless some set
   * actually draws from them.
   *
   * Not tidiness: those libraries are where the household's test encodes live, and on the
   * first real run they were 7 of the 11 rows — eleven `[Betterman QC] … x265-10bit {SD SDR}`
   * variants of one clip, burying a film someone might genuinely want to queue. "Nothing
   * plays this" is TRUE of a test encode and also completely uninteresting.
   *
   * Conditional rather than a hard exclusion, because the judgement belongs to the config: if
   * a queue names one of these libraries, a new item in it IS a candidate and gets reported.
   */
  const videoLibs = libraries.filter(
    (l) => l.video && (!l.other || usedSections.has(l.id)),
  );

  const fresh: PendingItem[] = [];
  for (const lib of videoLibs) {
    const kind: 1 | 2 = lib.type === 'show' ? 2 : 1;
    for (const md of await listSection(lib.id, kind)) {
      const addedAt = Number(md.addedAt) || 0;
      const ratingKey = String(md.ratingKey);
      if (addedAt <= state.seen_through) continue;
      if (dismissed.has(ratingKey)) continue;
      if (isWatched(md, kind)) continue;
      fresh.push({
        ratingKey,
        title: String(md.title ?? ''),
        year: md.year != null ? Number(md.year) : null,
        type: kind === 2 ? 'show' : 'movie',
        sectionId: lib.id,
        librarySectionTitle: String(lib.title ?? ''),
        contentRating: md.contentRating != null ? String(md.contentRating) : null,
        editionTitle: md.editionTitle ? String(md.editionTitle) : null,
        addedAt,
      });
    }
  }

  if (!fresh.length) return { items: [], state };

  const named = await curatedKeys(client, sets, fresh);
  const blockedBySet = new Map<string, Set<string>>();
  for (const [id, cfg] of Object.entries(sets)) {
    blockedBySet.set(id, new Set(((cfg as RoutingRotationCfg).blocklist || []).map(String)));
  }

  const items = fresh
    .filter((it) => !named.has(it.ratingKey) && !isInAnyRule(it, sets, blockedBySet))
    .sort((a, b) => b.addedAt - a.addedAt);

  return { items, state };
}

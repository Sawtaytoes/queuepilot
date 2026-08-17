// The set REGISTRY: sets.yaml is the single source of truth for every set — the curated
// queues (source: queue) and the dynamic kid channels (source: rotation). The Node editor
// is the only WRITER; the Python service re-reads it before every command (config.reload_sets).
// Round-trips with the comment-preserving `yaml` Document API + the same mkdir lock
// convention as queues.js, and seeds itself from DEFAULT_YAML on first boot so the file
// always exists once the web app has run.
//
// Registry rules (mirrored in queue_builder/config.py):
//   * `id` is IMMUTABLE — HA automations / NFC cards / MQTT payloads reference it
//     ({"set": "<id>"}). Renaming a queue only ever changes `label`.
//   * File order of `sets:` = shelf order on the web Home page.
//   * Library membership is purely opt-in: a set draws only from the `sections` it lists.
//     There is no global hide list — every video library shows in every picker.
import { promises as fs } from 'node:fs';
import { parseDocument, isMap, isNode, isScalar, isSeq } from 'yaml';
import type { Document, Node, YAMLMap, YAMLSeq } from 'yaml';
import { validateBlocks, blocksForSet } from './providers/blocks.js';
import { toWeight } from './engine/weight.js';
import { definitions as providerDefinitions, deliveryForKind, vocabularyForKind } from './providers/config.js';
// The same hard cap a per-entry override is clamped to (queues.setEpisodes), applied to the
// set-wide default so a hand-posted value cannot queue a whole library.
// ROTATION_LENGTH is read here as well as by the engine, because "equal to the default" is
// what makes a lineup length store SPARSELY — see toLineupLength().
import { QUEUE_SERIES_LENGTH, ROTATION_LENGTH_MAX } from './env.js';
import { INFINITE, defaultFor } from './engine/playbackLength.js';
import { isNodeError } from './errors.js';
import type {
  BatchStop,
  Binding,
  Delivery,
  MemberObject,
  MemberValue,
  ProviderBlock,
  ProviderVocabulary,
  QueueSet,
  SetBehavior,
  SetMode,
  SetRegistry,
  SetRegistryEntry,
  SetSource,
  Start,
  WritableProviderBlock,
} from './types.js';

// Read straight off `process.env` rather than through env.ts, deliberately unchanged: the e2e
// harnesses set `process.env.SETS_PATH` and then import this module, and engine/routing.js
// imports SETS_PATH from HERE. (env.ts has no SETS_PATH equivalent today — see the report.)
export const SETS_PATH = process.env.SETS_PATH || '/config/sets.yaml';

/**
 * One binding AS READ OFF THE YAML — what `normalizeBinding()` accepts, from either a
 * `profiles[]` row or a legacy set's flat top-level fields.
 *
 * The scalar fields are declared as the registry contract's types (`Binding` in types.ts)
 * because that is what a well-formed file holds; the list fields stay `unknown[]` because
 * every reader below already re-coerces them (`Array.isArray(...) ? .map(String) : null`),
 * which is what makes a hand-edited file safe.
 */
interface RawBinding {
  plex_user?: string | null;
  account_id?: number | string | null;
  user_uuid?: string | null;
  allowed_ratings?: unknown[];
  movie_ratings?: unknown[];
  watch_count_accounts?: unknown[];
  movie_excludes?: unknown[];
}

/** One `sets:` entry as it comes back off `doc.toJSON()`. Same rule as `RawBinding`. */
interface RawSet extends RawBinding {
  id?: string;
  label?: unknown;
  kind?: string;
  source?: string;
  sections?: unknown[];
  item_sections?: unknown[];
  blocklist?: unknown[];
  mode?: string;
  behavior?: string;
  profiles?: unknown[];
  members?: unknown[];
  starts?: unknown;
  weights?: unknown;
  default_profile?: string | null;
  superseded_by?: string | null;
  audio_language?: string;
  requires_profile?: string | null;
  providers?: unknown[];
  max_items?: unknown;
  enabled?: boolean;
  keep_completed?: boolean;
  reel?: boolean;
  remove_completed_after?: string | null;
  batch_stops_at?: string | null;
  /** Anything else the file carries, verbatim — and what makes a RawSet usable as
   * `providers/blocks.ts`'s `BlockSourceCfg` without a cast. */
  [field: string]: unknown;
}

// Set a map key while PRESERVING any inline/leading comment on the value being replaced.
// `map.set(key, node)` swaps the value node wholesale, which drops a `label: Bob  # comment`
// annotation a human typed over SMB — the exact loss `e2e/yaml-roundtrip-test.mjs` guards.
// The comment lives on the scalar VALUE node (`pair.value.comment`), so carry it across.
function setKeepingComment(map: YAMLMap, key: string, newNode: Node): void {
  const pair = map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
  if (pair && isNode(pair.value)) {
    if (pair.value.comment != null) newNode.comment = pair.value.comment;
    if (pair.value.commentBefore != null) newNode.commentBefore = pair.value.commentBefore;
  }
  map.set(key, newNode);
}

const LOCK_DIR = SETS_PATH + '.lock';
const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 10000;
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

async function acquireLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(LOCK_DIR);
      return;
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(LOCK_DIR).catch(() => {});
          continue;
        }
      } catch {
        /* lock vanished — retry */
      }
      if (Date.now() > deadline) throw new Error('timed out acquiring sets.yaml lock');
      await sleep(50);
    }
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await fs.rmdir(LOCK_DIR).catch(() => {});
  }
}

// The pre-registry state, verbatim: the six curated queues + the two kid rotation tiers
// that used to live hardcoded in queue_builder/config.py + web/src/config.js. Seeded to
// disk on first boot; from then on the FILE is the truth and this constant is only a
// disaster-recovery template.
const DEFAULT_YAML = `# queuepilot set registry — the single source of truth for every set (curated queue
# or dynamic channel). Edited by the web UI at plex-channels.example.com; hand-edits are
# fine too (the web app and the Python service both re-read it).
#
#   * id      IMMUTABLE — HA automations / NFC cards / MQTT reference it ({"set": "<id>"}).
#             Rename the label freely; NEVER change an id.
#   * order   of the entries below = shelf order on the web Home page.
#   * source  queue    = hand-curated wishlist in queues.yaml (orderable, prunes as watched)
#             rotation = rule-based kid channel (computed fresh each scan; filters below)
#   * sections / item_sections  which Plex libraries the set draws from / searches.
#   * keep_completed  (queue sets) true = a NON-CONSUMING / playlist queue: entries are
#             never marked done and never removed when played, so the whole lineup can be
#             re-shown every scan (e.g. the Theater Demo Reel). reel: true implies this.
#   * remove_completed_after  OPT-IN auto-removal of finished entries. Default (absent) =
#             KEEP FOREVER — a finished entry stays, tagged done, until cleared by hand. Set
#             a duration ("24h"/"7d"/"90m") to have finished entries auto-remove that long
#             after they finish; "0"/"never" is the explicit keep-forever. MOVIE queues opt
#             in (24h below); ANIME channels intentionally stay default (kept) — an anime
#             series has no "Season 2", so the finished series is the anchor a hand-added
#             sequel lands next to. keep_completed: true also exempts a set.
#
# Library membership is purely opt-in: a set draws only from the sections it lists, and
# every video library is available in the pickers. Non-video libraries (Music, Photos)
# are never eligible (filtered structurally, not by any hide list).

sets:
  - id: bob
    label: Bob — Movies
    kind: movies
    source: queue
    sections: [1, 14]
    remove_completed_after: 24h  # movie queues opt in; anime channels stay keep-forever
  - id: bob_alice
    label: Bob & Alice — Movies
    kind: movies
    source: queue
    sections: [1, 14]
    remove_completed_after: 24h
  - id: family
    label: Family — Movies
    kind: movies
    source: queue
    sections: [1, 14]
    remove_completed_after: 24h
  - id: bob_anime
    label: Bob — Anime
    kind: anime
    source: queue
    sections: [11]
  - id: bob_alice_anime
    label: Bob & Alice — Anime
    kind: anime
    source: queue
    sections: [11]
  - id: family_anime
    label: Family — Anime
    kind: anime
    source: queue
    sections: [11]
  # The legacy per-tier sets (younger/older) are kept for the soak, marked superseded so
  # they stay readable ({set:"younger"} still plays) but are hidden from every picker and
  # skipped by the set:"auto" router. New installs land already-migrated to the function
  # channels below. (Migration: 2026-07-23-live-tier-migration-to-function-channels.)
  - id: younger
    label: Younger Kids
    kind: cartoons
    source: rotation
    sections: [5]
    item_sections: [15]
    allowed_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
    movie_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
    blocklist: []
    plex_user: Younger Kids
    account_id: 11111111
    user_uuid: 1111111111111111
    watch_count_accounts: [11111111]
    superseded_by: shows_shorts,movies
  - id: older
    label: Older Kids
    kind: cartoons
    source: rotation
    sections: [5]
    item_sections: [15]
    allowed_ratings: [TV-PG, PG]
    movie_ratings: [TV-PG, PG]
    blocklist: []
    plex_user: Older Kids
    account_id: 22222222
    user_uuid: 2222222222222222
    watch_count_accounts: [22222222]
    superseded_by: shows_shorts,movies
  # The function channels (cards send set:"auto"; the Shield's signed-in profile picks the
  # tier binding). Named by FUNCTION, not by profile — each carries both tiers as profiles[].
  - id: shows_shorts
    label: Shows & Shorts
    kind: cartoons
    source: rotation
    behavior: progress
    sections: [5]
    item_sections: [15]
    blocklist: []
    profiles:
      - plex_user: Younger Kids
        account_id: 11111111
        user_uuid: 1111111111111111
        allowed_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        movie_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        watch_count_accounts: [11111111]
      - plex_user: Older Kids
        account_id: 22222222
        user_uuid: 2222222222222222
        allowed_ratings: [TV-PG, PG]
        movie_ratings: [TV-PG, PG]
        watch_count_accounts: [22222222]
  # A rewatch channel pools from the libraries it names, like any other channel: movie
  # libraries in item_sections, show libraries in sections (their one-episode entries —
  # anime films). Add Documentaries/Anime here to widen it.
  - id: movies
    label: Movies
    kind: movies
    source: rotation
    behavior: rewatch
    sections: []
    item_sections: [1]
    blocklist: []
    profiles:
      - plex_user: Younger Kids
        account_id: 11111111
        user_uuid: 1111111111111111
        allowed_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        movie_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        watch_count_accounts: [11111111]
      - plex_user: Older Kids
        account_id: 22222222
        user_uuid: 2222222222222222
        allowed_ratings: [TV-PG, PG]
        movie_ratings: [TV-PG, PG]
        watch_count_accounts: [22222222]
`;

async function ensureFile(): Promise<void> {
  // Seed via an EXCLUSIVE create (wx), not the mkdir lock: readDoc runs inside
  // withLock() from every mutation, and the lock is not reentrant — taking it here
  // deadlocked the first mutation whenever the file didn't exist yet.
  try {
    await fs.access(SETS_PATH);
  } catch {
    try {
      await fs.writeFile(SETS_PATH, DEFAULT_YAML, { flag: 'wx' });
      console.log(`[sets] seeded ${SETS_PATH} from built-in defaults`);
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'EEXIST') throw e; // a concurrent seeder won the race — fine
    }
  }
}

async function readDoc(): Promise<Document> {
  await ensureFile();
  const doc: Document = parseDocument(await fs.readFile(SETS_PATH, 'utf8'));
  if (!isSeq(doc.get('sets'))) throw new Error('sets.yaml has no sets list');
  return doc;
}

/**
 * The `sets:` sequence of a document readDoc() has already vetted. The re-check is
 * unreachable at runtime (readDoc throws first) and exists only so every caller below gets a
 * `YAMLSeq` instead of `unknown` without repeating a narrowing guard nine times.
 */
function setsSeq(doc: Document): YAMLSeq {
  const seq = doc.get('sets');
  if (!isSeq(seq)) throw new Error('sets.yaml has no sets list');
  return seq;
}

const YAML_OUT = { indentSeq: false, lineWidth: 0 };

async function writeDoc(doc: Document): Promise<void> {
  _regCache = null; // see registryCache(): stat-keyed memo, busted on our own writes
  const text = doc.toString(YAML_OUT);
  const tmp = SETS_PATH + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, SETS_PATH);
  } catch {
    await fs.writeFile(SETS_PATH, text, 'utf8');
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

const toInts = (a: unknown): number[] => (Array.isArray(a) ? a.map((x) => parseInt(String(x), 10)).filter((x) => !Number.isNaN(x)) : []);

// A per-scan item cap (max_items): a positive integer, or null when blank/absent/invalid
// (no limit). Mirrors queue_builder/config.py's coercion (int > 0 else None).
const toPosIntOrNull = (v: unknown): number | null => {
  if (v == null || String(v).trim() === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** One YAML node field as a plain value, for the sibling reads the writers do. */
const readNodeValue = (node: YAMLMap, key: string): unknown => {
  const found = node.get(key);
  return isNode(found) ? found.toJSON() : found;
};

/** The subset of `patch` that actually carries a key — a patch's own value wins over the file's. */
const pickDefined = (patch: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in patch) out[k] = patch[k];
  return out;
};

/**
 * A stored `length:` as the registry REPORTS it — a number, the string `'infinite'`, or null
 * for "never said, follow this kind's default".
 *
 * Read TOLERANTLY, unlike the writer: sets.yaml is hand-edited over SMB, and a card that
 * refuses to load is a dead card on the wall. An unrecognised value reads as null.
 */
const readStoredLength = (ent: RawSet): number | typeof INFINITE | null => {
  if (String(ent.length ?? '').trim().toLowerCase() === INFINITE) return INFINITE;
  // LEGACY: `refill: true` WAS infinite, back when `length` meant the queue window.
  if (ent.refill === true) return INFINITE;
  return toPosIntOrNull(ent.length);
};

/**
 * A rotation channel's `length:` on the wire → what to STORE, or null for "follow env
 * ROTATION_LENGTH", which is stored by ABSENCE.
 *
 * Equal-to-the-default drops the key. That is the sparse rule the entry counts already use
 * (decision `2026-08-16-entry-count-follows-the-set-default`) and it is what keeps the pool
 * editor non-destructive: its Save posts every knob it renders, so without this an untouched
 * channel would grow a `length: 12` that says nothing — and would then stop following the env
 * default if that ever moved.
 *
 * Clamped rather than rejected so a fat-fingered 300 builds a long-but-finite lineup instead
 * of failing the save; ROTATION_LENGTH_MAX exists because every item in a lineup costs a Plex
 * round trip at scan time.
 */
const toLineupLength = (v: unknown): number | typeof INFINITE | null => {
  // The named infinite form. Never `0` and never `999`: a falsy count already reads as
  // *uncapped* in resolve.ts's applyBatch, so a typo landing on 0 would become a binge rather
  // than an error (`docs/todos/batch-all-or-infinite.md` settled this for the entry batch).
  if (String(v ?? '').trim().toLowerCase() === INFINITE) return INFINITE;

  const n = toPosIntOrNull(v);
  if (n == null) return null;
  const clamped = Math.min(n, ROTATION_LENGTH_MAX);
  // Equal-to-the-default still drops the key, but the default is now PER KIND — a rewatch pool
  // follows 1, a filtered pool 12, an ordered queue 1 — so the comparison cannot be against a
  // single env constant any more. The caller passes the kind's own default in.
  return clamped;
};

/**
 * `on_complete:` on the wire → what to store: `'restart'`, or null for the default (drop),
 * which is stored by ABSENCE.
 *
 * Rejected rather than coerced, because a typo ("restart-at-1") silently meaning "drop" is how
 * a channel quietly stops restarting — the failure looks exactly like a pool that ran out.
 */
const toOnComplete = (v: unknown): 'restart' | null => {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  if (!s || s === 'drop') return null;
  if (s !== 'restart') throw new Error(`invalid on_complete '${String(v)}' — use 'restart' or 'drop'`);
  return s;
};

// batch_stops_at: WHERE a multi-episode batch may stop — "member" (never span two collection
// members) or "season" (also never span a season boundary, including inside one show). Anything
// else, including the "none" default, is stored as the ABSENCE of the key: the engine reads a
// missing/unrecognised value as no boundary, so a sparse file and a typo agree.
const BATCH_STOPS = ['member', 'season'] as const;
// `includes` over the widened array rather than a cast on the value: the runtime test is the
// same `Array.prototype.includes` the JS had, and a non-string simply fails it, as before.
const isBatchStop = (v: unknown): v is 'member' | 'season' =>
  typeof v === 'string' && (BATCH_STOPS as readonly string[]).includes(v);
const normalizeBatchStop = (v: unknown): BatchStop => {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  return isBatchStop(s) ? s : null;
};

const MODES = ['rewatch', 'episodic', 'both'] as const;
const isMode = (v: unknown): v is SetMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);
// behavior (v3 PR 2) supersedes `mode`: progress = advance through unwatched ("next
// episode"), rewatch = weighted least-watched replay. Mirrors queue_builder/config.py.
const BEHAVIORS = ['progress', 'rewatch'] as const;
const isBehavior = (v: unknown): v is SetBehavior => typeof v === 'string' && (BEHAVIORS as readonly string[]).includes(v);

// The per-profile binding fields (v3 PR 2): a rotation channel works with one or more
// PROFILES, each carrying that channel's per-profile rating caps + account identity. The
// legacy `younger`/`older` sets encode exactly one such binding at the top level; the
// reader below synthesizes a one-element `profiles` list from those top-level fields when
// no explicit `profiles` array is present (back-compat). Channel-level fields (sections,
// blocklist, behavior, kind) stay OUT of the binding. See the decision doc.
const BINDING_KEYS = ['plex_user', 'account_id', 'user_uuid', 'allowed_ratings', 'movie_ratings', 'watch_count_accounts', 'movie_excludes'];

// Normalize one binding for the API response (arrays kept as arrays; ids coerced).
function normalizeBinding(src: RawBinding): Binding {
  return {
    plex_user: src.plex_user ?? null,
    // `account_id` is left as whatever the file held (config.py does the same) — a numeric
    // string from YAML stays a string, which is why RawBinding admits both.
    account_id: (src.account_id ?? null) as number | null,
    user_uuid: src.user_uuid ?? null,
    allowed_ratings: Array.isArray(src.allowed_ratings) ? src.allowed_ratings.map(String) : null,
    movie_ratings: Array.isArray(src.movie_ratings) ? src.movie_ratings.map(String) : null,
    watch_count_accounts: toInts(src.watch_count_accounts),
    movie_excludes: Array.isArray(src.movie_excludes) ? src.movie_excludes.map(String) : [],
  };
}

// The profiles list for a rotation set: explicit `profiles[]` when present, else ONE binding
// synthesized from the legacy top-level fields.
function readProfiles(ent: RawSet): [Binding, ...Binding[]] {
  const raw = Array.isArray(ent.profiles)
    ? ent.profiles.filter((p): p is RawBinding => Boolean(p) && typeof p === 'object')
    : [];
  // Typed as a non-empty tuple because it IS one — the fallback list is `[ent]` — and that is
  // what lets normalize() read `profiles[0]` without an assertion. `head ?? ent` is the same
  // unreachable branch spelled for the compiler.
  const [head, ...rest]: RawBinding[] = raw.length ? raw : [ent];
  return [normalizeBinding(head ?? ent), ...rest.map(normalizeBinding)];
}

// Build the on-disk YAML object for one binding — only DEFINED knobs are written (an omitted
// field stays off the file rather than as a null), mirroring rotationCreateObj's style.
function bindingWriteObj(src: RawBinding = {}): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (src.plex_user != null && String(src.plex_user).trim()) b.plex_user = String(src.plex_user).trim();
  if (src.account_id != null && String(src.account_id).trim() !== '') b.account_id = parseInt(String(src.account_id), 10);
  if (src.user_uuid != null && String(src.user_uuid).trim()) b.user_uuid = String(src.user_uuid).trim();
  if (Array.isArray(src.allowed_ratings) && src.allowed_ratings.length) b.allowed_ratings = src.allowed_ratings.map(String);
  if (Array.isArray(src.movie_ratings) && src.movie_ratings.length) b.movie_ratings = src.movie_ratings.map(String);
  const wca = toInts(src.watch_count_accounts);
  if (wca.length) b.watch_count_accounts = wca;
  const mex = Array.isArray(src.movie_excludes) ? src.movie_excludes.map(String) : [];
  if (mex.length) b.movie_excludes = mex;
  return b;
}

// One explicit member of a rotation channel's `members:` list (v3 PR 3). Accepted forms
// mirror queues.py exactly — a bare ratingKey, a `Collection: <name>` string, or a mapping
// carrying ratingKey/title/collection plus an optional `episodes:` batch. Stored by
// ratingKey per 2026-07-21-drop-human-readable-yaml-canonical-ids. Returns the cleaned
// value, or null for an empty/invalid entry (dropped).
function memberWriteValue(v: unknown): MemberValue | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    // The on-disk mapping form. Every field is re-coerced below, so reading it through a
    // declared shape asserts nothing the code does not already enforce.
    const src = v as { ratingKey?: unknown; collection?: unknown; title?: unknown; episodes?: unknown; weight?: unknown };
    const m: MemberObject = {};
    if (src.ratingKey != null && String(src.ratingKey).trim() !== '') m.ratingKey = String(src.ratingKey).trim();
    if (src.collection != null && String(src.collection).trim()) m.collection = String(src.collection).trim();
    if (src.title != null && String(src.title).trim()) m.title = String(src.title).trim();
    const eps = parseInt(String(src.episodes), 10);
    if (Number.isFinite(eps) && eps > 0) m.episodes = eps;
    // How many slots this member takes per round (engine/weight.js). 1 is the default and is
    // never written, so an unweighted members list keeps its current shape on disk.
    const w = toWeight(src.weight);
    if (w > 1) m.weight = w;
    return m.ratingKey || m.collection || m.title ? m : null;
  }
  const s = String(v).trim();
  return s || null;
}
const toMembers = (a: unknown): MemberValue[] =>
  (Array.isArray(a) ? a.map(memberWriteValue).filter((m): m is MemberValue => m != null) : []);

// A rotation channel's per-show manual start map (decision 2026-08-07-dynamic-pool-start-
// override): ratingKey -> {season?, episode?, series?}. The mirror of a curated member's
// embedded `start`, but for a rule-derived pool show that has no stored entry. Cleaned to
// the same {series?, season?, episode?} floor shape the engine's _at_or_after_start reads;
// entries with neither an episode nor a series are dropped (a cleared start removes its key).
function toStarts(v: unknown): Record<string, Start> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, Start> = {};
  for (const [rk, s] of Object.entries(v as Record<string, unknown>)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const src = s as { series?: unknown; season?: unknown; episode?: unknown };
    const start: Start = {};
    if (src.series != null && String(src.series).trim()) start.series = String(src.series).trim();
    const season = parseInt(String(src.season), 10);
    const episode = parseInt(String(src.episode), 10);
    if (Number.isFinite(season)) start.season = season;
    if (Number.isFinite(episode)) start.episode = episode;
    if (start.series != null || start.episode != null) out[String(rk)] = start;
  }
  return out;
}

// A rotation channel's per-show WEIGHT map: ratingKey -> n (and `section-<id>` for a whole
// item bucket, e.g. Shorts). The mirror of a curated entry's embedded `weight`, but for a
// rule-derived pool show with no stored entry to hang one on — exactly how `starts` works.
// A weight of 1 is the default and is DROPPED, so clearing one removes its key rather than
// leaving `weight: 1` litter behind.
/**
 * Per-show `on_complete` overrides, keyed by ratingKey exactly as `starts` and `weights` are
 * (`section-<id>` for a whole item bucket).
 *
 * THREE states per show, which is why this is a map of values rather than a set of names:
 * absent = follow the pool, `restart` = start it over, `drop` = let it finish. The third one
 * is the whole point — a pool set to restart everything needs a way to say "except this show",
 * and a boolean could only ever express the other direction.
 *
 * Read TOLERANTLY, unlike the set-level writer: sets.yaml is hand-edited over SMB, and an
 * unrecognised value here means "follow the pool" rather than taking a card off the wall.
 */
function toOnCompleteByShow(v: unknown): Record<string, 'restart' | 'drop'> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, 'restart' | 'drop'> = {};
  for (const [rk, val] of Object.entries(v as Record<string, unknown>)) {
    const w = String(val ?? '').trim().toLowerCase();
    if (w === 'restart' || w === 'drop') out[String(rk)] = w;
  }
  return out;
}

function toWeights(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [rk, n] of Object.entries(v as Record<string, unknown>)) {
    const w = toWeight(n);
    if (w > 1) out[String(rk)] = w;
  }
  return out;
}

/**
 * The fields normalize() emits for EVERY set, whatever its source — types.ts's
 * `SetRegistryCommon`, which it declares but does not export, so it is reconstructed here
 * from the queue arm rather than duplicated.
 */
type SetRegistryCommon = Omit<QueueSet, 'source' | 'keep_completed' | 'reel' | 'remove_completed_after' | 'batch_stops_at' | 'episodes' | 'volumes'>;

function normalize(ent: RawSet): SetRegistryEntry | null {
  const id = String(ent.id || '').trim();
  if (!id) return null;
  const source: SetSource = ent.source === 'rotation' ? 'rotation' : 'queue';
  const isRotation = source === 'rotation';
  const mode: SetMode | null = isMode(ent.mode) ? ent.mode : isRotation ? 'both' : null;
  // Rotation sets carry a profiles[] list; the DEFAULT binding (profiles[0]) is mirrored to
  // the top-level binding fields so the existing single-binding form (and any un-migrated
  // reader) keeps working unchanged. Queue sets have no bindings.
  const profiles = isRotation ? readProfiles(ent) : null;
  const def = profiles ? profiles[0] : null;
  // `def ? … : …` rather than `isRotation ? … : …`: the two conditions are the same one (def
  // is non-null exactly when the set is a rotation), and this spelling is the one the
  // compiler can follow.
  const common: SetRegistryCommon = {
    // Playback length lives on EVERY kind of set now, so it is resolved once here rather than
    // in each branch below. `length_default` is what `null` means for THIS set — its kind's
    // own historical behaviour — sent so the editor's Default chip does not have to re-derive
    // the source × behavior × kind rule in the browser.
    length: readStoredLength(ent),
    length_default: defaultFor({
      behavior: ent.behavior,
      kind: ent.kind,
      mode: ent.mode,
      source: isRotation ? 'rotation' : 'queue',
    }) ?? 1,
    power_off_when_done: ent.power_off_when_done === true,
    id,
    label: String(ent.label || id),
    kind: ent.kind || 'movies',
    sections: toInts(ent.sections),
    item_sections: toInts(ent.item_sections),
    allowed_ratings: def ? def.allowed_ratings : (Array.isArray(ent.allowed_ratings) ? ent.allowed_ratings.map(String) : null),
    movie_ratings: def ? def.movie_ratings : (Array.isArray(ent.movie_ratings) ? ent.movie_ratings.map(String) : null),
    blocklist: Array.isArray(ent.blocklist) ? ent.blocklist.map(String) : [],
    // v2 knobs (workstreams E + I): carry the full rotation field set the Python service
    // reads. user_uuid/watch_count_accounts were previously DROPPED here, so a rotation set
    // created/edited via the API lost its account binding — now round-tripped intact.
    movie_excludes: def ? def.movie_excludes : (Array.isArray(ent.movie_excludes) ? ent.movie_excludes.map(String) : []),
    watch_count_accounts: def ? def.watch_count_accounts : toInts(ent.watch_count_accounts),
    plex_user: def ? def.plex_user : (ent.plex_user ?? null),
    account_id: def ? def.account_id : ((ent.account_id ?? null) as number | null),
    user_uuid: def ? def.user_uuid : (ent.user_uuid ?? null),
    mode,
    audio_language: ent.audio_language != null ? String(ent.audio_language) : null,
    // WHO a curated queue plays as (the value is the PMS-log profile title, e.g. "Demo"). Two
    // things, not one:
    //   * the play GATE — a scan WAITS (and ADB-switches the Shield) until that profile is
    //     signed in before playing; the demo/IVTC-test reels' libraries are invisible to other
    //     profiles. (decision `2026-08-07-choose-profile-for-queues`)
    //   * the IDENTITY — the queue's next-up and watched state are read as that profile's
    //     account, in the grid and at scan time alike. It was the gate alone until 2026-08-16,
    //     which meant a queue gated to a kid still selected out of the OWNER's history.
    //     (decision `2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to`)
    // Rotation channels are ungated by design (their profiles[] names the account explicitly),
    // so this is only meaningful/editable on queue sets. null = ungated, i.e. the admin view.
    requires_profile: ent.requires_profile != null ? String(ent.requires_profile) : null,
    // The repeating {provider, profile, libraries} block. ALWAYS a list, never null: a set
    // written before blocks existed reports the one implicit Plex block it has always meant,
    // built from `sections` / `requires_profile`. The editor therefore never has to special-
    // case a legacy set, and reading one does not rewrite it (see providers/blocks.js).
    providers: blocksForSet(ent),
    // How a queue on this set STARTS, derived from its blocks. Queues are single-provider
    // (owner, 2026-08-13: "it's either-or for me"), so one value per set is the whole truth.
    //   push -> a lineup is sent at a device (Plex -> the Shield)
    //   pull -> there is nothing to cast to; the app hands back a URL you open (Kavita)
    // Exposed so the UI never offers "Play on <device>" for a set that has no device, and
    // never branches on a provider's NAME.
    delivery: deliveryForSet(ent),
    // …and the WORDS that go with it, so no screen has to re-join a set to /api/providers to
    // decide between "Play" and "Read".
    vocabulary: vocabularyForSet(ent),
    // …and the KIND, which is what the stylesheet scopes the accent on.
    provider_kind: providerKindForSet(ent),
    // Per-scan cap (blank = no limit); applies to curated queues AND rotation channels.
    max_items: toPosIntOrNull(ent.max_items),
    enabled: ent.enabled !== false,
  };
  // v3 PR 2: the profile bindings + behavior (rotation only). profiles is ALWAYS ≥1 entry
  // (synthesized from legacy fields when absent), so the future per-profile form can rely
  // on it while the current single-binding form still reads the mirrored top-level fields.
  // v3 PR 3: `members` — explicit curated member entries ([] = pure dynamic rule).
  // PR 4 cutover flags: has_explicit_profiles distinguishes a real profiles[] channel
  // from a legacy set whose one binding was synthesized above (the auto-scan router and
  // the web editor branch on it); superseded_by marks a legacy tier kept readable during
  // the migration soak (hidden from the UI, skipped by the router, still playable by id).
  if (profiles) {
    return {
      ...common,
      source: 'rotation',
      profiles,
      has_explicit_profiles: Array.isArray(ent.profiles) && ent.profiles.some((p) => Boolean(p) && typeof p === 'object'),
      // Which binding the Play/Channels dropdowns seed to (a binding's plex_user). A pure
      // UI-seed hint — the Python engine ignores it and still plays the profile the play
      // menu passes. A stale value (profile renamed/removed) just falls back to profiles[0]
      // on the web side. (decision `2026-08-07-default-profile-per-channel`)
      default_profile: ent.default_profile != null ? String(ent.default_profile) : null,
      superseded_by: ent.superseded_by != null ? String(ent.superseded_by) : null,
      behavior: isBehavior(ent.behavior) ? ent.behavior : null,
      // DEPRECATED, still reported so nothing that reads it breaks mid-migration. Prefer
      // `length === 'infinite'`, which is what `common.length` already folds it into.
      refill: ent.refill === true,
      // What a FINISHED series does on this channel. `restart` is the only value that does
      // anything; absent reads as drop, which is what every channel has always done.
      // Read TOLERANTLY (unlike the writer, which rejects a typo): a hand-edited file that
      // says `on_complete: nonsense` must still load as the channel it has always been.
      on_complete: String(ent.on_complete || '').trim().toLowerCase() === 'restart' ? 'restart' : null,
      members: toMembers(ent.members),
      // Per-show manual start overrides for the dynamic rule pool (the Channels view
      // reads channel.starts[ratingKey] to seed the "Start from…" picker + chip).
      starts: toStarts(ent.starts),
      // Per-show weights for the dynamic rule pool (the Channels view reads
      // channel.weights[ratingKey] to seed the pool tile's weight control + tag).
      weights: toWeights(ent.weights),
      // Per-show `on_complete`, same keying as `starts` / `weights`. Absent = follow the pool.
      on_complete_by_show: toOnCompleteByShow(ent.on_complete_by_show),
    };
  }
  // Queue-only playback/consumption knobs (rotation channels ignore them). Exposed in the
  // Set editor so they are not hand-YAML only. (decision `2026-08-08-set-modal-queue-flags`)
  // keep_completed: never mark entries done. reel: play the whole lineup every scan AND
  // implies keep_completed (normalize reports both so the UI prefill matches the engine).
  // remove_completed_after: TTL string ("24h"/"7d"/…) or null = keep finished forever.
  const bsa = String(ent.batch_stops_at || '').trim().toLowerCase();
  return {
    ...common,
    source: 'queue',
    keep_completed: Boolean(ent.keep_completed || ent.reel),
    reel: Boolean(ent.reel),
    remove_completed_after:
      ent.remove_completed_after != null && String(ent.remove_completed_after).trim()
        ? String(ent.remove_completed_after).trim()
        : null,
    // WHERE a multi-episode batch may stop: "none" | "member" | "season". Only curated
    // sets carry it — a dynamic channel's round-robin already alternates shows every
    // item, so it has no multi-episode batch to bound. null = the engine default (none).
    batch_stops_at: isBatchStop(bsa) ? bsa : null,
    // HOW MANY items one entry contributes per visit, when the entry says nothing. null =
    // the engine default (env QUEUE_SERIES_DEFAULT, which is 1). A per-entry `episodes:`
    // still wins over this.
    episodes: toPosIntOrNull(ent.episodes),
    // Volumes are NOT chapters. The chapter count must not apply to a volume-based
    // series; this is its own sparse default (null = 1).
    volumes: toPosIntOrNull(ent.volumes),
  };
}

// The whole registry, normalized: { sets: [..] } (file order kept).
//
// Memoized on the file's (mtimeMs, size), same rule as queues.listAll(): every writer moves
// one of the two, and writeDoc() busts it explicitly for same-millisecond same-length writes.
// getSet() is called several times per mutating request (requireQueueSet checks both ends of
// a cross-queue move, then the mutation re-reads), and each call was a full read + parse +
// re-normalize of the registry. `byId` is built once per parse so getSet is a Map lookup.
interface RegistryCache {
  mtimeMs: number;
  size: number;
  reg: SetRegistry;
  byId: Map<string, SetRegistryEntry>;
}
let _regCache: RegistryCache | null = null;

async function registryCache(): Promise<RegistryCache> {
  let st = null;
  try {
    st = await fs.stat(SETS_PATH);
  } catch {
    st = null; // not seeded yet — readDoc() creates it, then the next call memoizes
  }
  if (st && _regCache && _regCache.mtimeMs === st.mtimeMs && _regCache.size === st.size) {
    return _regCache;
  }
  const doc = await readDoc();
  const raw: { sets?: RawSet[] } = doc.toJSON() || {};
  const sets = (raw.sets || []).map(normalize).filter((s): s is SetRegistryEntry => Boolean(s));
  const entry: RegistryCache = {
    mtimeMs: st ? st.mtimeMs : 0,
    size: st ? st.size : 0,
    reg: { sets },
    byId: new Map(sets.map((s) => [s.id, s])),
  };
  if (st) _regCache = entry;
  return entry;
}

export async function getRegistry(): Promise<SetRegistry> {
  return (await registryCache()).reg;
}

export async function getSet(id: string): Promise<SetRegistryEntry | null> {
  return (await registryCache()).byId.get(id) || null;
}

export async function setIds(): Promise<string[]> {
  return (await getRegistry()).sets.map((s) => s.id);
}

// --- mutations (all under the lock; the Python service only ever reads) ------- //

// A new queue's immutable id: slug of the label, de-duplicated with a numeric suffix.
function slugify(label: unknown, taken: string[]): string {
  let base = String(label)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!base) base = 'queue';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`;
  return id;
}

// Build the on-disk object for a NEW rotation channel from the full knob set. Only defined
// knobs are written (an omitted account binding stays off the file rather than as a null),
// so a fully-specified body is playable by the Python service with no code change — it
// re-reads sets.yaml and maps these 1:1 (queue_builder/config.py _load_sets_yaml).
function rotationCreateObj(id: string, body: Record<string, unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id,
    label: String(body.label).trim(),
    kind: body.kind ? String(body.kind) : 'cartoons',
    source: 'rotation',
    sections: toInts(body.sections),
    item_sections: toInts(body.item_sections),
    allowed_ratings:
      Array.isArray(body.allowed_ratings) && body.allowed_ratings.length ? body.allowed_ratings.map(String) : null,
    movie_ratings:
      Array.isArray(body.movie_ratings) && body.movie_ratings.length ? body.movie_ratings.map(String) : null,
    blocklist: Array.isArray(body.blocklist) ? body.blocklist.map(String) : [],
  };
  // Profile bindings (v3 PR 2): when the body carries an explicit `profiles[]` array, write
  // it and SKIP the legacy top-level binding fields (the two shapes are mutually exclusive on
  // disk). Otherwise write the single legacy binding from the top-level fields (unchanged).
  const bodyProfiles = Array.isArray(body.profiles) ? body.profiles.map((p) => bindingWriteObj(p)).filter((b) => Object.keys(b).length) : [];
  if (bodyProfiles.length) {
    obj.profiles = bodyProfiles;
    delete obj.allowed_ratings; // per-binding now — belongs in profiles[], not top-level
    delete obj.movie_ratings;
  } else {
    if (body.plex_user != null && String(body.plex_user).trim()) obj.plex_user = String(body.plex_user).trim();
    if (body.account_id != null && String(body.account_id).trim()) obj.account_id = parseInt(String(body.account_id), 10);
    if (body.user_uuid != null && String(body.user_uuid).trim()) obj.user_uuid = String(body.user_uuid).trim();
    const wca = toInts(body.watch_count_accounts);
    if (wca.length) obj.watch_count_accounts = wca;
  }
  const members = toMembers(body.members);
  if (members.length) obj.members = members;
  if (body.default_profile != null && String(body.default_profile).trim()) obj.default_profile = String(body.default_profile).trim();
  if (isBehavior(body.behavior)) obj.behavior = body.behavior;
  if (isMode(body.mode)) obj.mode = body.mode;
  if (body.audio_language != null && String(body.audio_language).trim()) obj.audio_language = String(body.audio_language).trim();
  const mex = Array.isArray(body.movie_excludes) ? body.movie_excludes.map(String) : [];
  if (mex.length) obj.movie_excludes = mex;
  const mi = toPosIntOrNull(body.max_items);
  if (mi) obj.max_items = mi;
  // The lineup knobs, written by the SAME sparse rules updateSet uses: a length that just
  // repeats THIS KIND's default, a `refill: false`, an `on_complete: drop` and a
  // `power_off_when_done: false` are all stored by absence. Without this a pool created from
  // the editor with top-up switched on came back with it switched off, and the only clue was
  // the file.
  writeLineupKnobs(obj, body, defaultFor(obj));
  return obj;
}

/**
 * The playback-length / completion knobs, applied to a NEW set's on-disk object.
 *
 * Shared by both create paths — a rotation channel and a curated queue — because the knobs
 * are the same on every kind of set now, and two copies of a sparse rule is how one of them
 * quietly stops matching the writer it is supposed to mirror.
 */
function writeLineupKnobs(
  obj: Record<string, unknown>,
  body: Record<string, unknown>,
  kindDefault: number | null,
): void {
  const len = toLineupLength(body.length);
  // `!== kindDefault` and not a truthiness check: 1 is a real length, and on an ordered queue
  // it is also the default — so the comparison is what decides, not the value's shape.
  if (len != null && len !== kindDefault) obj.length = len;
  // DEPRECATED. Only written when a caller explicitly asks AND has not said `infinite`, so a
  // set created through the editor never gets it.
  if (body.refill === true && len !== INFINITE) obj.refill = true;
  const oc = toOnComplete(body.on_complete);
  if (oc) obj.on_complete = oc;
  if (body.power_off_when_done === true) obj.power_off_when_done = true;
}

// Create a set. Curated queues (source omitted / 'queue') carry only label/kind/sections;
// rotation channels (source:'rotation') accept the full account-binding + filter knob set so
// a dynamic channel is now fully authorable from the web UI (workstream E) — previously they
// were hand-YAML only.
//
// THERE IS NO "at least one library" GATE, on any shape, and adding one back is a decision
// reversal: a set that names no library draws from EVERY library its provider has
// (decision `2026-08-17-no-libraries-checked-means-every-library`). The old validator had
// already been patched once to stop rejecting Kavita-only queues over Plex's `sections`
// field; the rule underneath it was the actual bug.
//
// The on-disk shape of a block. `implicit` is a READ-TIME marker (a legacy set reporting the
// single Plex block it has always meant) and must never be written, or a re-read would treat
// a real block as synthesized.
function writableBlocks(blocks: ProviderBlock[]): WritableProviderBlock[] {
  return blocks.map((b) => ({
    provider: b.provider,
    ...(b.profile ? { profile: b.profile } : {}),
    ...(b.libraries.length ? { libraries: b.libraries } : {}),
    ...(b.batch != null ? { batch: b.batch } : {}),
  }));
}

// A set's delivery mode, from its blocks. Unknown/absent providers read as `push`, which
// keeps every pre-provider set behaving exactly as it always has.
//
// The pull-kind list is the provider registry's (`deliveryForKind`), not a copy kept here:
// this file used to hold `new Set(['kavita'])`, which silently made a board-game queue a
// PUSH target — a "Play on <device>" button for a backend with no devices, and no provider
// tiles, because /api/queues resolves a pull set through its own provider.
function deliveryForSet(ent: RawSet): Delivery {
  const blocks: ProviderBlock[] = blocksForSet(ent);
  const defs = new Map<string, string>(providerDefinitions().map((d: { id: string; kind: string }) => [d.id, d.kind]));
  const anyPush = blocks.some((b) => deliveryForKind(defs.get(b.provider)) !== 'pull');
  return anyPush ? 'push' : 'pull';
}

/**
 * The WORDS this set's medium is described in, from its own provider.
 *
 * Derived server-side and carried ON the set for the same reason `delivery` is: every screen
 * that renders a queue already has the set in hand, and making each one re-join a set to
 * `/api/providers` to find out whether to say "Play" or "Read" is how one of them ends up
 * not bothering — which is exactly what happened to the tile play button.
 *
 * A queue draws from exactly one provider, so one vocabulary per set is the whole truth.
 */
function vocabularyForSet(ent: RawSet): ProviderVocabulary {
  return vocabularyForKind(providerKindForSet(ent));
}

/**
 * The KIND of backend this set draws from — `plex` / `kavita`, and `''` for a provider this
 * build does not recognise.
 *
 * The FIRST block's provider. A mixed set is refused at save and at launch, so there is no
 * second answer to reconcile; if one somehow exists on disk, its first block's kind beats
 * reporting none.
 */
function providerKindForSet(ent: RawSet): string {
  const blocks: ProviderBlock[] = blocksForSet(ent);
  const defs = new Map<string, string>(providerDefinitions().map((d: { id: string; kind: string }) => [d.id, d.kind]));
  return defs.get(blocks[0]?.provider ?? '') ?? '';
}

export async function createSet(body: Record<string, unknown> = {}): Promise<{ id: string }> {
  const { label, kind, sections, source } = body;
  const isRotation = source === 'rotation';
  if (!label || !String(label).trim()) throw new Error('label required');
  const secs = toInts(sections);
  // A set may name NO library at all — that is "every library", not "no source". See the
  // note above `writableBlocks`.
  return withLock(async () => {
    const doc = await readDoc();
    const seq = setsSeq(doc);
    const taken = seq.items.map((n) => (isMap(n) ? String(n.get('id')) : '')).filter(Boolean);
    const id = slugify(label, taken);
    // Starts as `{}` rather than null purely so the ternary below needs no assertion: it is
    // overwritten wholesale on the only branch that reads it.
    let curated: Record<string, unknown> = {};
    if (!isRotation) {
      curated = { id, label: String(label).trim(), kind: kind === 'anime' ? 'anime' : 'movies', source: 'queue', sections: secs };
      const mi = toPosIntOrNull(body.max_items);
      if (mi) curated.max_items = mi;
      // Optional profile gate (blank => ungated). Only curated queues carry it; rotation
      // channels are profile-driven and reject it (see updateSet).
      const rp = body.requires_profile == null ? '' : String(body.requires_profile).trim();
      if (rp) curated.requires_profile = rp;
      // Playlist / reel / TTL knobs — same write rules as updateSet (queue-only).
      if (body.reel) curated.reel = true;
      // reel implies keep_completed on disk only when the client also asked for it; the
      // engine treats reel as keep_completed regardless. Prefer an explicit true so a
      // playlist-without-reel writes cleanly without a phantom reel key.
      if (body.keep_completed || body.reel) curated.keep_completed = true;
      const rca = body.remove_completed_after == null ? '' : String(body.remove_completed_after).trim();
      if (rca && !['0', 'never', 'off', 'none', 'disabled'].includes(rca.toLowerCase())) {
        curated.remove_completed_after = rca;
      }
      const bsa = normalizeBatchStop(body.batch_stops_at);
      if (bsa) curated.batch_stops_at = bsa;
      // The queue's default batch. Same sparse rule as updateSet: 1 is the engine default,
      // so only a real choice is written.
      const eps = parseInt(String(body.episodes ?? ''), 10);
      if (Number.isFinite(eps) && eps > 1) curated.episodes = Math.min(eps, QUEUE_SERIES_LENGTH);
      const vols = parseInt(String(body.volumes ?? ''), 10);
      if (Number.isFinite(vols) && vols > 1) curated.volumes = Math.min(vols, QUEUE_SERIES_LENGTH);
      // A curated set takes the playback-length knobs too — they are no longer rotation-only.
      // Its default differs by kind (a curated POOL fills a window, an ordered QUEUE plays one
      // entry), which is why the default is derived from the object rather than passed in.
      writeLineupKnobs(curated, body, defaultFor(curated));
    }
    const obj = isRotation ? rotationCreateObj(id, body) : curated;
    // Provider blocks, on BOTH sources — a reading queue and a reading channel are equally
    // plausible, and a set created with only a non-Plex block would otherwise be written
    // with no source at all and silently play nothing.
    const created = validateBlocks(body.providers);
    if (!created.ok) throw new Error(created.errors.join('; '));
    if (created.blocks.length) obj.providers = writableBlocks(created.blocks);
    const node = doc.createNode(obj);
    // Curated shelves land after the last curated queue, before the rotation block; new
    // rotation channels append at the end (they live after the queues on the shelf).
    let at = seq.items.length;
    if (!isRotation) {
      for (let i = 0; i < seq.items.length; i++) {
        const item = seq.items[i];
        if (isMap(item) && item.get('source') === 'rotation') { at = i; break; }
      }
    }
    seq.items.splice(at, 0, node);
    await writeDoc(doc);
    return { id };
  });
}

// Patch one set. Only label / sections / kind / enabled are editable on curated queues;
// rotation channels additionally accept their filter knobs. `id` and `source` never change.
export async function updateSet(id: string, patch: Record<string, unknown>): Promise<{ ok: true }> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = setsSeq(doc);
    const node = seq.items.find((n): n is YAMLMap => isMap(n) && String(n.get('id')) === id);
    if (!node) throw new Error(`unknown set ${id}`);
    const isRotation = node.get('source') === 'rotation';
    const allow = [
      'label', 'kind', 'sections', 'enabled', 'max_items', 'requires_profile',
      // Queue-only consumption / reel / TTL knobs (rejected below on rotation).
      'keep_completed', 'reel', 'remove_completed_after', 'batch_stops_at',
      // The queue's default batch — the COUNT to batch_stops_at's WHERE. Valid on both
      // sources: a rule-based reading channel wants "3 chapters per series" just as much as
      // a curated one, and unlike the consumption flags it describes the LINEUP, not how
      // entries are retired.
      'episodes',
      // How many VOLUMES a volume-based entry contributes. Independent of `episodes` —
      // a volume is a collection of chapters, not a chapter. Same sparse/clamp rules.
      'volumes',
      // The repeating {provider, profile, libraries} block. Valid on BOTH sources, unlike
      // most knobs here — a reading queue and a reading channel are both plausible.
      'providers',
    ];
    if (isRotation) {
      allow.push(
        'item_sections', 'allowed_ratings', 'movie_ratings', 'blocklist',
        // v2 rotation knobs (workstreams E + I) — account binding + playback/exclude knobs.
        'mode', 'watch_count_accounts', 'plex_user', 'account_id', 'user_uuid',
        'audio_language', 'movie_excludes',
        // v3 PR 2: per-profile bindings + behavior. PR 3: explicit members.
        'profiles', 'behavior', 'members',
        // How many items the lineup holds. Rotation-only: a curated queue's length is
        // however many entries it has, so there is nothing to set there.
        'length',
        // Keep it topped up (`length` becomes the window), and what a finished show does.
        'refill', 'on_complete', 'power_off_when_done',
        // Per-show start + weight overrides for the dynamic rule pool.
        'starts', 'weights', 'on_complete_by_show',
        // Which binding the Play/Channels dropdowns default to (a binding's plex_user).
        'default_profile',
      );
    }
    for (const k of allow) {
      if (!(k in patch)) continue;
      // `unknown`, and it stays `unknown` through every reassignment below. The branches
      // narrow it per key exactly as the JS did; nothing here indexes `patch` by a typed key,
      // so no cast is needed to keep the runtime behaviour identical.
      let v: unknown = patch[k];
      if (k === 'keep_completed' || k === 'reel') {
        // Queue-only booleans. false/absent drops the key so the file stays sparse.
        // Rotation channels have no consumption model here — reject rather than no-op so a
        // mis-pointed client surfaces immediately.
        if (isRotation) throw new Error(`${k} is only valid on curated queues`);
        const on = v === true || v === 'true' || v === 1 || v === '1';
        if (!on) { node.delete(k); continue; }
        setKeepingComment(node, k, doc.createNode(true));
        // reel implies keep_completed at the engine; also write it so a hand-reader of
        // sets.yaml sees the non-consuming intent without having to know the implication.
        if (k === 'reel' && !node.get('keep_completed')) {
          setKeepingComment(node, 'keep_completed', doc.createNode(true));
        }
        continue;
      }
      if (k === 'remove_completed_after') {
        // Opt-in finished-entry TTL. Blank / never / 0 drops the key (= keep forever).
        if (isRotation) throw new Error('remove_completed_after is only valid on curated queues');
        const s = v == null ? '' : String(v).trim();
        if (!s || ['0', 'never', 'off', 'none', 'disabled'].includes(s.toLowerCase())) {
          node.delete('remove_completed_after');
          continue;
        }
        setKeepingComment(node, 'remove_completed_after', doc.createNode(s));
        continue;
      }
      if (k === 'batch_stops_at') {
        // Where a multi-episode batch may stop. "none"/blank/unrecognised drops the key (the
        // engine default), so the file stays sparse and a typo can never persist.
        if (isRotation) throw new Error('batch_stops_at is only valid on curated queues');
        const bsa = normalizeBatchStop(v);
        if (!bsa) { node.delete('batch_stops_at'); continue; }
        setKeepingComment(node, 'batch_stops_at', doc.createNode(bsa));
        continue;
      }
      if (k === 'episodes') {
        // The set's DEFAULT batch — how many items one entry contributes per visit. The COUNT
        // to batch_stops_at's WHERE, and stored the same sparse way: 1 is the engine default,
        // so it drops the key rather than writing the value everyone already has.
        //
        // Clamped to QUEUE_SERIES_LENGTH, the same hard safety cap a per-entry override gets
        // (queues.setEpisodes) — a hand-posted 900 must not queue a whole library.
        const n = parseInt(String(v ?? ''), 10);
        if (!Number.isFinite(n) || n <= 1) { node.delete('episodes'); continue; }
        setKeepingComment(node, 'episodes', doc.createNode(Math.min(n, QUEUE_SERIES_LENGTH)));
        continue;
      }
      if (k === 'volumes') {
        // How many VOLUMES a volume-based series contributes per visit. Independent of
        // `episodes` — a volume is a collection of chapters, so the chapter count must
        // not apply. 1 is the default and drops the key.
        const n = parseInt(String(v ?? ''), 10);
        if (!Number.isFinite(n) || n <= 1) { node.delete('volumes'); continue; }
        setKeepingComment(node, 'volumes', doc.createNode(Math.min(n, QUEUE_SERIES_LENGTH)));
        continue;
      }
      if (k === 'providers') {
        // Whole-array replace, like members/profiles: the editor sends the full desired
        // block list. An empty list drops the key entirely, which is NOT the same as
        // "no providers" — it means "fall back to the implicit single Plex block", so a
        // set that never had blocks is byte-identical after an unrelated edit.
        const { ok, errors, blocks } = validateBlocks(v);
        if (!ok) throw new Error(errors.join('; '));
        if (!blocks.length) { node.delete('providers'); continue; }
        node.set('providers', doc.createNode(writableBlocks(blocks)));
        continue;
      }
      if (k === 'members') {
        // Whole-array replace, like profiles: the grid sends the full desired list. An
        // empty list drops the key entirely (back to the pure dynamic rule).
        const list = toMembers(v);
        if (!list.length) { node.delete('members'); continue; }
        node.set('members', doc.createNode(list));
        continue;
      }
      if (k === 'starts') {
        // Whole-map replace, like members: the Channels view sends the full desired
        // {ratingKey: {season, episode}} map. An empty map drops the key entirely (every
        // show back to its natural next-unwatched).
        const map = toStarts(v);
        if (!Object.keys(map).length) { node.delete('starts'); continue; }
        node.set('starts', doc.createNode(map));
        continue;
      }
      if (k === 'on_complete_by_show') {
        // Whole-map replace, exactly like `starts` and `weights`: the Channels view sends the
        // full desired {ratingKey: 'restart'|'drop'} map. `toOnCompleteByShow` drops anything
        // unrecognised, so an empty result means "no show overrides the pool any more" and the
        // key goes with it.
        //
        // A `drop` IS stored, even though drop is also the engine default: on a pool set to
        // `restart` it is a real override, and that is the case this exists for. Sparseness
        // here is "follows the pool", not "equals the engine default".
        const map = toOnCompleteByShow(v);
        if (!Object.keys(map).length) { node.delete('on_complete_by_show'); continue; }
        node.set('on_complete_by_show', doc.createNode(map));
        continue;
      }
      if (k === 'weights') {
        // Whole-map replace, exactly like `starts`: the Channels view sends the full desired
        // {ratingKey: n} map. toWeights already drops every 1, so an empty result means "no
        // show is weighted any more" and the key goes with it.
        const map = toWeights(v);
        if (!Object.keys(map).length) { node.delete('weights'); continue; }
        node.set('weights', doc.createNode(map));
        continue;
      }
      if (k === 'profiles') {
        // Binding CRUD is whole-array replace: the form sends the full desired profiles[].
        // Writing profiles[] makes it the source of truth, so drop the now-stale legacy
        // top-level binding fields (the two shapes are mutually exclusive on disk).
        const list = (Array.isArray(v) ? v : []).map((p) => bindingWriteObj(p)).filter((b) => Object.keys(b).length);
        if (!list.length) throw new Error('at least one profile binding required');
        node.set('profiles', doc.createNode(list));
        for (const bk of BINDING_KEYS) node.delete(bk);
        continue;
      }
      if (k === 'behavior') {
        if (!isBehavior(v)) { node.delete('behavior'); continue; } // cleared/invalid => drop
        node.set('behavior', doc.createNode(v));
        continue;
      }
      if (k === 'default_profile') {
        // A UI-seed hint keyed by plex_user; blank/absent => no default (drop the key so the
        // dropdowns fall back to profiles[0]).
        const s = v == null ? '' : String(v).trim();
        if (!s) { node.delete('default_profile'); continue; }
        node.set('default_profile', doc.createNode(s));
        continue;
      }
      if (k === 'requires_profile') {
        // Gate a curated queue to a Plex Home profile (blank => ungated, drop the key). The
        // value is the PMS-log profile title the play-gate matches on. Rotation channels are
        // profile-DRIVEN (their set:"auto" scan lets the signed-in profile pick the tier), so
        // a fixed gate here would break routing — reject a non-empty value on rotation.
        const s = v == null ? '' : String(v).trim();
        if (isRotation && s) throw new Error('rotation channels cannot require a profile (they are profile-driven)');
        if (!s) { node.delete('requires_profile'); continue; }
        node.set('requires_profile', doc.createNode(s));
        continue;
      }
      if (k === 'sections' || k === 'item_sections') {
        // Normalized, never validated: clearing every library is a legitimate edit that means
        // "draw from all of them" (see the note above `writableBlocks`). This used to throw
        // on an empty union, which is how unchecking the last box read as a save failure.
        v = toInts(v);
      }
      if (k === 'blocklist' || k === 'movie_excludes') v = (Array.isArray(v) ? v : []).map(String);
      if (k === 'allowed_ratings' || k === 'movie_ratings') {
        v = Array.isArray(v) ? v.map(String) : null; // null => no rating cap
      }
      if (k === 'watch_count_accounts') v = toInts(v);
      if (k === 'account_id') v = v == null || String(v).trim() === '' ? null : parseInt(String(v), 10);
      if (k === 'max_items') {
        v = toPosIntOrNull(v);
        if (v == null) { node.delete('max_items'); continue; } // cleared => drop the key (no cap)
      }
      if (k === 'length') {
        const n = toLineupLength(v);

        // `length: infinite` RETIRES `refill`, which was its 2026-08-17 spelling. Leaving both
        // would be two keys answering one question, and the older one is the deprecated half —
        // this is the migration, and it happens the first time the set is saved.
        if (n === INFINITE) { node.delete('refill'); v = n; }
        else {
          // Sparse, against THIS KIND's own default rather than one env constant: a rewatch
          // pool follows 1, a filtered pool 12, an ordered queue 1. The editor posts the
          // effective number on every Save, so without this a rename would stamp `length: 1`
          // onto every movie queue in the file.
          const kindDefault = defaultFor({
            source: readNodeValue(node, 'source'),
            kind: readNodeValue(node, 'kind'),
            behavior: readNodeValue(node, 'behavior'),
            mode: readNodeValue(node, 'mode'),
            ...pickDefined(patch, ['source', 'kind', 'behavior', 'mode']),
          });

          if (n == null || n === kindDefault) { node.delete('length'); continue; }
          v = n;
        }
      }
      if (k === 'refill') {
        // DEPRECATED — `length: infinite` says this now. Still accepted so a hand-written file
        // or an older caller keeps working, and still written sparsely; the editor never sends
        // it, so a set saved through the UI sheds it.
        if (v !== true) { node.delete('refill'); continue; }
      }
      if (k === 'power_off_when_done') {
        // Sparse: only `true` is written. Absent means "leave the room alone", which is what
        // every set has always done.
        if (v !== true) { node.delete('power_off_when_done'); continue; }
      }
      if (k === 'on_complete') {
        const s = toOnComplete(v);
        if (s == null) { node.delete('on_complete'); continue; }
        v = s;
      }
      if (k === 'mode' && !isMode(v)) throw new Error(`invalid mode ${String(v)}`);
      if (k === 'audio_language') v = v == null || String(v).trim() === '' ? null : String(v).trim();
      if ((k === 'plex_user' || k === 'user_uuid') && v != null) v = String(v);
      if (k === 'label') {
        v = String(v).trim();
        if (!v) throw new Error('label required');
      }
      // Preserve an inline comment on the value being replaced (e.g. `label: Bob  # rename
      // freely` typed over SMB) — see setKeepingComment + e2e/yaml-roundtrip-test.mjs.
      setKeepingComment(node, k, doc.createNode(v));
    }
    await writeDoc(doc);
    return { ok: true };
  });
}

// Delete any set — curated queue OR rotation channel. Rotation deletion was blocked until
// 2026-07-27 (when the kid channels became user-created + splittable, deleting an unwanted
// one is a real need). The id is referenced by NFC cards / HA / MQTT by design, and this
// process cannot see HA's tag_command_map, so a card pointing at a deleted channel silently
// breaks — the web UI's confirm dialog warns before deleting. See the superseding decision.
export async function deleteSet(id: string): Promise<{ deleted: boolean }> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = setsSeq(doc);
    const i = seq.items.findIndex((n) => isMap(n) && String(n.get('id')) === id);
    if (i < 0) return { deleted: false };
    seq.items.splice(i, 1);
    await writeDoc(doc);
    return { deleted: true };
  });
}

// --- PR 4 live migration: younger/older tiers → function channels -------------- //
// One-time transform (run via server/migrate-tiers.mjs, NOT at boot — the harness fixtures
// keep the legacy shape for the back-compat suites): the two legacy tier sets become
//   * shows_shorts  behavior:progress  — one binding per tier from its allowed_ratings
//   * movies        behavior:rewatch   — same bindings; the pool reads movie_ratings
// The legacy entries STAY in the file, marked `superseded_by`, so `{set:"younger"}`
// payloads (HA button path) keep playing identically during the soak; ids are immutable
// so the new channels get NEW ids and the cards' set:"auto" routing repoints in
// queue_builder/config.channel_for (2026-07-21-sets-registry-immutable-ids).
export async function migrateLegacyTiers(): Promise<
  { migrated: false; reason: string } | { migrated: true; channels: string[]; bindings: unknown[] }
> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = setsSeq(doc);
    const byId = (setId: string): YAMLMap | undefined =>
      seq.items.find((n): n is YAMLMap => isMap(n) && String(n.get('id')) === setId);
    if (byId('shows_shorts') || byId('movies')) return { migrated: false as const, reason: 'function channels already exist' };
    const tiers = ['younger', 'older']
      .map(byId)
      .filter((n): n is YAMLMap => Boolean(n) && n?.get('source') === 'rotation' && !n.get('profiles'));
    if (!tiers.length) return { migrated: false as const, reason: 'no legacy tier sets to migrate' };
    const raw: RawSet[] = tiers.map((n) => n.toJSON());
    const uniqInts = (lists: unknown[][]): number[] => [...new Set(lists.flat().map((x) => parseInt(String(x), 10)).filter((x) => !Number.isNaN(x)))];
    const uniqStrs = (lists: unknown[][]): string[] => [...new Set(lists.flat().map(String))];
    const bindings = raw.map((e) => bindingWriteObj(e));
    const blocklist = uniqStrs(raw.map((e) => e.blocklist || []));
    const audio = raw.map((e) => e.audio_language).find((a) => a != null && String(a).trim());
    const showsObj: Record<string, unknown> = {
      id: 'shows_shorts',
      label: 'Shows & Shorts',
      kind: 'cartoons',
      source: 'rotation',
      behavior: 'progress',
      sections: uniqInts(raw.map((e) => e.sections || [])),
      item_sections: uniqInts(raw.map((e) => e.item_sections || [])),
    };
    if (blocklist.length) showsObj.blocklist = blocklist;
    if (audio) showsObj.audio_language = audio;
    showsObj.profiles = bindings;
    const moviesObj = {
      id: 'movies',
      label: 'Movies',
      kind: 'movies',
      source: 'rotation',
      behavior: 'rewatch',
      // The rewatch pool reads the whole Movies library (queue_builder scopes it by the
      // binding's account + movie_ratings); sections here only scope the ratings picker.
      sections: [parseInt(process.env.PLEX_SEC_MOVIES || '1', 10)],
      profiles: bindings,
    };
    for (const n of tiers) n.set('superseded_by', doc.createNode('shows_shorts,movies'));
    seq.items.push(doc.createNode(showsObj), doc.createNode(moviesObj));
    await writeDoc(doc);
    return { migrated: true as const, channels: ['shows_shorts', 'movies'], bindings: bindings.map((b) => b.plex_user) };
  });
}

// Reorder the shelves: `ids` is the new full order; unnamed entries keep their relative
// order at the end (same forgiving rule as a queue reorder).
export async function reorderSets(ids: string[]): Promise<{ reordered: boolean }> {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = setsSeq(doc);
    const rank = new Map<string, number>(ids.map((k, i) => [k, i]));
    const withKeys = seq.items.map((n, i) => ({ n, k: isMap(n) ? String(n.get('id')) : '', i }));
    withKeys.sort((a, b) => {
      const ra = rank.get(a.k) ?? ids.length + a.i;
      const rb = rank.get(b.k) ?? ids.length + b.i;
      return ra - rb;
    });
    seq.items = withKeys.map((x) => x.n);
    await writeDoc(doc);
    return { reordered: true };
  });
}

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
import { parseDocument, YAMLSeq } from 'yaml';

export const SETS_PATH = process.env.SETS_PATH || '/config/sets.yaml';

// Set a map key while PRESERVING any inline/leading comment on the value being replaced.
// `map.set(key, node)` swaps the value node wholesale, which drops a `label: Bob  # comment`
// annotation a human typed over SMB — the exact loss `e2e/yaml-roundtrip-test.mjs` guards.
// The comment lives on the scalar VALUE node (`pair.value.comment`), so carry it across.
function setKeepingComment(map, key, newNode) {
  const pair = map.items.find((p) => p.key && String(p.key.value) === key);
  if (pair && pair.value) {
    if (pair.value.comment != null && newNode && typeof newNode === 'object') newNode.comment = pair.value.comment;
    if (pair.value.commentBefore != null && newNode && typeof newNode === 'object') newNode.commentBefore = pair.value.commentBefore;
  }
  map.set(key, newNode);
}

const LOCK_DIR = SETS_PATH + '.lock';
const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(LOCK_DIR);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
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

async function withLock(fn) {
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
const DEFAULT_YAML = `# plex-channels set registry — the single source of truth for every set (curated queue
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

async function ensureFile() {
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
      if (e.code !== 'EEXIST') throw e; // a concurrent seeder won the race — fine
    }
  }
}

async function readDoc() {
  await ensureFile();
  const doc = parseDocument(await fs.readFile(SETS_PATH, 'utf8'));
  if (!(doc.get('sets') instanceof YAMLSeq)) throw new Error('sets.yaml has no sets list');
  return doc;
}

const YAML_OUT = { indentSeq: false, lineWidth: 0 };

async function writeDoc(doc) {
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

const toInts = (a) => (Array.isArray(a) ? a.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x)) : []);

// A per-scan item cap (max_items): a positive integer, or null when blank/absent/invalid
// (no limit). Mirrors queue_builder/config.py's coercion (int > 0 else None).
const toPosIntOrNull = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const MODES = ['rewatch', 'episodic', 'both'];
// behavior (v3 PR 2) supersedes `mode`: progress = advance through unwatched ("next
// episode"), rewatch = weighted least-watched replay. Mirrors queue_builder/config.py.
const BEHAVIORS = ['progress', 'rewatch'];

// The per-profile binding fields (v3 PR 2): a rotation channel works with one or more
// PROFILES, each carrying that channel's per-profile rating caps + account identity. The
// legacy `younger`/`older` sets encode exactly one such binding at the top level; the
// reader below synthesizes a one-element `profiles` list from those top-level fields when
// no explicit `profiles` array is present (back-compat). Channel-level fields (sections,
// blocklist, behavior, kind) stay OUT of the binding. See the decision doc.
const BINDING_KEYS = ['plex_user', 'account_id', 'user_uuid', 'allowed_ratings', 'movie_ratings', 'watch_count_accounts', 'movie_excludes'];

// Normalize one binding for the API response (arrays kept as arrays; ids coerced).
function normalizeBinding(src) {
  return {
    plex_user: src.plex_user ?? null,
    account_id: src.account_id ?? null,
    user_uuid: src.user_uuid ?? null,
    allowed_ratings: Array.isArray(src.allowed_ratings) ? src.allowed_ratings.map(String) : null,
    movie_ratings: Array.isArray(src.movie_ratings) ? src.movie_ratings.map(String) : null,
    watch_count_accounts: toInts(src.watch_count_accounts),
    movie_excludes: Array.isArray(src.movie_excludes) ? src.movie_excludes.map(String) : [],
  };
}

// The profiles list for a rotation set: explicit `profiles[]` when present, else ONE binding
// synthesized from the legacy top-level fields.
function readProfiles(ent) {
  const raw = Array.isArray(ent.profiles) ? ent.profiles.filter((p) => p && typeof p === 'object') : [];
  return (raw.length ? raw : [ent]).map(normalizeBinding);
}

// Build the on-disk YAML object for one binding — only DEFINED knobs are written (an omitted
// field stays off the file rather than as a null), mirroring rotationCreateObj's style.
function bindingWriteObj(src = {}) {
  const b = {};
  if (src.plex_user != null && String(src.plex_user).trim()) b.plex_user = String(src.plex_user).trim();
  if (src.account_id != null && String(src.account_id).trim() !== '') b.account_id = parseInt(src.account_id, 10);
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
function memberWriteValue(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const m = {};
    if (v.ratingKey != null && String(v.ratingKey).trim() !== '') m.ratingKey = String(v.ratingKey).trim();
    if (v.collection != null && String(v.collection).trim()) m.collection = String(v.collection).trim();
    if (v.title != null && String(v.title).trim()) m.title = String(v.title).trim();
    const eps = parseInt(v.episodes, 10);
    if (Number.isFinite(eps) && eps > 0) m.episodes = eps;
    return m.ratingKey || m.collection || m.title ? m : null;
  }
  const s = String(v).trim();
  return s || null;
}
const toMembers = (a) => (Array.isArray(a) ? a.map(memberWriteValue).filter((m) => m != null) : []);

// A rotation channel's per-show manual start map (decision 2026-08-07-dynamic-pool-start-
// override): ratingKey -> {season?, episode?, series?}. The mirror of a curated member's
// embedded `start`, but for a rule-derived pool show that has no stored entry. Cleaned to
// the same {series?, season?, episode?} floor shape the engine's _at_or_after_start reads;
// entries with neither an episode nor a series are dropped (a cleared start removes its key).
function toStarts(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [rk, s] of Object.entries(v)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const start = {};
    if (s.series != null && String(s.series).trim()) start.series = String(s.series).trim();
    const season = parseInt(s.season, 10);
    const episode = parseInt(s.episode, 10);
    if (Number.isFinite(season)) start.season = season;
    if (Number.isFinite(episode)) start.episode = episode;
    if (start.series != null || start.episode != null) out[String(rk)] = start;
  }
  return out;
}

function normalize(ent) {
  const id = String(ent.id || '').trim();
  if (!id) return null;
  const source = ent.source === 'rotation' ? 'rotation' : 'queue';
  const isRotation = source === 'rotation';
  const mode = MODES.includes(ent.mode) ? ent.mode : isRotation ? 'both' : null;
  // Rotation sets carry a profiles[] list; the DEFAULT binding (profiles[0]) is mirrored to
  // the top-level binding fields so the existing single-binding form (and any un-migrated
  // reader) keeps working unchanged. Queue sets have no bindings.
  const profiles = isRotation ? readProfiles(ent) : null;
  const def = profiles ? profiles[0] : null;
  return {
    id,
    label: String(ent.label || id),
    kind: ent.kind || 'movies',
    source,
    sections: toInts(ent.sections),
    item_sections: toInts(ent.item_sections),
    allowed_ratings: isRotation ? def.allowed_ratings : (Array.isArray(ent.allowed_ratings) ? ent.allowed_ratings.map(String) : null),
    movie_ratings: isRotation ? def.movie_ratings : (Array.isArray(ent.movie_ratings) ? ent.movie_ratings.map(String) : null),
    blocklist: Array.isArray(ent.blocklist) ? ent.blocklist.map(String) : [],
    // v2 knobs (workstreams E + I): carry the full rotation field set the Python service
    // reads. user_uuid/watch_count_accounts were previously DROPPED here, so a rotation set
    // created/edited via the API lost its account binding — now round-tripped intact.
    movie_excludes: isRotation ? def.movie_excludes : (Array.isArray(ent.movie_excludes) ? ent.movie_excludes.map(String) : []),
    watch_count_accounts: isRotation ? def.watch_count_accounts : toInts(ent.watch_count_accounts),
    plex_user: isRotation ? def.plex_user : (ent.plex_user ?? null),
    account_id: isRotation ? def.account_id : (ent.account_id ?? null),
    user_uuid: isRotation ? def.user_uuid : (ent.user_uuid ?? null),
    mode,
    // v3 PR 2: the profile bindings + behavior (rotation only). profiles is ALWAYS ≥1 entry
    // (synthesized from legacy fields when absent), so the future per-profile form can rely
    // on it while the current single-binding form still reads the mirrored top-level fields.
    // v3 PR 3: `members` — explicit curated member entries ([] = pure dynamic rule).
    // PR 4 cutover flags: has_explicit_profiles distinguishes a real profiles[] channel
    // from a legacy set whose one binding was synthesized above (the auto-scan router and
    // the web editor branch on it); superseded_by marks a legacy tier kept readable during
    // the migration soak (hidden from the UI, skipped by the router, still playable by id).
    ...(isRotation
      ? {
          profiles,
          has_explicit_profiles: Array.isArray(ent.profiles) && ent.profiles.some((p) => p && typeof p === 'object'),
          // Which binding the Play/Channels dropdowns seed to (a binding's plex_user). A pure
          // UI-seed hint — the Python engine ignores it and still plays the profile the play
          // menu passes. A stale value (profile renamed/removed) just falls back to profiles[0]
          // on the web side. (decision `2026-08-07-default-profile-per-channel`)
          default_profile: ent.default_profile != null ? String(ent.default_profile) : null,
          superseded_by: ent.superseded_by != null ? String(ent.superseded_by) : null,
          behavior: BEHAVIORS.includes(ent.behavior) ? ent.behavior : null,
          members: toMembers(ent.members),
          // Per-show manual start overrides for the dynamic rule pool (the Channels view
          // reads channel.starts[ratingKey] to seed the "Start from…" picker + chip).
          starts: toStarts(ent.starts),
        }
      : {}),
    audio_language: ent.audio_language != null ? String(ent.audio_language) : null,
    // Gate a curated queue to a Plex Home profile (the value is the PMS-log profile title,
    // e.g. "Demo"). A scan WAITS (and ADB-switches the Shield) until that profile is signed
    // in before playing — the demo/IVTC-test reels' libraries are invisible to other
    // profiles. Rotation channels are ungated by design, so this is only meaningful/editable
    // on queue sets. null = ungated. (decision `2026-08-07-choose-profile-for-queues`)
    requires_profile: ent.requires_profile != null ? String(ent.requires_profile) : null,
    // Per-scan cap (blank = no limit); applies to curated queues AND rotation channels.
    max_items: toPosIntOrNull(ent.max_items),
    enabled: ent.enabled !== false,
  };
}

// The whole registry, normalized: { sets: [..] } (file order kept).
//
// Memoized on the file's (mtimeMs, size), same rule as queues.listAll(): every writer moves
// one of the two, and writeDoc() busts it explicitly for same-millisecond same-length writes.
// getSet() is called several times per mutating request (requireQueueSet checks both ends of
// a cross-queue move, then the mutation re-reads), and each call was a full read + parse +
// re-normalize of the registry. `byId` is built once per parse so getSet is a Map lookup.
let _regCache = null; // { mtimeMs, size, reg, byId }

async function registryCache() {
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
  const raw = doc.toJSON() || {};
  const sets = (raw.sets || []).map(normalize).filter(Boolean);
  const entry = {
    mtimeMs: st ? st.mtimeMs : 0,
    size: st ? st.size : 0,
    reg: { sets },
    byId: new Map(sets.map((s) => [s.id, s])),
  };
  if (st) _regCache = entry;
  return entry;
}

export async function getRegistry() {
  return (await registryCache()).reg;
}

export async function getSet(id) {
  return (await registryCache()).byId.get(id) || null;
}

export async function setIds() {
  return (await getRegistry()).sets.map((s) => s.id);
}

// --- mutations (all under the lock; the Python service only ever reads) ------- //

// A new queue's immutable id: slug of the label, de-duplicated with a numeric suffix.
function slugify(label, taken) {
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
function rotationCreateObj(id, body) {
  const obj = {
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
  const bodyProfiles = Array.isArray(body.profiles) ? body.profiles.map(bindingWriteObj).filter((b) => Object.keys(b).length) : [];
  if (bodyProfiles.length) {
    obj.profiles = bodyProfiles;
    delete obj.allowed_ratings; // per-binding now — belongs in profiles[], not top-level
    delete obj.movie_ratings;
  } else {
    if (body.plex_user != null && String(body.plex_user).trim()) obj.plex_user = String(body.plex_user).trim();
    if (body.account_id != null && String(body.account_id).trim()) obj.account_id = parseInt(body.account_id, 10);
    if (body.user_uuid != null && String(body.user_uuid).trim()) obj.user_uuid = String(body.user_uuid).trim();
    const wca = toInts(body.watch_count_accounts);
    if (wca.length) obj.watch_count_accounts = wca;
  }
  const members = toMembers(body.members);
  if (members.length) obj.members = members;
  if (body.default_profile != null && String(body.default_profile).trim()) obj.default_profile = String(body.default_profile).trim();
  if (BEHAVIORS.includes(body.behavior)) obj.behavior = body.behavior;
  if (MODES.includes(body.mode)) obj.mode = body.mode;
  if (body.audio_language != null && String(body.audio_language).trim()) obj.audio_language = String(body.audio_language).trim();
  const mex = Array.isArray(body.movie_excludes) ? body.movie_excludes.map(String) : [];
  if (mex.length) obj.movie_excludes = mex;
  const mi = toPosIntOrNull(body.max_items);
  if (mi) obj.max_items = mi;
  return obj;
}

// Create a set. Curated queues (source omitted / 'queue') carry only label/kind/sections;
// rotation channels (source:'rotation') accept the full account-binding + filter knob set so
// a dynamic channel is now fully authorable from the web UI (workstream E) — previously they
// were hand-YAML only.
export async function createSet(body = {}) {
  const { label, kind, sections, source } = body;
  const isRotation = source === 'rotation';
  if (!label || !String(label).trim()) throw new Error('label required');
  const secs = toInts(sections);
  // A rotation channel may carry NO show library: a Shorts-only channel draws entirely from
  // item_sections. Curated queues always need a real section (that is what title search scopes).
  const itemSecs = toInts(body.item_sections);
  if (!secs.length && !(isRotation && itemSecs.length)) {
    throw new Error('at least one library section required');
  }
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get('sets');
    const taken = seq.items.map((n) => String(n.get ? n.get('id') : '')).filter(Boolean);
    const id = slugify(label, taken);
    let curated = null;
    if (!isRotation) {
      curated = { id, label: String(label).trim(), kind: kind === 'anime' ? 'anime' : 'movies', source: 'queue', sections: secs };
      const mi = toPosIntOrNull(body.max_items);
      if (mi) curated.max_items = mi;
      // Optional profile gate (blank => ungated). Only curated queues carry it; rotation
      // channels are profile-driven and reject it (see updateSet).
      const rp = body.requires_profile == null ? '' : String(body.requires_profile).trim();
      if (rp) curated.requires_profile = rp;
    }
    const node = doc.createNode(isRotation ? rotationCreateObj(id, body) : curated);
    // Curated shelves land after the last curated queue, before the rotation block; new
    // rotation channels append at the end (they live after the queues on the shelf).
    let at = seq.items.length;
    if (!isRotation) {
      for (let i = 0; i < seq.items.length; i++) {
        if (seq.items[i].get && seq.items[i].get('source') === 'rotation') { at = i; break; }
      }
    }
    seq.items.splice(at, 0, node);
    await writeDoc(doc);
    return { id };
  });
}

// Patch one set. Only label / sections / kind / enabled are editable on curated queues;
// rotation channels additionally accept their filter knobs. `id` and `source` never change.
export async function updateSet(id, patch) {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get('sets');
    const node = seq.items.find((n) => n.get && String(n.get('id')) === id);
    if (!node) throw new Error(`unknown set ${id}`);
    const isRotation = node.get('source') === 'rotation';
    const allow = ['label', 'kind', 'sections', 'enabled', 'max_items', 'requires_profile'];
    if (isRotation) {
      allow.push(
        'item_sections', 'allowed_ratings', 'movie_ratings', 'blocklist',
        // v2 rotation knobs (workstreams E + I) — account binding + playback/exclude knobs.
        'mode', 'watch_count_accounts', 'plex_user', 'account_id', 'user_uuid',
        'audio_language', 'movie_excludes',
        // v3 PR 2: per-profile bindings + behavior. PR 3: explicit members.
        'profiles', 'behavior', 'members',
        // Per-show start overrides for the dynamic rule pool.
        'starts',
        // Which binding the Play/Channels dropdowns default to (a binding's plex_user).
        'default_profile',
      );
    }
    for (const k of allow) {
      if (!(k in patch)) continue;
      let v = patch[k];
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
      if (k === 'profiles') {
        // Binding CRUD is whole-array replace: the form sends the full desired profiles[].
        // Writing profiles[] makes it the source of truth, so drop the now-stale legacy
        // top-level binding fields (the two shapes are mutually exclusive on disk).
        const list = (Array.isArray(v) ? v : []).map(bindingWriteObj).filter((b) => Object.keys(b).length);
        if (!list.length) throw new Error('at least one profile binding required');
        node.set('profiles', doc.createNode(list));
        for (const bk of BINDING_KEYS) node.delete(bk);
        continue;
      }
      if (k === 'behavior') {
        if (!BEHAVIORS.includes(v)) { node.delete('behavior'); continue; } // cleared/invalid => drop
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
        v = toInts(v);
        // Validate the EFFECTIVE union, not the one key: a rotation channel is allowed to have
        // no show library (Shorts-only), so `sections: []` is fine as long as some library
        // remains. Curated queues still require a real `sections`.
        if (isRotation) {
          const otherKey = k === 'sections' ? 'item_sections' : 'sections';
          const other = otherKey in patch
            ? toInts(patch[otherKey])
            : toInts(node.get(otherKey)?.toJSON?.());
          if (!v.length && !other.length) throw new Error('at least one library section required');
        } else if (k === 'sections' && !v.length) {
          throw new Error('at least one library section required');
        }
      }
      if (k === 'blocklist' || k === 'movie_excludes') v = (Array.isArray(v) ? v : []).map(String);
      if (k === 'allowed_ratings' || k === 'movie_ratings') {
        v = Array.isArray(v) ? v.map(String) : null; // null => no rating cap
      }
      if (k === 'watch_count_accounts') v = toInts(v);
      if (k === 'account_id') v = v == null || String(v).trim() === '' ? null : parseInt(v, 10);
      if (k === 'max_items') {
        v = toPosIntOrNull(v);
        if (v == null) { node.delete('max_items'); continue; } // cleared => drop the key (no cap)
      }
      if (k === 'mode' && !MODES.includes(v)) throw new Error(`invalid mode ${v}`);
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
export async function deleteSet(id) {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get('sets');
    const i = seq.items.findIndex((n) => n.get && String(n.get('id')) === id);
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
export async function migrateLegacyTiers() {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get('sets');
    const byId = (id) => seq.items.find((n) => n.get && String(n.get('id')) === id);
    if (byId('shows_shorts') || byId('movies')) return { migrated: false, reason: 'function channels already exist' };
    const tiers = ['younger', 'older']
      .map(byId)
      .filter((n) => n && n.get('source') === 'rotation' && !n.get('profiles'));
    if (!tiers.length) return { migrated: false, reason: 'no legacy tier sets to migrate' };
    const raw = tiers.map((n) => n.toJSON());
    const uniqInts = (lists) => [...new Set(lists.flat().map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x)))];
    const uniqStrs = (lists) => [...new Set(lists.flat().map(String))];
    const bindings = raw.map((e) => bindingWriteObj(e));
    const blocklist = uniqStrs(raw.map((e) => e.blocklist || []));
    const audio = raw.map((e) => e.audio_language).find((a) => a != null && String(a).trim());
    const showsObj = {
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
    return { migrated: true, channels: ['shows_shorts', 'movies'], bindings: bindings.map((b) => b.plex_user) };
  });
}

// Reorder the shelves: `ids` is the new full order; unnamed entries keep their relative
// order at the end (same forgiving rule as a queue reorder).
export async function reorderSets(ids) {
  return withLock(async () => {
    const doc = await readDoc();
    const seq = doc.get('sets');
    const rank = new Map(ids.map((k, i) => [k, i]));
    const withKeys = seq.items.map((n, i) => ({ n, k: n.get ? String(n.get('id')) : '', i }));
    withKeys.sort((a, b) => {
      const ra = rank.has(a.k) ? rank.get(a.k) : ids.length + a.i;
      const rb = rank.has(b.k) ? rank.get(b.k) : ids.length + b.i;
      return ra - rb;
    });
    seq.items = withKeys.map((x) => x.n);
    await writeDoc(doc);
    return { reordered: true };
  });
}

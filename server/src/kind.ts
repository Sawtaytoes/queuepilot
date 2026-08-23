// Product `kind` is picks | rules (decision 2026-08-23-kind-is-picks-or-rules).
//
// On disk and on the MQTT wire the only values after cutover are those two. Older
// spellings (movies / anime / cartoons / demo / movie) still arrive from live YAML and
// from HA until every consumer ships, so every READ goes through normalizeProductKind /
// isRandomOrder; every WRITE emits only the product values.
//
// `add_as` is the lane default inside a Picks queue (priority | random). It replaces the
// old movies-vs-anime discriminator for playback order: movies meant ordered (priority),
// anime meant shuffled (random). Absent add_as on a picks set means random — today's
// curated default — except when the on-disk kind is still the legacy `movies` spelling,
// which meant ordered.

export type ProductKind = 'picks' | 'rules';
export type AddAs = 'priority' | 'random';

const LEGACY_PICKS = new Set(['movies', 'anime', 'demo', 'movie']);
const LEGACY_RULES = new Set(['cartoons', 'cartoon']);
const LEGACY_PRIORITY = new Set(['movies', 'movie', 'demo']);
const LEGACY_RANDOM = new Set(['anime']);

/** True when `raw` is already a product kind. */
export function isProductKind(raw: unknown): raw is ProductKind {
  const k = String(raw ?? '').trim().toLowerCase();
  return k === 'picks' || k === 'rules';
}

/**
 * Map any stored / requested kind (+ membership source) to the product kind.
 *
 * A rotation set whose kind is still `movies` (the rewatch Movies channel) is **rules**,
 * not picks — the old string named the shelf, not hand-picked membership. Pass `source`
 * so that case does not collapse into picks.
 */
export function normalizeProductKind(
  raw: unknown,
  source?: unknown,
): ProductKind {
  const k = String(raw ?? '').trim().toLowerCase();
  if (k === 'picks' || k === 'rules') return k;
  const src = String(source ?? '').trim().toLowerCase();
  if (src === 'rotation') {
    // Every rule-built set is rules, including the legacy `movies` rewatch channel.
    return 'rules';
  }
  if (LEGACY_RULES.has(k)) return 'rules';
  if (LEGACY_PICKS.has(k)) return 'picks';
  // Unknown / blank on a queue-shaped set: hand-picked is the historical default.
  if (src === 'queue' || src === '') return 'picks';
  return 'rules';
}

/**
 * Default lane for NEW entries on a Picks queue.
 *
 * Sparse on disk. When absent, infer from the (possibly legacy) kind so a not-yet-rewritten
 * `kind: movies` set keeps playing ordered and `kind: anime` keeps shuffling.
 */
export function normalizeAddAs(
  raw: unknown,
  opts: { kind?: unknown; source?: unknown } = {},
): AddAs {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'priority' || v === 'random') return v;
  const product = normalizeProductKind(opts.kind, opts.source);
  if (product !== 'picks') return 'random';
  const legacy = String(opts.kind ?? '').trim().toLowerCase();
  if (LEGACY_PRIORITY.has(legacy)) return 'priority';
  if (LEGACY_RANDOM.has(legacy)) return 'random';
  // Product `picks` with no add_as and no legacy cue → random (curated default).
  return 'random';
}

/** Does this set shuffle its membership (Random pool / curated path)? */
export function isRandomOrder(cfg: {
  kind?: unknown;
  source?: unknown;
  add_as?: unknown;
} | null | undefined): boolean {
  if (!cfg) return false;
  const source = String(cfg.source ?? '').trim().toLowerCase();
  // Rule pools have their own engines; this flag is the Picks curated shuffle.
  if (source === 'rotation') return false;
  return normalizeAddAs(cfg.add_as, { kind: cfg.kind, source: cfg.source }) === 'random';
}

/**
 * Kind string published on `queuepilot/cmd/session/start`.
 *
 * Always a product kind. For `set: auto` the caller still needs a SEPARATE signal
 * (`behavior: rewatch`) to pick the Movies channel — kind alone is `rules` either way.
 */
export function wireKindForSet(cfg: {
  kind?: unknown;
  source?: unknown;
} | null | undefined): ProductKind {
  return normalizeProductKind(cfg?.kind, cfg?.source);
}

/**
 * What to store when the editor / API creates or updates a set's kind.
 *
 * Accepts product kinds and the legacy create-UI values (`movies` = priority picks,
 * `anime` = random picks). Rotation creates always land on `rules`.
 */
export function kindForWrite(
  raw: unknown,
  source?: unknown,
): { kind: ProductKind; add_as?: AddAs } {
  const src = String(source ?? '').trim().toLowerCase();
  if (src === 'rotation') return { kind: 'rules' };
  const k = String(raw ?? '').trim().toLowerCase();
  if (k === 'rules') return { kind: 'rules' };
  if (k === 'picks') return { kind: 'picks' };
  if (k === 'anime') return { kind: 'picks', add_as: 'random' };
  if (k === 'movies' || k === 'movie' || k === 'demo') {
    return { kind: 'picks', add_as: 'priority' };
  }
  // Default create: priority picks (the old "＋ New queue" / movies path).
  return { kind: 'picks', add_as: 'priority' };
}

/**
 * Auto-routing discriminator: should `set:auto` land on a rewatch (Movies) channel?
 *
 * Prefer an explicit `behavior` / `mode` on the start payload. Fall back to the legacy
 * wire kind `movie` so an un-migrated HA button still works for one release.
 */
export function isAutoRewatch(opts: {
  kind?: unknown;
  behavior?: unknown;
  mode?: unknown;
}): boolean {
  const behavior = String(opts.behavior ?? opts.mode ?? '').trim().toLowerCase();
  if (behavior === 'rewatch') return true;
  if (behavior === 'progress' || behavior === 'episodic' || behavior === 'both') return false;
  return String(opts.kind ?? '').trim().toLowerCase() === 'movie';
}

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
  // No kind on disk used to mean movies (ordered) — see sets.normalize's old
  // `ent.kind || 'movies'` default and the synthetic bobq corpus. Explicit product
  // `picks` with no add_as means random (ADR curated default).
  if (!legacy) return 'priority';
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

// --------------------------------------------------------------------------- //
// The two LANES inside a Picks queue (decision 2026-08-23-kind-is-picks-or-rules §2)
// --------------------------------------------------------------------------- //

/** Which lane of a Picks queue one entry sits in. */
export type Placement = 'priority' | 'random';
/** Whether a Priority entry leads every sitting, or once per `promote_window`. */
export type Lead = 'once' | 'always';

/**
 * One entry's lane: its own `placement` when it has one, else the set's `add_as`.
 *
 * Sparse on disk, and deliberately so — a queue where every entry follows the set default
 * writes no `placement:` at all, which is every queue that existed before this shipped.
 */
export function normalizePlacement(raw: unknown, addAs: AddAs): Placement {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'priority' || v === 'random') return v;
  return addAs;
}

/** True when this entry NAMES its lane, rather than inheriting the set's. */
export function isExplicitPlacement(raw: unknown): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'priority' || v === 'random';
}

/**
 * How often a Priority entry may lead — and the default is the interesting part.
 *
 * The ADR's table says a sparse `lead` means `once`. Read literally that would break every
 * Ordered Queue in the house: those sets are `add_as: priority`, so EVERY entry is in the
 * Priority lane by inheritance, and a 24h window on each of them turns "play this list in
 * order" into "play a different entry each night". A show entry that contributes one episode
 * per sitting would yield to the entry below it before its second episode.
 *
 * So the default follows HOW THE ENTRY GOT INTO THE LANE:
 *
 *   * inherited (the set is `add_as: priority`) -> `always`, which is what an ordered queue
 *     has always done and what its owner means by "in order";
 *   * PROMOTED (the entry itself says `placement: priority`) -> `once`, which is what the
 *     owner asked promote for: "guaranteed first tonight, then not again until tomorrow".
 *
 * An explicit `lead:` on the entry outranks both.
 * (decision `2026-08-26-the-lead-window-belongs-to-a-promote-not-to-an-ordered-queue`)
 */
export function normalizeLead(raw: unknown, opts: { isPromoted: boolean }): Lead {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'once' || v === 'always') return v;
  return opts.isPromoted ? 'once' : 'always';
}

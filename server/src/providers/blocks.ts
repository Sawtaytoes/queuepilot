// Provider BLOCKS — the storage shape behind the queue editor's repeating
// "{provider, profile, libraries}" section.
//
// THE SHAPE IS A LIST FROM DAY ONE. Never a scalar provider, never provider identity encoded
// into library ids, never smuggled into `sections`. Getting this wrong turns the multi-block
// case into a migration instead of an additive change, which is the whole reason it is built
// this way before the UI that needs it.
//
// The owner's model, as it finally settled on 2026-08-13 (he revised it twice — Listbox, then
// "Combobox with multiselect", then this): the unit that repeats is THE WHOLE BLOCK — "Plays
// under profile" plus "Libraries this queue can search & hold" — not a picker inside it. A
// queue holds N blocks; each block is homogeneous; mixing falls out of composition rather
// than out of a multi-select control.
//
// ── What is deliberately NOT decided here ──────────────────────────────────────────────
// N blocks means one queue can span Plex AND Kavita, and that is a change to the SEAM, not a
// UI affordance: buckets() would run per block and merge before buildRotation interleaves,
// and materialize/handoff stop having one answer — a mixed queue is a push target and a pull
// URL at once. That semantics question is open and belongs to the owner, so this module
// STORES N blocks faithfully and refuses to guess: resolveSingle() throws on a mixed set
// rather than silently picking one. Do not "fix" that throw by choosing a winner.

import type { ProviderBlock } from '../types.js';

import { definitionFor } from './config.js';

/**
 * What this module needs off a set to derive its blocks — the intersection of every caller's
 * shape (`RoutingSetCfg`, the web `SetRegistryEntry`, and a raw YAML mapping straight off
 * disk). Declared here rather than in types.ts because it is a PARAMETER shape, not a domain
 * shape: `providers` is `unknown` because normalizeBlock() is the thing that decides what a
 * block is, and `sections` is `unknown` because a legacy set may carry numbers, strings, or a
 * bare scalar there.
 */
export interface BlockSourceCfg {
  providers?: unknown;
  requires_profile?: string | null;
  sections?: unknown;
  [field: string]: unknown;
}

/** The return of `validateBlocks()` — the editor's save gate. */
export interface BlockValidation {
  ok: boolean;
  errors: string[];
  blocks: ProviderBlock[];
}

/** The Plex-shaped legacy fields that a pre-blocks set expresses its one block through. */
const LEGACY_PLEX_PROVIDER = 'plex';

function normalizeLibraries(raw: unknown): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  // Library ids stay STRINGS and stay bare. A block already says which provider it belongs
  // to, so an id never needs a `plex:` / `kavita:` prefix — and must never grow one, or the
  // provider identity is encoded in two places that can disagree.
  return list
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function normalizeBlock(raw: unknown, { index = 0 }: { index?: number } = {}): ProviderBlock | null {
  if (raw == null) return null;
  // A bare string is shorthand for "this provider, no profile, no library filter".
  if (typeof raw === 'string') {
    return { provider: raw.trim(), profile: null, libraries: [] };
  }
  if (typeof raw !== 'object') return null;
  const block = raw as Record<string, unknown>;
  const provider = String(block.provider ?? '').trim();
  if (!provider) {
    console.log(`[providers] block #${index} names no provider — skipped`);
    return null;
  }
  return {
    provider,
    // `profile` is provider-SCOPED and means different things per provider: a Plex Home
    // profile the Shield switches to, versus which Kavita user owns the reading list. The
    // label, help text and option list must come from the provider, never be hardcoded.
    profile: block.profile == null || block.profile === '' ? null : String(block.profile),
    libraries: normalizeLibraries(block.libraries),
    ...(block.batch != null ? { batch: Number(block.batch) } : {}),
  };
}

/** `filter(Boolean)`'s typed twin — identical at runtime, since the only falsy value a
 *  normalizeBlock() list can hold is the `null` it returns for a rejected block. */
const isBlock = (b: ProviderBlock | null): b is ProviderBlock => b != null;

/**
 * Every provider block for a set, normalized.
 *
 * A set written before this existed has no `providers:` key. It is NOT migrated on read and
 * NOT rewritten on disk — it is INTERPRETED as exactly one Plex block, built from the fields
 * it already has (`sections` / `requires_profile`). That is what makes this additive: an
 * install that upgrades keeps playing without its config being touched.
 */
export function blocksForSet(cfg: BlockSourceCfg = {}): ProviderBlock[] {
  const raw = cfg.providers;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((b, i) => normalizeBlock(b, { index: i })).filter(isBlock);
  }
  return [{
    provider: LEGACY_PLEX_PROVIDER,
    profile: cfg.requires_profile ?? null,
    libraries: normalizeLibraries(cfg.sections),
    implicit: true,
  }];
}

/** True when a set draws from more than one distinct provider. */
export function isMixed(cfg: BlockSourceCfg = {}): boolean {
  const ids = new Set(blocksForSet(cfg).map((b) => b.provider));
  return ids.size > 1;
}

/**
 * The single provider serving this set.
 * @throws on a mixed set — see this module's header. The single-block path is expected to
 *   work end to end first; mixed-queue semantics is the owner's open decision.
 */
export function resolveSingle(cfg: BlockSourceCfg = {}): ProviderBlock {
  const blocks = blocksForSet(cfg);
  const ids = [...new Set(blocks.map((b) => b.provider))];
  if (ids.length > 1) {
    throw new Error(
      `this queue draws from ${ids.length} providers (${ids.join(', ')}), and what a mixed `
      + 'queue hands off — a push target or a pull URL — is an open decision. '
      + 'Split it into one queue per provider for now.',
    );
  }
  // BUG PRESERVED, NOT FIXED: a set whose `providers:` list is non-empty but whose every
  // entry fails normalizeBlock() (each one nameless) leaves `blocks` EMPTY, and this returns
  // `undefined` — the caller then throws a bare TypeError on `.provider` instead of the
  // named error above. Typing this as `ProviderBlock | undefined` would push the difference
  // onto providerIdForSet() and change what it throws, so the cast keeps runtime identical.
  return blocks[0] as ProviderBlock;
}

/** The provider id serving this set, for the single-provider path. */
export function providerIdForSet(cfg: BlockSourceCfg = {}): string {
  return resolveSingle(cfg).provider;
}

/**
 * Validate blocks on the way IN from the editor. Returns { ok, errors, blocks }.
 * Rejects unknown providers loudly rather than storing a block that can never resolve.
 */
export function validateBlocks(raw: unknown): BlockValidation {
  const errors: string[] = [];
  if (raw != null && !Array.isArray(raw)) {
    return { ok: false, errors: ['providers must be a list of blocks'], blocks: [] };
  }
  const blocks = ((raw || []) as unknown[])
    .map((b, i) => normalizeBlock(b, { index: i }))
    .filter(isBlock);
  blocks.forEach((b, i) => {
    if (!definitionFor(b.provider)) {
      errors.push(`block #${i + 1}: unknown provider '${b.provider}'`);
    }
  });
  // A queue draws from exactly ONE provider (decision
  // 2026-08-13-a-queue-draws-from-exactly-one-provider). Rejected on the way IN rather than
  // only at launch, because a stored mixed queue is not merely unplayable — it reports
  // `delivery: push` and then behaves as Plex everywhere, silently ignoring the other
  // provider's libraries. That is how the live "Manga & Webtoons" channel came to hold a
  // Kavita block that nothing ever read. Failing at save makes it visible immediately.
  const ids = [...new Set(blocks.map((b) => b.provider))];
  if (ids.length > 1) {
    errors.push(
      `a queue draws from one app, but these sources name ${ids.length} (${ids.join(', ')}) — `
      + 'split them into one queue per app',
    );
  }
  return { ok: errors.length === 0, errors, blocks };
}

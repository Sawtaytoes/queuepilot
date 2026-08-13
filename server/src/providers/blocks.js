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

import { definitionFor } from './config.js';

/** The Plex-shaped legacy fields that a pre-blocks set expresses its one block through. */
const LEGACY_PLEX_PROVIDER = 'plex';

function normalizeLibraries(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  // Library ids stay STRINGS and stay bare. A block already says which provider it belongs
  // to, so an id never needs a `plex:` / `kavita:` prefix — and must never grow one, or the
  // provider identity is encoded in two places that can disagree.
  return list
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function normalizeBlock(raw, { index = 0 } = {}) {
  if (raw == null) return null;
  // A bare string is shorthand for "this provider, no profile, no library filter".
  if (typeof raw === 'string') {
    return { provider: raw.trim(), profile: null, libraries: [] };
  }
  if (typeof raw !== 'object') return null;
  const provider = String(raw.provider ?? '').trim();
  if (!provider) {
    console.log(`[providers] block #${index} names no provider — skipped`);
    return null;
  }
  return {
    provider,
    // `profile` is provider-SCOPED and means different things per provider: a Plex Home
    // profile the Shield switches to, versus which Kavita user owns the reading list. The
    // label, help text and option list must come from the provider, never be hardcoded.
    profile: raw.profile == null || raw.profile === '' ? null : String(raw.profile),
    libraries: normalizeLibraries(raw.libraries),
    ...(raw.batch != null ? { batch: Number(raw.batch) } : {}),
  };
}

/**
 * Every provider block for a set, normalized.
 *
 * A set written before this existed has no `providers:` key. It is NOT migrated on read and
 * NOT rewritten on disk — it is INTERPRETED as exactly one Plex block, built from the fields
 * it already has (`sections` / `requires_profile`). That is what makes this additive: an
 * install that upgrades keeps playing without its config being touched.
 */
export function blocksForSet(cfg = {}) {
  const raw = cfg.providers;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((b, i) => normalizeBlock(b, { index: i })).filter(Boolean);
  }
  return [{
    provider: LEGACY_PLEX_PROVIDER,
    profile: cfg.requires_profile ?? null,
    libraries: normalizeLibraries(cfg.sections),
    implicit: true,
  }];
}

/** True when a set draws from more than one distinct provider. */
export function isMixed(cfg = {}) {
  const ids = new Set(blocksForSet(cfg).map((b) => b.provider));
  return ids.size > 1;
}

/**
 * The single provider serving this set.
 * @throws on a mixed set — see this module's header. The single-block path is expected to
 *   work end to end first; mixed-queue semantics is the owner's open decision.
 */
export function resolveSingle(cfg = {}) {
  const blocks = blocksForSet(cfg);
  const ids = [...new Set(blocks.map((b) => b.provider))];
  if (ids.length > 1) {
    throw new Error(
      `this queue draws from ${ids.length} providers (${ids.join(', ')}), and what a mixed `
      + 'queue hands off — a push target or a pull URL — is an open decision. '
      + 'Split it into one queue per provider for now.',
    );
  }
  return blocks[0];
}

/** The provider id serving this set, for the single-provider path. */
export function providerIdForSet(cfg = {}) {
  return resolveSingle(cfg).provider;
}

/**
 * Validate blocks on the way IN from the editor. Returns { ok, errors, blocks }.
 * Rejects unknown providers loudly rather than storing a block that can never resolve.
 */
export function validateBlocks(raw) {
  const errors = [];
  if (raw != null && !Array.isArray(raw)) {
    return { ok: false, errors: ['providers must be a list of blocks'], blocks: [] };
  }
  const blocks = (raw || []).map((b, i) => normalizeBlock(b, { index: i })).filter(Boolean);
  blocks.forEach((b, i) => {
    if (!definitionFor(b.provider)) {
      errors.push(`block #${i + 1}: unknown provider '${b.provider}'`);
    }
  });
  return { ok: errors.length === 0, errors, blocks };
}

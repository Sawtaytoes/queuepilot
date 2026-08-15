// D2 of the Python → Node port: the `set:"auto"` ROUTING read-side. A faithful port of the
// four pure-config functions in `queue_builder/config.py` — `binding_for` (:223),
// `channel_for` (:240), `set_sections` (:438), `rewatch_sections` (:443) — plus the subset of
// `_load_sets_yaml` normalization those four read. NO Plex, no MQTT: pure sets.yaml logic.
//
// Gated: the preview endpoint consults this only when ENGINE=node (default `python`, see
// env.js). It is dead-but-correct code behind the switch until D3 wires the selection engine
// onto it. `e2e/binding-parity.mjs` diffs every function against the Python oracle
// (`python -m queue_builder.cli route` + `… sections`) over `e2e/fixtures/routing.sets.yaml`,
// and CI runs that gate — so a drift from Python is a red build, not a wrong play on the TV.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { SEC_MOVIES } from '../env.js';
import { SETS_PATH } from '../sets.js';
import { setForProfile } from '../profiles.js';
import { errMessage, isNodeError } from '../errors.js';
import type {
  EngineBinding, MemberValue, RoutingQueueCfg, RoutingRegistry, RoutingRotationCfg, RoutingSetCfg,
  Start,
} from '../types.js';

/**
 * An UNTRUSTED binding source: a `profiles[]` item, a legacy set entry's top level, or (via
 * `bindingFor`'s fallback) a whole cfg. Every field is `unknown` because it comes straight off
 * hand-editable YAML, and the coercions below are the only thing that makes it a binding.
 * A type alias, not an interface, so a `RoutingSetCfg` can be passed without a double cast.
 */
type BindingSource = {
  plex_user?: unknown;
  account_id?: unknown;
  user_uuid?: unknown;
  allowed_ratings?: unknown;
  movie_ratings?: unknown;
  watch_count_accounts?: unknown;
  movie_excludes?: unknown;
};

/**
 * One raw `sets:` entry off the YAML. Every field is `unknown` for the same reason — this
 * loader's whole job is to turn it into a `RoutingSetCfg`.
 */
type RawSetEntry = BindingSource & {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  enabled?: unknown;
  mode?: unknown;
  behavior?: unknown;
  source?: unknown;
  sections?: unknown;
  item_sections?: unknown;
  profiles?: unknown;
  starts?: unknown;
  weights?: unknown;
  blocklist?: unknown;
  members?: unknown;
  superseded_by?: unknown;
  reel?: unknown;
  keep_completed?: unknown;
  requires_profile?: unknown;
  remove_completed_after?: unknown;
  include_specials?: unknown;
  batch_stops_at?: unknown;
  episodes?: unknown;
  audio_language?: unknown;
  max_items?: unknown;
  providers?: unknown;
};

/**
 * The cfg while it is still being built: the branch-specific literal is assembled first and the
 * six fields every set shares are stamped on afterwards, exactly as the JS did — so those six
 * are optional here and required on `RoutingSetCfg`.
 */
type LateCommon = 'label' | 'kind' | 'enabled' | 'mode' | 'behavior' | 'max_items';
type Draft<T extends Record<LateCommon, unknown>> = Omit<T, LateCommon> & Partial<Pick<T, LateCommon>>;
type SetCfgDraft = Draft<RoutingQueueCfg> | Draft<RoutingRotationCfg>;

// Python does `int(s)` on section ids; a non-int would raise there. yaml already gives us
// numbers, so this is a no-op for well-formed data and just coerces numeric strings.
//
// NOTE the fallback: a non-numeric value is returned UNCHANGED, not dropped and not NaN — that
// non-uniformity is Python parity and must stay. It is DECLARED `number` because every consumer
// (section ids, watch-count accounts) treats it as one; the declaration is the same assumption
// the untyped original made silently, and the cast is where it is now written down.
const toInt = (v: unknown): number => {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : (v as number);
};

// Port of config._binding_from: normalize one profile binding out of a dict (a legacy
// top-level set entry OR a profiles[] item), with the SAME coercions the Python reader uses
// so a synthesized legacy binding is equivalent to what a single-binding set produced.
function bindingFrom(src: BindingSource = {}): EngineBinding {
  // `v as unknown[]` and not `Array.isArray(v)`: a scalar where the YAML wanted a list still
  // throws on `.map`, as it always did. A guard here would silently read it as "no cap".
  const ratingSet = (v: unknown): Set<string> | null => {
    const list = v as unknown[] | null | undefined;
    return list && list.length ? new Set(list.map(String)) : null;
  };
  const wca = ((src.watch_count_accounts as unknown[] | null | undefined) || []).map((a) => toInt(a));
  return {
    plex_user: (src.plex_user ?? null) as string | null,
    account_id: (src.account_id ?? null) as number | null,
    user_uuid: (src.user_uuid ?? null) as string | null,
    allowed_ratings: ratingSet(src.allowed_ratings),
    movie_ratings: ratingSet(src.movie_ratings),
    watch_count_accounts: wca.length ? wca : null,
    movie_excludes: ((src.movie_excludes as unknown[] | null | undefined) || []).map(String),
  };
}

// Port of the routing-relevant slice of config._load_sets_yaml: parse sets.yaml into
// { sets: {id: cfg}, order: [id…] }, or null to keep defaults (file absent / unreadable /
// empty) — matching the Python "keep current sets" behavior. Only the fields the four
// functions read are carried; the write side stays in sets.js.
export function loadSets(path: string = SETS_PATH): RoutingRegistry | null {
  let data: { sets?: unknown };
  try {
    data = (parse(readFileSync(path, 'utf8')) as { sets?: unknown } | null) || {};
  } catch (e) {
    if (isNodeError(e) && e.code === 'ENOENT') return null; // FileNotFoundError → defaults
    console.log(`[routing] ${path} unreadable (${errMessage(e)}); keeping current sets`);
    return null;
  }
  const entries: unknown[] = Array.isArray(data.sets) ? data.sets : [];
  const sets: Record<string, RoutingSetCfg> = {};
  const order: string[] = [];
  for (const rawEnt of entries) {
    if (!rawEnt || typeof rawEnt !== 'object' || Array.isArray(rawEnt)) continue;
    const ent = rawEnt as RawSetEntry;
    const sid = String(ent.id ?? '').trim();
    if (!sid) continue;
    const sections = ((ent.sections as unknown[] | null | undefined) || []).map(toInt);
    let cfg: SetCfgDraft;
    if (ent.source === 'rotation') {
      // A channel carries a `profiles` list of per-profile bindings. Absent (every legacy
      // set) → synthesize ONE binding from the top-level fields. A "real" profiles[] array
      // (≥1 dict) is what has_explicit_profiles gates channel_for on.
      const raw = ent.profiles;
      const isBinding = (p: unknown): boolean => Boolean(p) && typeof p === 'object' && !Array.isArray(p);
      const hasExplicitProfiles = Array.isArray(raw) && raw.some(isBinding);
      const profiles = hasExplicitProfiles
        ? (raw as unknown[]).filter(isBinding).map((p) => bindingFrom(p as BindingSource))
        : [bindingFrom(ent)];
      // Non-null: `hasExplicitProfiles` is true only when at least one item passed isBinding,
      // and the else-branch synthesizes exactly one. Never empty.
      const def = profiles[0]!;
      cfg = {
        source: 'rotation',
        episodic_sections: sections,
        item_sections: ((ent.item_sections as unknown[] | null | undefined) || []).map(toInt),
        // Carried for the D3 selection engine (unused by the D2 routing fns): per-show manual
        // start floors { ratingKey: {season, episode} } and the blocklist (ratingKeys or
        // "Collection: <name>" strings).
        starts: (ent.starts && typeof ent.starts === 'object' ? ent.starts : {}) as Record<string, Start>,
        // Per-show WEIGHT for the dynamic rule pool: { ratingKey: n } (and `section-<id>` for a
        // whole item bucket). The mirror of a curated entry's embedded `weight`, but for a
        // rule-derived show that has no stored entry to hang one on — same shape as `starts`.
        // rotation.js turns it into slots per round; absent/1 = the plain round-robin.
        weights: (ent.weights && typeof ent.weights === 'object' ? ent.weights : {}) as Record<string, number>,
        blocklist: ((ent.blocklist as unknown[] | null | undefined) || []).map(String),
        // Explicit curated members (v3 PR 3): raw queues.yaml-style entries (a bare ratingKey, a
        // "Collection: <name>" string, or a {ratingKey,title,episodes} mapping — describe() parses
        // them). Non-empty => the channel's pool is these members PLUS the dynamic rule (additive);
        // [] / absent => the pure rule pool. Consumed by engine/rotation.js channelBuckets.
        members: (Array.isArray(ent.members) ? ent.members : []) as MemberValue[],
        profiles,
        has_explicit_profiles: hasExplicitProfiles,
        superseded_by: ent.superseded_by ? String(ent.superseded_by) : null,
        // Top-level mirror of the default binding (back-compat; binding_for falls back to it).
        allowed_ratings: def.allowed_ratings,
        movie_ratings: def.movie_ratings,
        watch_count_accounts: def.watch_count_accounts,
        plex_user: def.plex_user,
        account_id: def.account_id,
        user_uuid: def.user_uuid,
      };
    } else {
      // Port of _queue_set (routing-relevant fields): a curated queue draws from its own
      // sections; set_sections covers them and rewatch_sections falls to SEC_MOVIES. The
      // curated resolver (engine/resolve.js) reads these + the queue_sections mirror.
      const secs = sections.length ? sections : [SEC_MOVIES];
      cfg = {
        source: 'queue',
        episodic_sections: secs,
        item_sections: [],
        // Python _queue_set mirrors the sections onto queue_sections/queue_section (entries are
        // resolved/scoped against them); resolve.js reads queue_sections first, else set_sections.
        queue_sections: secs,
        queue_section: secs[0],
        watch_count_accounts: [1],
        plex_user: 'Bob (admin)',
        account_id: 1,
        user_uuid: null,
        allowed_ratings: null,
        movie_ratings: null,
        movie_excludes: [],
        // A REEL replays in full every scan (build_reel); keep_completed marks a non-consuming
        // queue. reel implies keep_completed. Both gate next_queue's D4 mark-done persistence.
        reel: Boolean(ent.reel),
        keep_completed: Boolean(ent.keep_completed || ent.reel),
      };
    }
    cfg.label = (ent.label || sid) as string;
    cfg.kind = (ent.kind ?? null) as string | null;
    cfg.enabled = (ent.enabled ?? true) as boolean; // Python: ent.get("enabled", True)
    cfg.mode = (ent.mode ?? null) as string | null;
    cfg.behavior = (ent.behavior ?? null) as string | null;
    // --- config.py passthroughs. These are READ by session.js / resolve.js / playback.js,
    // so a field the builder forgets is not a missing feature, it is a SILENTLY DISABLED
    // one — `cfg.requires_profile` simply read undefined and every gated set played
    // ungated. Mirror config.py's truthiness exactly; only set what Python sets.
    //
    // A set whose libraries only SOME Plex Home profiles can see. The driver blocks until
    // the Shield is signed into this profile, so a scan on the wrong one waits for the
    // switch instead of firing playMedia at a Plex that is sitting on the user picker.
    if (ent.requires_profile) cfg.requires_profile = String(ent.requires_profile);
    // §B.3 TTL auto-removal of completed entries; queues.sweepCompleted interprets it.
    if (ent.remove_completed_after != null) {
      cfg.remove_completed_after = String(ent.remove_completed_after).trim();
    }
    if (ent.include_specials) cfg.include_specials = true;
    // Where a multi-episode batch may stop: "none" | "member" | "season". resolve.js's batchStop
    // interprets it (entry override > set > env BATCH_STOPS_AT).
    if (ent.batch_stops_at != null) {
      cfg.batch_stops_at = String(ent.batch_stops_at).trim().toLowerCase();
    }
    // How many items one entry contributes per visit, when the entry says nothing. The COUNT
    // to `batch_stops_at`'s WHERE, and the same entry > set > env precedence: resolve.js's
    // setBatch() interprets it for Plex, providers/launcher.js for a pull provider.
    if (ent.episodes != null) cfg.episodes = String(ent.episodes).trim();
    // Playback selects this audio stream on queued items (e.g. "jpn" for anime).
    if (ent.audio_language) cfg.audio_language = String(ent.audio_language).trim();
    // Per-scan session cap; absent/<=0/non-numeric => no cap. Python coerces via int().
    // `String(...)` only spells out the ToString `parseInt` already performs on its argument.
    const maxItems = parseInt(String(ent.max_items), 10);
    cfg.max_items = Number.isFinite(maxItems) && maxItems > 0 ? maxItems : null;
    // Provider blocks — the repeating {provider, profile, libraries} unit. Carried through
    // VERBATIM and left uninterpreted here: providers/blocks.js owns normalization, and this
    // loader must not acquire an opinion about a second backend. Absent is the normal case
    // and is NOT defaulted to a Plex block here — blocksForSet() interprets absence, so a
    // legacy set is never rewritten on disk just because it was read.
    if (Array.isArray(ent.providers) && ent.providers.length) cfg.providers = ent.providers;
    // The six LateCommon fields are all assigned above, so the draft is complete here.
    sets[sid] = cfg as RoutingSetCfg;
    order.push(sid);
  }
  if (!order.length) return null;
  return { sets, order };
}

// Port of config.binding_for: the active profile binding for a set — the one whose plex_user
// matches `profileTitle`, else the first (default) binding; a cfg with no `profiles` (built-in
// SETS / ultra-legacy) synthesizes from the top level.
export function bindingFor(
  cfg: RoutingSetCfg | BindingSource | null | undefined,
  profileTitle: string | null = null,
): EngineBinding {
  // Read through a cast: `profiles` exists only on the rotation branch (and not at all on the
  // built-in/ultra-legacy shapes this deliberately still accepts).
  const profiles = cfg && (cfg as { profiles?: EngineBinding[] }).profiles;
  if (!profiles || !profiles.length) return bindingFrom(cfg || {});
  if (profileTitle) {
    for (const b of profiles) if (b.plex_user === profileTitle) return b;
  }
  return profiles[0]!; // non-empty per the guard above
}

// Port of config.channel_for: route a set:"auto" scan (card kind + detected profile) to a
// function-channel id, or null to fall back to PROFILE_SET_MAP. Only a channel that EXPLICITLY
// binds the profile qualifies (has_explicit_profiles + exact plex_user match), is enabled and
// not superseded, and whose rewatch-ness matches the kind. First match in file order wins.
export function channelFor(
  kind: string | null | undefined,
  profileTitle: string | null | undefined,
  reg: RoutingRegistry,
): string | null {
  const isMovieKind = kind === 'movie';
  for (const sid of reg.order) {
    // `!cfg` replaces the original `|| {}`: an id in `order` with no entry in `sets` failed the
    // `source !== 'rotation'` test there and is skipped here — same walk, same result.
    const cfg = reg.sets[sid];
    if (!cfg || cfg.source !== 'rotation' || !cfg.enabled) continue;
    if (!cfg.has_explicit_profiles || cfg.superseded_by) continue;
    const isRewatch = (cfg.behavior || cfg.mode) === 'rewatch';
    if (isRewatch !== isMovieKind) continue;
    for (const b of cfg.profiles || []) if (b.plex_user === profileTitle) return sid;
  }
  return null;
}

/**
 * The section-bearing slice of a cfg. Looser than `RoutingSetCfg` on purpose: `setSections` is
 * also handed the built-in/ultra-legacy shapes, and both fields are read defensively.
 */
type SectionSource = {
  episodic_sections?: readonly number[] | null;
  item_sections?: readonly number[] | null;
};

// Port of config.set_sections: all library sections a set draws from (episodic + item).
export function setSections(cfg: SectionSource): number[] {
  return [...(cfg.episodic_sections || []), ...(cfg.item_sections || [])];
}

// Port of config.rewatch_sections: a behavior:rewatch channel pools from ITS OWN libraries
// (movie libs in item_sections, show libs in episodic_sections), deduped, item-first; empty
// → [SEC_MOVIES]. A non-rewatch set → [SEC_MOVIES] (its movie card stays on the Movies lib).
export function rewatchSections(
  cfg: SectionSource & { behavior?: string | null; mode?: string | null },
): number[] {
  if ((cfg.behavior || cfg.mode) !== 'rewatch') return [SEC_MOVIES];
  const secs = [
    ...new Set([
      ...(cfg.item_sections || []).map(toInt),
      ...(cfg.episodic_sections || []).map(toInt),
    ]),
  ];
  return secs.length ? secs : [SEC_MOVIES];
}

/** What `forSet()` hands the preview endpoint. Local: it is this function's own payload shape. */
export interface ForSetResult {
  via: 'engine-node';
  sid: string;
  binding: { plex_user: string | null; account_id: number | null };
  set_sections: number[];
  rewatch_sections: number[];
}

/**
 * What `route()` hands the caller. Local for the same reason — and note the two section lists
 * are ABSENT (not null) on the three early-return paths, exactly as the JS returned them.
 */
export interface RouteResult {
  sid: string | null;
  via: string | null;
  binding: EngineBinding | null;
  set_sections?: number[];
  rewatch_sections?: number[];
}

// The preview-endpoint consumer (D2 seam): the binding + section pools a KNOWN set resolves to
// under a profile — what D3's selection engine will pool from. Distinct from route(), which
// resolves an unknown set:"auto" scan. Returns null for an unknown / non-rotation id.
export function forSet(
  sid: string,
  profileTitle: string | null = '',
  reg: RoutingRegistry | null = loadSets(),
): ForSetResult | null {
  const cfg = reg && reg.sets[sid];
  if (!cfg || cfg.source !== 'rotation') return null;
  const b = bindingFor(cfg, profileTitle || null);
  return {
    via: 'engine-node',
    sid,
    binding: { plex_user: b.plex_user ?? null, account_id: b.account_id ?? null },
    set_sections: setSections(cfg),
    rewatch_sections: rewatchSections(cfg),
  };
}

// Port of cli._route's decision: (card kind + profile title) → { sid, via, binding, sections }.
// `via` is 'channel_for' when an explicit channel captured it, else 'PROFILE_SET_MAP' (the
// legacy tier map), else null when nothing maps (an unbound profile still errors, as today).
export function route(
  kind: string | null | undefined,
  profileTitle: string | null | undefined,
  reg: RoutingRegistry | null = loadSets(),
): RouteResult {
  if (!reg) return { sid: null, via: null, binding: null };
  let sid = channelFor(kind, profileTitle, reg);
  let via = 'channel_for';
  if (sid == null) {
    // Cast, not a guard: `setForProfile` is a plain map lookup, and a null/absent title has
    // always simply missed it (returning null) rather than being special-cased here.
    sid = setForProfile(profileTitle as string);
    via = 'PROFILE_SET_MAP';
  }
  if (sid == null) return { sid: null, via: null, binding: null };
  const cfg = reg.sets[sid];
  if (!cfg) return { sid, via, binding: null }; // PROFILE_SET_MAP named a set not in the registry
  return {
    sid,
    via,
    binding: bindingFor(cfg, profileTitle),
    set_sections: setSections(cfg),
    rewatch_sections: rewatchSections(cfg),
  };
}

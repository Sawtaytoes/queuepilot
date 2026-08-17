// QueuePilot GROUPS — our own identity layer, mapped onto provider accounts.
//
// ── Why "group" and not "profile" ────────────────────────────────────────────────────────
// Because PROFILE is already taken, by Plex, throughout this app: `profiles.ts` next door
// answers "which Plex Home profile is signed into the Shield right now" off the PMS debug
// log, `/api/profiles` serves the Plex Home list, and the pool editor's second control is
// literally labelled Profile. A household concept sharing that word would have put two
// different "Profile" pickers on adjacent screens — which is the exact class of confusion
// this feature exists to remove. So: a GROUP is ours ("Bob", "Bob & Alice", "Kids",
// "Demo"), a profile stays Plex's, and the two are related exactly once — a group may LIST
// the provider accounts it corresponds to. That relationship is why this file exists.
//
// ── Why an indirection at all ────────────────────────────────────────────────────────────
// The backends do not agree about who anyone is. Plex knows `sawtaytoes`; Kavita knows
// `Bob`. Board Game Picker knows neither. With nothing in between there is no object to
// hang "show me all of Bob's stuff" on, which is the thing the owner actually asked for.
// The mapping is deliberately N-to-M: Carol is two Plex accounts (Older Kids, Younger Kids)
// and one Kavita user; Alice is one Kavita user and no Plex account of her own.
//
// ── How a set lands in a profile ─────────────────────────────────────────────────────────
// Two rules, in this order, and the ORDER is the interesting part:
//
//   1. EXPLICIT — the profile lists the set id in `sets:`.
//   2. DERIVED  — only for a set NO profile listed: the profile's `accounts:` contain the
//      account that set plays as.
//
// Derivation is the fallback rather than the primary rule because the owner's curated
// queues are almost all gated to `sawtaytoes`: `Bob — Anime`, `Bob & Alice — Anime` and
// `Family — Anime` all play as him. Account-first would therefore sweep every one of them
// into "Bob" and the audience distinction — which is the entire point of the feature —
// would vanish. Explicit-first means naming a set once moves it, and everything nobody named
// still lands somewhere sensible instead of falling off the list.
//
// A set may belong to MANY profiles, and a profile with neither `accounts:` nor `sets:` is
// legal (it is just empty). Nothing here can hide a set from the app: the `all` pseudo-
// profile is synthesized below and is not user-editable.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isSeq, parse, parseDocument, stringify } from 'yaml';
import type { Document, YAMLSeq } from 'yaml';

import type { SetRegistryEntry } from './types.js';

import { isNodeError, errMessage } from './errors.js';
import { GROUPS_PATH } from './env.js';

/** The provider accounts one group stands for, keyed by provider KIND. */
export type ProfileAccounts = Record<string, string[]>;

/** One group as it is stored and as it is served. */
export interface Group {
  /**
   * IMMUTABLE — this is the URL (`/g/<id>`), so it is bookmarkable and therefore a promise.
   * Same rule `sets.yaml` learned: ids never change, labels are free.
   */
  id: string;
  label: string;
  /** Provider kind -> account names. Absent/empty = membership by `sets` alone. */
  accounts: ProfileAccounts;
  /** Set ids this group claims outright. */
  sets: string[];
}

/** A group plus the membership this build resolved for it — what `/api/groups` serves. */
export interface ResolvedGroup extends Group {
  /** Every set id in this group, registry order. */
  setIds: string[];
  /** Provider kinds represented in `setIds`, so the UI can offer only the chips that apply. */
  providerKinds: string[];
  /**
   * True for the synthesized `all` entry. The UI pins it first and the editor must refuse
   * to delete it; it exists so nothing this file says can make a set unreachable.
   */
  isAll?: boolean;
}

/** The id of the pseudo-group that holds everything. Not stored, never editable. */
export const ALL_ID = 'all';

// --- reading ------------------------------------------------------------------ //

function readYaml(): Record<string, unknown> {
  try {
    return (parse(fs.readFileSync(GROUPS_PATH, 'utf8')) as Record<string, unknown> | null) || {};
  } catch (e) {
    // Missing is the normal cold-start case — `seedIfMissing()` handles it. Anything else
    // is worth a line but must never crash boot: this process also serves the web UI, and
    // losing the whole app to a stray comma in an OPTIONAL config file is the worse failure.
    if (!isNodeError(e) || e.code !== 'ENOENT') {
      console.log(`[groups] could not read ${GROUPS_PATH}: ${errMessage(e)}`);
    }
    return {};
  }
}

/** Lower-cased and trimmed. Account names are matched case-insensitively because
 * `sawtaytoes` (plex.tv username) and `Bob` (Kavita display name) are typed by hand into
 * a YAML file, and a capital letter is not a different person. */
const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

function normalizeAccounts(raw: unknown): ProfileAccounts {
  if (!raw || typeof raw !== 'object') return {};
  const out: ProfileAccounts = {};
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    const list = (Array.isArray(value) ? value : [value])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    if (list.length) out[String(kind).trim().toLowerCase()] = list;
  }
  return out;
}

function normalizeGroup(raw: unknown, index: number): Group | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = String(p.id ?? '').trim();
  if (!id) {
    console.log(`[groups] entry #${index} has no id — skipped`);
    return null;
  }
  if (id === ALL_ID) {
    // `all` is synthesized. A stored one would either shadow it or be shadowed by it, and
    // both are confusing in a way no error message would fix later.
    console.log(`[groups] '${ALL_ID}' is reserved (the built-in everything view) — skipped`);
    return null;
  }
  return {
    id,
    label: String(p.label ?? id).trim() || id,
    accounts: normalizeAccounts(p.accounts),
    sets: (Array.isArray(p.sets) ? p.sets : []).map((s) => String(s ?? '').trim()).filter(Boolean),
  };
}

/** The stored groups, file order. Empty when the file is absent or unreadable. */
export function storedGroups(): Group[] {
  const doc = readYaml();
  const listed: unknown[] = Array.isArray(doc.groups) ? doc.groups : [];
  const byId = new Map<string, Group>();
  listed.forEach((raw, i) => {
    const p = normalizeGroup(raw, i);
    if (p) byId.set(p.id, p); // a duplicate id is a later entry replacing an earlier one
  });
  return [...byId.values()];
}

// --- membership --------------------------------------------------------------- //

/**
 * The provider accounts a SET plays as, keyed by provider kind.
 *
 * Three sources, because three generations of this file's schema are live at once and all
 * three are legitimate:
 *   - a rotation pool's `profiles[]` bindings (`plex_user`),
 *   - a curated queue's `requires_profile` — which is who it plays as, not merely a gate
 *     (decision 2026-08-16-a-curated-queue-plays-as-the-profile-it-is-gated-to),
 *   - a provider block's own `profile`, which is how a non-Plex backend names its user.
 *
 * Returns `{}` for a set that names nobody — Manga & Webtoons is exactly that today — which
 * is precisely the case explicit `sets:` membership exists to cover.
 */
export function accountsForSet(set: SetRegistryEntry): ProfileAccounts {
  const out: ProfileAccounts = {};
  const add = (kind: string, name: unknown) => {
    const value = String(name ?? '').trim();
    if (!value) return;
    const k = String(kind).trim().toLowerCase();
    if (!out[k]) out[k] = [];
    if (!out[k].some((existing) => norm(existing) === norm(value))) out[k].push(value);
  };

  if (set.source === 'rotation') {
    for (const binding of set.profiles || []) add('plex', binding.plex_user);
  }
  add('plex', set.requires_profile);
  for (const block of set.providers || []) {
    // The block knows its provider ID; the KIND is what everything else is keyed on, and
    // the set already carries the resolved kind for its (single) provider.
    if (block.profile) add(set.provider_kind || block.provider, block.profile);
  }
  // A set whose only Plex account came from `requires_profile` on a NON-Plex queue is not a
  // Plex account at all — a reading queue's gate names whoever the reading list belongs to.
  if (set.provider_kind && set.provider_kind !== 'plex' && out.plex && !(set.source === 'rotation')) {
    out[set.provider_kind] = [...(out[set.provider_kind] || []), ...out.plex];
    delete out.plex;
  }
  return out;
}

/**
 * A legacy tier kept readable during the migration soak. Only a rotation set can carry it,
 * so this is a narrowing rather than a field read — `superseded_by` is not on `QueueSet` and
 * TypeScript is right to say so.
 */
const isSuperseded = (set: SetRegistryEntry): boolean => (
  set.source === 'rotation' && Boolean(set.superseded_by)
);

const claimsAccount = (group: Group, setAccounts: ProfileAccounts): boolean => (
  Object.entries(setAccounts).some(([kind, names]) => (
    (group.accounts[kind] || []).some((mine) => names.some((theirs) => norm(mine) === norm(theirs)))
  ))
);

/**
 * Resolve every group's membership against the registry, plus the `all` pseudo-group.
 *
 * `sets` is the registry in FILE order, so each group's `setIds` comes out in the same order
 * the landing already renders — a group page is the landing filtered, never re-sorted.
 */
export function resolveGroups(sets: SetRegistryEntry[]): ResolvedGroup[] {
  const groups = storedGroups();
  const visible = sets.filter((s) => !isSuperseded(s));

  // Pass 1: explicit claims. A set named by ANY group is settled and never derives —
  // otherwise naming `Bob & Alice — Anime` under its audience would still leave it in
  // Bob, and moving a set would be impossible without editing accounts.
  const claimed = new Set<string>();
  for (const g of groups) for (const id of g.sets) claimed.add(id);

  const kindsOf = (ids: string[]) => [
    ...new Set(ids.map((id) => visible.find((s) => s.id === id)?.provider_kind).filter((k): k is string => Boolean(k))),
  ];

  const resolved: ResolvedGroup[] = groups.map((g) => {
    const wanted = new Set(g.sets);
    const setIds = visible
      .filter((s) => wanted.has(s.id) || (!claimed.has(s.id) && claimsAccount(g, accountsForSet(s))))
      .map((s) => s.id);
    return { ...g, providerKinds: kindsOf(setIds), setIds };
  });

  const everything = visible.map((s) => s.id);

  return [
    {
      accounts: {},
      id: ALL_ID,
      isAll: true,
      label: 'All',
      providerKinds: kindsOf(everything),
      setIds: everything,
      sets: [],
    },
    ...resolved,
  ];
}

/** Set ids belonging to no group at all — the "you have not filed this yet" list. */
export function unassignedSetIds(sets: SetRegistryEntry[]): string[] {
  const resolved = resolveGroups(sets).filter((g) => !g.isAll);
  const filed = new Set(resolved.flatMap((g) => g.setIds));
  return sets.filter((s) => !isSuperseded(s) && !filed.has(s.id)).map((s) => s.id);
}

// --- seeding ------------------------------------------------------------------ //

const SEED_HEADER = `# QueuePilot groups — who is watching, and what is theirs.
#
# A group is what you pick at the top of the app; its id is its URL (/g/<id>), so ids are
# IMMUTABLE and labels are free — rename a label whenever, never change an id.
#
# NOT a Plex profile. Plex's profiles are the accounts on the Shield; a group is ours, and
# may be a person (Bob), an audience (Bob & Alice) or neither (Demo).
#
# Membership, in order:
#   1. sets:      this group claims these set ids outright.
#   2. accounts:  provider kind -> account names. Used ONLY for a set no group listed —
#                 so a set you file by hand stays where you filed it.
#
# accounts is also the identity map: Plex calls Bob 'sawtaytoes', Kavita calls him 'Bob'.
# A group with no accounts is membership by hand (Bob & Alice); a set can be in several.
# 'all' is built in and cannot be defined here.
`;

/**
 * Write a starter `groups.yaml` derived from the registry, if none exists.
 *
 * One group per distinct provider account, which is the only grouping that can be inferred
 * without guessing at households. It is deliberately a WEAK default: the interesting groups
 * are audiences ("Bob & Alice"), and no file on disk says who watches with whom. The seed
 * exists so a fresh install has a working picker on first paint, not so nobody ever edits it.
 */
export async function seedIfMissing(sets: SetRegistryEntry[]): Promise<boolean> {
  try {
    await fsp.access(GROUPS_PATH);
    return false;
  } catch {
    /* absent — seed below */
  }

  const seen = new Map<string, { kind: string; name: string }>();
  for (const s of sets) {
    if (isSuperseded(s)) continue;
    for (const [kind, names] of Object.entries(accountsForSet(s))) {
      for (const name of names) {
        const key = `${kind}:${norm(name)}`;
        if (!seen.has(key)) seen.set(key, { kind, name });
      }
    }
  }

  const groups = [...seen.values()].map(({ kind, name }) => ({
    id: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    label: name,
    accounts: { [kind]: [name] },
  }));

  try {
    await fsp.mkdir(path.dirname(GROUPS_PATH), { recursive: true });
    // `wx`: another process (or another worker) may have won the race between the access()
    // above and here, and its file is as good as ours. Losing is not an error.
    await fsp.writeFile(GROUPS_PATH, `${SEED_HEADER}\n${stringify({ groups })}`, { flag: 'wx' });
    console.log(`[groups] seeded ${GROUPS_PATH} with ${groups.length} group(s) from the registry`);
    return true;
  } catch (e) {
    if (isNodeError(e) && e.code === 'EEXIST') return false;
    console.log(`[groups] could not seed ${GROUPS_PATH}: ${errMessage(e)}`);
    return false;
  }
}

export const GROUPS_FILE = GROUPS_PATH;

// --- writing ------------------------------------------------------------------ //
//
// The editor writes through the DOCUMENT api, not `stringify(readYaml())`, for the same
// reason `sets.ts` does: this file is hand-edited over SMB as often as it is saved from the
// app, and a round-trip that drops the header comment (or the `# ── People ──` dividers
// someone wrote) silently punishes the person who wrote them. Every mutation below edits
// nodes in place and leaves everything it did not touch — comments, blank lines, key order —
// exactly as it found it.

/** Turn a label into a URL-safe id. Ids are IMMUTABLE once created, so this runs on create
 * only — a rename never touches it, which is the contract every bookmark depends on. */
export function slugify(label: string): string {
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function readDoc(): Promise<Document> {
  let text = '';
  try {
    text = await fsp.readFile(GROUPS_PATH, 'utf8');
  } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') throw e;
    text = `${SEED_HEADER}\ngroups: []\n`;
  }
  const doc = parseDocument(text);
  if (!isSeq(doc.get('groups'))) doc.set('groups', doc.createNode([]));
  return doc;
}

function groupsSeq(doc: Document): YAMLSeq {
  const seq = doc.get('groups');
  if (!isSeq(seq)) throw new Error('groups.yaml has no groups list');
  return seq;
}

async function writeDoc(doc: Document): Promise<void> {
  // `indentSeq: false` + `lineWidth: 0` match sets.yaml's shape, so the two config files in
  // the same directory do not disagree about how a list looks.
  const text = doc.toString({ indentSeq: false, lineWidth: 0 });
  const tmp = `${GROUPS_PATH}.tmp`;
  await fsp.mkdir(path.dirname(GROUPS_PATH), { recursive: true });
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, GROUPS_PATH);
  } catch {
    // Same fallback sets.ts keeps: a rename across a bind-mount boundary can fail where a
    // plain write succeeds. Losing atomicity beats losing the save.
    await fsp.writeFile(GROUPS_PATH, text, 'utf8');
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Locate one group's mapping node by id. */
function nodeFor(doc: Document, id: string): { seq: YAMLSeq; index: number } {
  const seq = groupsSeq(doc);
  const index = seq.items.findIndex((item) => {
    const node = item as { get?: (k: string) => unknown } | null;
    return Boolean(node?.get) && String(node?.get?.('id') ?? '') === id;
  });
  if (index < 0) throw new Error(`no such group '${id}'`);
  return { seq, index };
}

/** The write projection of `accounts:` — empty kinds dropped rather than written as `[]`. */
function writableAccounts(accounts: ProfileAccounts): ProfileAccounts | null {
  const out: ProfileAccounts = {};
  for (const [kind, names] of Object.entries(accounts || {})) {
    const list = (names || []).map((n) => String(n).trim()).filter(Boolean);
    if (list.length) out[kind] = list;
  }
  return Object.keys(out).length ? out : null;
}

export interface GroupWrite {
  label?: string;
  accounts?: ProfileAccounts;
  sets?: string[];
}

/** Create a group. Returns its generated (immutable) id. */
export async function createGroup(body: GroupWrite): Promise<{ ok: true; id: string }> {
  const label = String(body.label ?? '').trim();
  if (!label) throw new Error('a group needs a label');

  const base = slugify(label);
  if (!base) throw new Error(`'${label}' has no letters or digits to make an id from`);
  if (base === ALL_ID) throw new Error(`'${ALL_ID}' is reserved for the built-in everything view`);

  const doc = await readDoc();
  const taken = new Set(storedGroups().map((g) => g.id));
  // Two groups may legitimately want the same label ("Movies" twice is the user's business),
  // so the ID de-duplicates rather than the save failing. `-2`, not a random suffix: it is
  // going in a URL a person reads.
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;

  const entry: Record<string, unknown> = { id, label };
  const accounts = writableAccounts(body.accounts ?? {});
  if (accounts) entry.accounts = accounts;
  const sets = (body.sets ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (sets.length) entry.sets = sets;

  groupsSeq(doc).add(doc.createNode(entry));
  await writeDoc(doc);
  return { ok: true, id };
}

/**
 * Edit one group. `id` is never writable — see `slugify`'s note. A field absent from the
 * body is LEFT ALONE rather than cleared, so the editor can PATCH one thing at a time; an
 * explicitly empty `sets: []` or `accounts: {}` does clear.
 */
export async function updateGroup(id: string, body: GroupWrite): Promise<{ ok: true; id: string }> {
  const doc = await readDoc();
  const { seq, index } = nodeFor(doc, id);
  const node = seq.get(index) as { set: (k: string, v: unknown) => void; delete: (k: string) => void };

  if (body.label != null) {
    const label = String(body.label).trim();
    if (!label) throw new Error('a group needs a label');
    node.set('label', label);
  }
  if (body.accounts != null) {
    const accounts = writableAccounts(body.accounts);
    if (accounts) node.set('accounts', doc.createNode(accounts));
    else node.delete('accounts');
  }
  if (body.sets != null) {
    const sets = body.sets.map((s) => String(s).trim()).filter(Boolean);
    if (sets.length) node.set('sets', doc.createNode(sets));
    else node.delete('sets');
  }

  await writeDoc(doc);
  return { ok: true, id };
}

export async function deleteGroup(id: string): Promise<{ ok: true; deleted: boolean }> {
  const doc = await readDoc();
  let found = false;
  try {
    const { seq, index } = nodeFor(doc, id);
    seq.delete(index);
    found = true;
  } catch {
    return { ok: true, deleted: false }; // deleting something already gone is not an error
  }
  if (found) await writeDoc(doc);
  return { ok: true, deleted: found };
}

/**
 * Reorder the whole list. The body is the new full order; anything it omits keeps its
 * relative position at the END rather than being dropped — a reorder must never be able to
 * delete a group, and a stale client that has not seen a newly-added one would otherwise do
 * exactly that.
 */
export async function reorderGroups(ids: string[]): Promise<{ ok: true; order: string[] }> {
  const doc = await readDoc();
  const seq = groupsSeq(doc);
  const idOf = (item: unknown) => String((item as { get?: (k: string) => unknown })?.get?.('id') ?? '');
  const wanted = ids.map(String);
  const rank = new Map(wanted.map((id, i) => [id, i]));
  const items = [...seq.items];
  items.sort((a, b) => (rank.get(idOf(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(idOf(b)) ?? Number.MAX_SAFE_INTEGER));
  seq.items = items;
  await writeDoc(doc);
  return { ok: true, order: items.map(idOf) };
}

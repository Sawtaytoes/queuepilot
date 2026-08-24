// QueuePilot PEOPLE — the humans, and the one place a provider account is tied to one of them.
//
// ── What a person is, and what a group became ────────────────────────────────────────────
//
// A PERSON is a human in the household: an immutable id (it is a URL), a display name, the
// provider accounts they sign in as, and the three picker fields Board Game Picker already
// kept about them (birth year, maximum game weight, whether they are a beginner).
//
// A GROUP is now a SAVED SET OF PEOPLE — a one-tap shortcut, not a second kind of thing
// (decision 2026-08-22-queuepilot-absorbs-board-game-picker-tonight-pick §6, and this repo's
// 2026-08-23 record). The group keeps everything it already had: its wire id, its `/g/<id>`
// URL, its label, its `sets:` claim list and its `accounts:` map. What it gains is a roster.
//
// That is why this file does NOT replace `groups.ts`. `groups.ts` still resolves which sets a
// group holds, and every rule it documents — explicit `sets:` beats derived `accounts:` — is
// untouched. The two meet at exactly one point: a group's accounts may now also be READ off
// its people, which is what `accountsForGroup()` below is for.
//
// ── Why the accounts live on the person now ──────────────────────────────────────────────
//
// Because the same human is spelled differently by every backend, and the group was the wrong
// place to say so as soon as a group could hold two people. A group of two people has two
// people's accounts; storing that on the group means writing the union out by hand and
// keeping it in step forever.
//
// The group's own `accounts:` is NOT deprecated by this. A group may legitimately stand for an
// account nobody in the roster holds — the `Demo` group is exactly that, a Plex profile that
// is not a household member — so the two are unioned rather than one winning.
//
// ── Personal data ────────────────────────────────────────────────────────────────────────
//
// This file is CODE. Names, birth years and account handles are DATA and live in
// `/config/queuepilot.sqlite`, never in this repo (AGENTS.md). Fixtures here are Ada, Grace
// and Linus.
import type { ProfileAccounts } from './groups.js';

/** One person, as stored and as served. */
export interface Person {
  /**
   * IMMUTABLE. It is a URL and therefore a promise — the same rule `sets.yaml` and
   * `groups.yaml` learned. A rename changes `displayName`, never this.
   */
  id: string;
  displayName: string;
  /** Roster order. Not an identity; a reorder must never be able to change who somebody is. */
  position: number;
  /** Provider kind -> account names, exactly the shape `groups.yaml`'s `accounts:` holds. */
  accounts: ProfileAccounts;
  /**
   * The three Board Game Picker picker fields, ported with their own meanings.
   *
   * `birthYear` rather than an age: an age is wrong within a year of being written down.
   * `maxWeight` is BoardGameGeek's 1–5 scale, and **null is "no ceiling stated", not 5** —
   * the picker treats an absent ceiling and a ceiling of 5 differently.
   */
  birthYear: number | null;
  maxWeight: number | null;
  isBeginner: boolean;
  /** 'board-game-picker' for a migrated player, null for a person created here. */
  source: string | null;
  /** That player's id in the source system. Together with `source` it is what makes the
   * import idempotent — a second run updates the row rather than writing a twin. */
  sourceId: string | null;
  createdAt: string | null;
}

/** A person as the API and the importer accept one. Everything but the id is optional. */
export interface PersonWrite {
  id: string;
  displayName?: string;
  position?: number;
  accounts?: ProfileAccounts;
  birthYear?: number | null;
  maxWeight?: number | null;
  isBeginner?: boolean;
  source?: string | null;
  sourceId?: string | null;
  createdAt?: string | null;
}

/** Lower-cased and trimmed — the same comparison `groups.ts` has always used on an account
 * name, because these are typed by hand and a capital letter is not a different person. */
export const norm = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/**
 * Turn a display name into a URL-safe id.
 *
 * Ids are IMMUTABLE once created, so this runs on CREATE only. Deliberately the same
 * transformation `groups.slugify()` uses, so a person id and a group id read the same way in
 * a URL bar and neither surprises the other.
 */
export function slugify(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** `base`, `base-2`, `base-3`… — the first one `taken` does not hold. Numbered rather than
 * random-suffixed for the same reason `groups.ts` numbers: a person reads this in a URL. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Normalise an accounts map: kinds lower-cased, names trimmed, empty kinds dropped.
 * The same projection `groups.normalizeAccounts` applies, kept identical on purpose. */
export function normalizeAccounts(raw: unknown): ProfileAccounts {
  if (!raw || typeof raw !== 'object') return {};
  const out: ProfileAccounts = {};
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    const list = (Array.isArray(value) ? value : [value])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean);
    if (list.length) out[String(kind).trim().toLowerCase()] = list;
  }
  return out;
}

/** Merge account maps, case-insensitively de-duplicated, first spelling wins.
 *
 * Used to union a group's own `accounts:` with its roster's. First-spelling-wins matters:
 * the group file is hand-edited and its capitalisation is the person's choice. */
export function mergeAccounts(...maps: readonly ProfileAccounts[]): ProfileAccounts {
  const out: ProfileAccounts = {};
  for (const map of maps) {
    for (const [kind, names] of Object.entries(map ?? {})) {
      const list = (out[kind] ??= []);
      for (const name of names ?? []) {
        const value = String(name ?? '').trim();
        if (value && !list.some((existing) => norm(existing) === norm(value))) list.push(value);
      }
    }
  }
  for (const [kind, names] of Object.entries(out)) if (!names.length) delete out[kind];
  return out;
}

/**
 * Every provider account a group stands for: its own `accounts:` plus its roster's.
 *
 * A UNION, not an override. A group may stand for an account no person holds — a demo Plex
 * profile is exactly that — and a person may hold an account the group never listed. Losing
 * either half would drop sets out of a group silently, which is the failure mode
 * `groups.ts`'s own header spends a paragraph on.
 */
export function accountsForGroup(
  groupAccounts: ProfileAccounts,
  roster: readonly Person[],
): ProfileAccounts {
  return mergeAccounts(groupAccounts ?? {}, ...roster.map((person) => person.accounts));
}

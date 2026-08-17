// Provider configuration, split in two by decision
// 2026-08-12-provider-tokens-live-in-a-separate-config-file:
//
//   1. DEFINITIONS  — /config/providers.yaml, plaintext. id, label, kind, base_url.
//                     Editable in the UI, diffable, backup-able, safe to paste into a PR.
//   2. TOKENS       — /config/providers.secrets.yaml, mode 0600. Nothing but id -> token.
//
// Resolution order per token, extending the app's existing rule:
//
//     env  >  /config/providers.secrets.yaml  >  unset (provider reports NOT CONFIGURED)
//
// An unset token FAILS LOUDLY. It must never fall through to an empty string, an
// unauthenticated request, or a placeholder. Two production outages came from exactly that
// seam (see hostConfig.js's header, and the ADR's Why): a placeholder that *looks* like
// config is worse than no config, because it produces a working-looking app that quietly
// talks to nothing.
//
// THE SECRETS FILE IS DELIBERATELY NOT ROUTED THROUGH THE YAML-EDITING MACHINERY.
// It is written by writeSecret() below and nowhere else. It must never acquire:
//   - a setKeepingComment/doc round-trip (sets.js),
//   - an undo-history mirror (history.js HISTORY_PATH / .history.json),
//   - a dated .bak-* sidecar the way sets.yaml and queues.yaml get.
// A credential copied into an undo stack or a dated backup has escaped its file.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

import type { Delivery, ProviderDefinition, ProviderVocabulary } from '../types.js';

import { isNodeError, errMessage } from '../errors.js';
import {
  PROVIDERS_PATH, PROVIDERS_SECRETS_PATH, KAVITA_URL, BOARD_GAME_PICKER_URL, STEAM_ID, MISTER_URL,
} from '../env.js';

/**
 * A resolved token and where it came from. `token` is null when unconfigured, NEVER `''` —
 * see tokenFor()/requireToken(). Local rather than in types.ts because it never leaves this
 * module's callers, and because a token shape in the shared contract is an invitation to
 * serialize one.
 */
export interface TokenResolution {
  token: string | null;
  source: string | null;
}

/**
 * The API-safe view of a provider. Note what is NOT here: `token`, and no index signature —
 * a closed shape is what stops a future `{...def, ...}` spread from widening this into a
 * leak. `configured` is a boolean, never the value and never a masked prefix.
 */
export interface ProviderPublicView {
  id: string;
  kind: string;
  label: string;
  base_url: string;
  supported: boolean;
  configured: boolean;
  delivery: Delivery;
  vocabulary: ProviderVocabulary;
}

/** The result of a secrets-file write. `changed` is deleteSecret()'s only addition. */
export interface SecretWriteResult {
  ok: true;
  id: string;
  changed?: boolean;
}

// The kinds this build knows how to instantiate. A definition naming anything else is kept
// (so a newer config on an older image is not silently dropped) but reports unsupported.
export const KINDS = ['plex', 'kavita', 'board-game-picker', 'steam', 'mister'];

// Push a lineup at a device, or return a URL to open. Kavita is `pull` because it has no
// cast and no webhooks at all — see docs/kavita-feasibility.md §4. This mirrors each
// provider's own `delivery`, kept here too so the API can report it without instantiating
// (and therefore without needing a token for an unconfigured provider).
// Steam is `pull` for the same structural reason Kavita is: a launch is a URL to OPEN
// (`steam://rungameid/<appid>`), not a lineup pushed at a device. That the URL is ultimately
// handed to a PC by Home Assistant rather than followed by a browser does not change which
// side builds it.
const DELIVERY: Record<string, Delivery | undefined> = {
  plex: 'push', kavita: 'pull', 'board-game-picker': 'pull', steam: 'pull', mister: 'pull',
};

// The WORDS each medium is described in. Kept beside DELIVERY and for the same reason: the
// API must be able to report it without instantiating a provider, so an UNCONFIGURED backend
// still labels its own editor correctly.
//
// This exists because `delivery` was not enough. It told the UI that a Kavita queue hands
// back a URL, which fixed the queue-level button — and every tile underneath still said
// "Play “The Sword-Eating Swordmaster” now" (reported live, 2026-08-15). Delivery is HOW a
// lineup starts; this is what the medium is CALLED, and they are not the same question.
const VOCABULARY: Record<string, ProviderVocabulary | undefined> = {
  plex: {
    verb: 'Play', unit: 'episode', units: 'episodes', member: 'show', done: 'watched', name: 'Plex',
    unitShort: 'eps', startIcon: '▶',
  },
  kavita: {
    verb: 'Read', unit: 'chapter', units: 'chapters', member: 'series', done: 'read', name: 'Kavita',
    unitShort: 'ch', startIcon: '📖',
  },
  'board-game-picker': {
    verb: 'Play', unit: 'play', units: 'plays', member: 'game', done: 'played', name: 'Board Game Picker',
    unitShort: 'plays', startIcon: '🎲',
  },
  // The same words as the picker, which is correct rather than lazy: both are games played
  // in sessions. They are told apart by `name` and the accent colour, not by inventing a
  // synonym for "play" that nobody says out loud.
  steam: {
    verb: 'Play', unit: 'play', units: 'plays', member: 'game', done: 'played', name: 'Steam',
    unitShort: 'plays', startIcon: '🎮',
  },
  // The third `play` vocabulary, and the words are right for the same reason the other two
  // are: these are games played in sessions. `name` and the accent tell them apart.
  mister: {
    verb: 'Play', unit: 'play', units: 'plays', member: 'game', done: 'played', name: 'MiSTer',
    unitShort: 'plays', startIcon: '🕹️',
  },
};

/**
 * The fallback vocabulary for a definition naming a kind this build does not know.
 *
 * Plex's words, because that is what every screen said before this map existed — an unknown
 * backend renders exactly as it used to rather than rendering blank labels.
 */
const DEFAULT_VOCABULARY: ProviderVocabulary = {
  verb: 'Play', unit: 'episode', units: 'episodes', member: 'show', done: 'watched', name: 'Plex', unitShort: 'eps',
  startIcon: '▶',
};

// Built-in deploy-time env names, per kind. These keep working exactly as they did before
// this file existed, which is what makes the connector surface additive: Plex stays
// env-only-configurable, and the root .env's KAVITA_API_KEY is honoured as-is.
const ENV_TOKEN_KEYS: Record<string, string[] | undefined> = {
  plex: ['PLEX_TOKEN', 'PLEX_API_KEY'],
  kavita: ['KAVITA_API_KEY'],
  // Optional on purpose — see KINDS_CONFIGURED_BY_URL below.
  'board-game-picker': ['BOARD_GAME_PICKER_API_TOKEN'],
  // Named to match the root .env the rest of the fleet already uses. REQUIRED: Steam's Web
  // API refuses an unauthenticated GetOwnedGames outright, so this fails loudly like Plex
  // and Kavita rather than joining the URL-configured exception.
  steam: ['STEAM_WEB_API_KEY'],
};

// A provider added from the couch has no deploy-time env name, so it gets a generic one.
// `my-kavita` -> PROVIDER_TOKEN_MY_KAVITA.
export const envTokenKeyFor = (id: string): string => `PROVIDER_TOKEN_${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/** The env-name lookup for a kind. `kind` is nullable at every call site, and an absent kind
 *  has no deploy-time names — `''` is not a key of ENV_TOKEN_KEYS, so this is `undefined`
 *  exactly as indexing with `null` was. */
const envKeysForKind = (kind: string | null): string[] | undefined => ENV_TOKEN_KEYS[kind ?? ''];

function readYaml(p: string, what: string): Record<string, unknown> {
  try {
    // A YAML file may legitimately parse to a scalar or a list; `|| {}` already covered the
    // empty case and the cast covers the rest — every reader below re-checks the field it
    // wants, so a wrong-shaped file degrades to "no providers" rather than throwing.
    return (parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown> | null) || {};
  } catch (e) {
    // Missing is the normal cold-start case: no providers configured yet. Anything else is
    // worth a line in the log but must never crash boot — this process also serves the web
    // UI, and losing the editor because of a stray comma is the worse failure.
    if (!isNodeError(e) || e.code !== 'ENOENT') console.log(`[providers] could not read ${what}: ${errMessage(e)}`);
    return {};
  }
}

// --- definitions (plaintext) -------------------------------------------------- //

function normalizeDefinition(raw: unknown, index: number): ProviderDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const def = raw as Record<string, unknown>;
  const id = String(def.id ?? '').trim();
  if (!id) {
    console.log(`[providers] definition #${index} has no id — skipped`);
    return null;
  }
  const kind = String(def.kind ?? '').trim().toLowerCase();
  return {
    id,
    kind,
    label: String(def.label ?? id).trim() || id,
    base_url: String(def.base_url ?? '').trim().replace(/\/+$/, ''),
  };
}

// The implicit Plex definition. Plex predates the connector surface and is configured by
// deploy-time env (config.js PLEX_URL/PLEX_TOKEN), so it exists as a provider whether or not
// anyone has written providers.yaml. Without this, widening the seam would have made an
// upgrade require a config file to keep playing — an upgrade that breaks the family TV.
function implicitDefinitions(): ProviderDefinition[] {
  const out: ProviderDefinition[] = [];
  out.push({ id: 'plex', kind: 'plex', label: 'Plex', base_url: '' });
  // Kavita is implicit only when its deploy-time env is present, so an install that has
  // never heard of Kavita does not grow a permanently-unconfigured provider in its UI.
  if (KAVITA_URL) out.push({ id: 'kavita', kind: 'kavita', label: 'Kavita', base_url: KAVITA_URL });
  // Same rule for the picker: no URL, no permanently-unconfigured provider in the UI.
  if (BOARD_GAME_PICKER_URL) {
    out.push({ id: 'board-game-picker', kind: 'board-game-picker', label: 'Board Game Picker', base_url: BOARD_GAME_PICKER_URL });
  }
  // Steam has no self-hosted base URL to point at — the API host is Valve's and is a
  // constant in steam-client.ts — so the ACCOUNT is what says "this install plays PC games".
  // Same rule, different field.
  if (STEAM_ID) out.push({ id: 'steam', kind: 'steam', label: 'Steam', base_url: '' });
  // Back to the URL rule for the MiSTer: mrext is a LAN service and its address is the only
  // thing to configure.
  if (MISTER_URL) out.push({ id: 'mister', kind: 'mister', label: 'MiSTer', base_url: MISTER_URL });
  return out;
}

/** All provider definitions: the implicit ones, overridden by anything in providers.yaml. */
export function definitions(): ProviderDefinition[] {
  const doc = readYaml(PROVIDERS_PATH, PROVIDERS_PATH);
  const listed: unknown[] = Array.isArray(doc.providers) ? doc.providers : [];
  const byId = new Map<string, ProviderDefinition>();
  for (const d of implicitDefinitions()) byId.set(d.id, d);
  listed.forEach((raw, i) => {
    const d = normalizeDefinition(raw, i);
    if (!d) return;
    // A file entry wins over the implicit one, but only field by field: a definition that
    // omits base_url should not blank out the env-derived default.
    const prior = byId.get(d.id);
    byId.set(d.id, prior ? { ...prior, ...d, base_url: d.base_url || prior.base_url } : d);
  });
  return [...byId.values()];
}

export const definitionFor = (id: string): ProviderDefinition | null => definitions().find((d) => d.id === id) || null;

// --- tokens (the secrets file) ------------------------------------------------ //

function secretsMap(): Map<string, string> {
  const doc = readYaml(PROVIDERS_SECRETS_PATH, 'the provider secrets file');
  // Tolerate both a bare `id: token` map and a `tokens:` wrapper, because the file is
  // hand-editable over SMB and both shapes are the obvious thing to write.
  const src = doc && typeof doc.tokens === 'object' && doc.tokens ? doc.tokens : doc;
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(src || {})) {
    if (typeof v === 'string' && v) out.set(k, v);
  }
  return out;
}

/**
 * Resolve a provider's token: env wins, then the secrets file, then unset.
 * Returns { token, source } — `token` is null when unconfigured, NEVER ''.
 * The caller must treat null as an error; see requireToken().
 */
export function tokenFor(id: string, kind: string | null = null): TokenResolution {
  const keys = [...(envKeysForKind(kind) || []), envTokenKeyFor(id)];
  for (const k of keys) {
    const v = process.env[k];
    if (v) return { token: v, source: `env:${k}` };
  }
  const fromFile = secretsMap().get(id);
  if (fromFile) return { token: fromFile, source: 'file' };
  return { token: null, source: null };
}

/** Throw a named, actionable error rather than making an unauthenticated request. */
export function requireToken(id: string, kind: string | null = null): string {
  const { token } = tokenFor(id, kind);
  if (!token) {
    const envKey = (envKeysForKind(kind) || [])[0] || envTokenKeyFor(id);
    throw new Error(
      `provider '${id}' is NOT CONFIGURED: no token. Set ${envKey} in the app env, `
      + `or add '${id}: <token>' to ${PROVIDERS_SECRETS_PATH}.`,
    );
  }
  return token;
}

/**
 * Kinds whose backend does not require a credential, so "configured" is a base URL rather
 * than a token.
 *
 * This is a NAMED exception, not a softening of the rule. Board Game Picker is a household
 * app on the LAN with no Authelia in front of it; it only demands
 * `Authorization: Bearer` when its own `BOARD_GAME_PICKER_API_TOKEN` is set. Plex and
 * Kavita keep failing loudly on a missing token, which is the behaviour two production
 * outages bought us — see this file's header.
 */
// `mister` joins for the same reason and on the same evidence: mrext runs on the MiSTer
// itself, on the LAN, and issues no credential at all. Plex, Kavita and Steam still fail
// loudly on a missing token — that behaviour was bought with two production outages.
const KINDS_CONFIGURED_BY_URL = new Set(['board-game-picker', 'mister']);

export const isConfigured = (id: string, kind: string | null = null): boolean => (
  KINDS_CONFIGURED_BY_URL.has(kind ?? '')
    ? Boolean(definitionFor(id)?.base_url)
    : tokenFor(id, kind).token != null
);

/**
 * Write (or replace) one provider's token. Write-only by design — there is no reader that
 * returns a token to the browser. Creates the file 0600 and keeps it 0600.
 */
export async function writeSecret(id: string, token: string): Promise<SecretWriteResult> {
  if (!id) throw new Error('writeSecret needs a provider id');
  if (typeof token !== 'string' || !token) throw new Error('writeSecret needs a non-empty token');
  const current = Object.fromEntries(secretsMap());
  current[id] = token;
  const dir = path.dirname(PROVIDERS_SECRETS_PATH);
  await fsp.mkdir(dir, { recursive: true });
  // Write via a 0600 temp file in the same directory, then rename: the credential is never
  // briefly world-readable, and a crash mid-write cannot truncate the live file. No .bak,
  // no history mirror — see this module's header.
  const tmp = `${PROVIDERS_SECRETS_PATH}.tmp`;
  await fsp.writeFile(tmp, stringify(current), { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, PROVIDERS_SECRETS_PATH);
  await fsp.chmod(PROVIDERS_SECRETS_PATH, 0o600);
  return { ok: true, id };
}

/** Remove one provider's token. */
export async function deleteSecret(id: string): Promise<SecretWriteResult> {
  const current = Object.fromEntries(secretsMap());
  if (!(id in current)) return { ok: true, id, changed: false };
  delete current[id];
  const tmp = `${PROVIDERS_SECRETS_PATH}.tmp`;
  await fsp.writeFile(tmp, stringify(current), { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, PROVIDERS_SECRETS_PATH);
  await fsp.chmod(PROVIDERS_SECRETS_PATH, 0o600);
  return { ok: true, id, changed: true };
}

/**
 * The API-safe view of a provider: everything EXCEPT the token. `configured` is a boolean,
 * never the value, and never a masked prefix — a masked token is still a token leak when the
 * secret is short. This is the only shape any route may return.
 */
export function publicView(def: ProviderDefinition): ProviderPublicView {
  return {
    id: def.id,
    kind: def.kind,
    label: def.label,
    base_url: def.base_url,
    supported: KINDS.includes(def.kind),
    configured: isConfigured(def.id, def.kind),
    // How a queue on this provider STARTS. Exposed so the UI can vary copy and affordances
    // without branching on `kind` — a UI that says `if (kind === 'kavita')` has to be edited
    // again for every future backend, which is the leak the seam exists to prevent.
    delivery: DELIVERY[def.kind] || 'push',
    // …and what the medium is CALLED. Same rule, different question: `delivery` fixed the
    // queue-level button and left every tile saying "Play" on something you read.
    vocabulary: VOCABULARY[def.kind] || DEFAULT_VOCABULARY,
  };
}

/**
 * How a queue on this kind STARTS, without instantiating it. `sets.ts` decides a set's
 * delivery with this.
 *
 * Exported because that file had grown its OWN `PULL_KINDS = new Set(['kavita'])` — a second
 * hand-maintained answer to a question this map already answers, and one that would have
 * rendered a board-game queue as a push target with a "Play on <device>" button for a
 * backend that has no devices.
 */
export const deliveryForKind = (kind: string | null | undefined): Delivery => (
  DELIVERY[kind ?? ''] || 'push'
);

/** One provider's words, without instantiating it. `sets.ts` labels a queue with this. */
export const vocabularyForKind = (kind: string | null | undefined): ProviderVocabulary => (
  VOCABULARY[kind ?? ''] || DEFAULT_VOCABULARY
);

export const publicList = (): ProviderPublicView[] => definitions().map(publicView);

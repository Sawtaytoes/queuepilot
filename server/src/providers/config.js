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

import { PROVIDERS_PATH, PROVIDERS_SECRETS_PATH, KAVITA_URL } from '../env.js';

// The kinds this build knows how to instantiate. A definition naming anything else is kept
// (so a newer config on an older image is not silently dropped) but reports unsupported.
export const KINDS = ['plex', 'kavita'];

// Push a lineup at a device, or return a URL to open. Kavita is `pull` because it has no
// cast and no webhooks at all — see docs/kavita-feasibility.md §4. This mirrors each
// provider's own `delivery`, kept here too so the API can report it without instantiating
// (and therefore without needing a token for an unconfigured provider).
const DELIVERY = { plex: 'push', kavita: 'pull' };

// Built-in deploy-time env names, per kind. These keep working exactly as they did before
// this file existed, which is what makes the connector surface additive: Plex stays
// env-only-configurable, and the root .env's KAVITA_API_KEY is honoured as-is.
const ENV_TOKEN_KEYS = {
  plex: ['PLEX_TOKEN', 'PLEX_API_KEY'],
  kavita: ['KAVITA_API_KEY'],
};

// A provider added from the couch has no deploy-time env name, so it gets a generic one.
// `my-kavita` -> PROVIDER_TOKEN_MY_KAVITA.
export const envTokenKeyFor = (id) => `PROVIDER_TOKEN_${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

function readYaml(p, what) {
  try {
    return parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {
    // Missing is the normal cold-start case: no providers configured yet. Anything else is
    // worth a line in the log but must never crash boot — this process also serves the web
    // UI, and losing the editor because of a stray comma is the worse failure.
    if (e.code !== 'ENOENT') console.log(`[providers] could not read ${what}: ${e.message}`);
    return {};
  }
}

// --- definitions (plaintext) -------------------------------------------------- //

function normalizeDefinition(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!id) {
    console.log(`[providers] definition #${index} has no id — skipped`);
    return null;
  }
  const kind = String(raw.kind ?? '').trim().toLowerCase();
  return {
    id,
    kind,
    label: String(raw.label ?? id).trim() || id,
    base_url: String(raw.base_url ?? '').trim().replace(/\/+$/, ''),
  };
}

// The implicit Plex definition. Plex predates the connector surface and is configured by
// deploy-time env (config.js PLEX_URL/PLEX_TOKEN), so it exists as a provider whether or not
// anyone has written providers.yaml. Without this, widening the seam would have made an
// upgrade require a config file to keep playing — an upgrade that breaks the family TV.
function implicitDefinitions() {
  const out = [];
  out.push({ id: 'plex', kind: 'plex', label: 'Plex', base_url: '' });
  // Kavita is implicit only when its deploy-time env is present, so an install that has
  // never heard of Kavita does not grow a permanently-unconfigured provider in its UI.
  if (KAVITA_URL) out.push({ id: 'kavita', kind: 'kavita', label: 'Kavita', base_url: KAVITA_URL });
  return out;
}

/** All provider definitions: the implicit ones, overridden by anything in providers.yaml. */
export function definitions() {
  const doc = readYaml(PROVIDERS_PATH, PROVIDERS_PATH);
  const listed = Array.isArray(doc.providers) ? doc.providers : [];
  const byId = new Map();
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

export const definitionFor = (id) => definitions().find((d) => d.id === id) || null;

// --- tokens (the secrets file) ------------------------------------------------ //

function secretsMap() {
  const doc = readYaml(PROVIDERS_SECRETS_PATH, 'the provider secrets file');
  // Tolerate both a bare `id: token` map and a `tokens:` wrapper, because the file is
  // hand-editable over SMB and both shapes are the obvious thing to write.
  const src = doc && typeof doc.tokens === 'object' && doc.tokens ? doc.tokens : doc;
  const out = new Map();
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
export function tokenFor(id, kind = null) {
  const keys = [...(ENV_TOKEN_KEYS[kind] || []), envTokenKeyFor(id)];
  for (const k of keys) {
    const v = process.env[k];
    if (v) return { token: v, source: `env:${k}` };
  }
  const fromFile = secretsMap().get(id);
  if (fromFile) return { token: fromFile, source: 'file' };
  return { token: null, source: null };
}

/** Throw a named, actionable error rather than making an unauthenticated request. */
export function requireToken(id, kind = null) {
  const { token } = tokenFor(id, kind);
  if (!token) {
    const envKey = (ENV_TOKEN_KEYS[kind] || [])[0] || envTokenKeyFor(id);
    throw new Error(
      `provider '${id}' is NOT CONFIGURED: no token. Set ${envKey} in the app env, `
      + `or add '${id}: <token>' to ${PROVIDERS_SECRETS_PATH}.`,
    );
  }
  return token;
}

export const isConfigured = (id, kind = null) => tokenFor(id, kind).token != null;

/**
 * Write (or replace) one provider's token. Write-only by design — there is no reader that
 * returns a token to the browser. Creates the file 0600 and keeps it 0600.
 */
export async function writeSecret(id, token) {
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
export async function deleteSecret(id) {
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
export function publicView(def) {
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
  };
}

export const publicList = () => definitions().map(publicView);

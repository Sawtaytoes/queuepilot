// Host/deploy values (real Shield IP, Plex LAN URL, client names) live in a YAML file on the
// persisted /config volume — NOT baked into this (public) image. This is the Node half of
// queue_builder/config.py's `_load_host_config` / `_hostval`; the two MUST agree, because a
// value that resolves differently between the engines is a bug you only see on the family TV.
//
// Regression this closes: the Python→Node port copied the old config's *placeholder defaults*
// verbatim but not its YAML layer, so once Node owned playback every host value fell back to
// the non-routable placeholder — ADB dialed 192.0.2.30 and no profile-gated card played.
import { parse } from 'yaml';
import fs from 'node:fs';
import { errMessage, isNodeError } from './errors.js';

/**
 * The parsed /config YAML. `yaml`'s `parse()` is `any`, so it is taken as `unknown` and
 * kept behind an index-signature record — every read goes through `hostval`, which
 * stringifies whatever it finds. The `|| {}` (not `??`) is deliberate: an empty or
 * all-comments file parses to `null`, and a scalar document would previously have been
 * returned as-is, so the falsy test is reproduced exactly rather than "fixed".
 */
type HostConfig = Record<string, unknown>;

function loadHostConfig(): HostConfig {
  const path = process.env.CONFIG_PATH || '/config/config.yaml';
  try {
    const doc: unknown = parse(fs.readFileSync(path, 'utf8'));
    return (doc || {}) as HostConfig;
  } catch (e) {
    // A missing file is fine: every value falls back to a deliberately non-routable
    // placeholder, so a misconfigured deploy fails loudly instead of reaching a stranger's
    // LAN. Anything else is worth a line in the log, but must never crash boot.
    if (!isNodeError(e) || e.code !== 'ENOENT') {
      console.log(`[config] could not read ${path}: ${errMessage(e)}`);
    }
    return {};
  }
}

const HOST = loadHostConfig();

/** Resolve a host value: an env override wins, then the /config YAML, then the placeholder. */
export const hostval = (envKey: string, yamlKey: string, fallback: string): string => {
  const v = process.env[envKey];
  if (v) return v;
  const y = HOST[yamlKey];
  if (y != null && y !== '') return String(y);
  return fallback;
};

// Host-value resolution must be env > /config/config.yaml > placeholder, and must match
// queue_builder/config.py's `_hostval` exactly. The Node port originally copied config.py's
// placeholder defaults but NOT its YAML layer, so under PLAYBACK_ENGINE=node the deploy
// dialed 192.0.2.30 for ADB and no profile-gated card played (2026-08-10). This locks the
// middle layer in: env.js/config.js are read in a child process per case, because both
// modules resolve their values once at import time.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-config-'));
const yamlPath = path.join(dir, 'config.yaml');
fs.writeFileSync(
  yamlPath,
  [
    'shield_ip: 192.0.2.99',
    'plex_local_url: http://192.0.2.98:32400/',
    'plex_api_server_url: https://plex.test.local',
    'shield_client_name: Test SHIELD',
  ].join('\n'),
);

const READ = `
  Promise.all([import('../server/src/env.js'), import('../server/src/config.js')])
    .then(([e, c]) => console.log(JSON.stringify({
      SHIELD_IP: e.SHIELD_IP, ADB_TARGET: e.ADB_TARGET, PLEX_LOCAL_URL: e.PLEX_LOCAL_URL,
      SHIELD_CLIENT_NAME: e.SHIELD_CLIENT_NAME, PLEX_URL: c.PLEX_URL,
    })));
`;
const resolve = (env) =>
  JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', READ], {
      cwd: import.meta.dirname,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    }),
  );

let failed = 0;
const check = (label, actual, expected) => {
  try {
    assert.equal(actual, expected);
    console.log(`PASS ${label}`);
  } catch {
    console.log(`FAIL ${label} — got ${actual}, want ${expected}`);
    failed++;
  }
};

// 1. The YAML supplies the value when the env doesn't — the layer that was missing.
const yaml = resolve({ CONFIG_PATH: yamlPath, SHIELD_IP: '', PLEX_LOCAL_URL: '' });
check('yaml supplies shield_ip', yaml.SHIELD_IP, '192.0.2.99');
check('ADB_TARGET derives from the yaml ip', yaml.ADB_TARGET, '192.0.2.99:5555');
check('yaml supplies plex_local_url (trailing slash stripped)', yaml.PLEX_LOCAL_URL, 'http://192.0.2.98:32400');
check('yaml supplies plex_api_server_url', yaml.PLEX_URL, 'https://plex.test.local');
check('yaml supplies shield_client_name', yaml.SHIELD_CLIENT_NAME, 'Test SHIELD');

// 2. An env override still wins over the file (config.py's precedence).
const overridden = resolve({ CONFIG_PATH: yamlPath, SHIELD_IP: '192.0.2.55' });
check('env beats yaml', overridden.SHIELD_IP, '192.0.2.55');
check('ADB_TARGET follows the env override', overridden.ADB_TARGET, '192.0.2.55:5555');

// 3. No file at all → the non-routable placeholder, so a misconfigured deploy fails loudly
//    instead of reaching a stranger's LAN.
const missing = resolve({
  CONFIG_PATH: path.join(dir, 'absent.yaml'),
  SHIELD_IP: '',
  PLEX_LOCAL_URL: '',
  PLEX_API_SERVER_URL: '',
});
check('missing file → placeholder ip', missing.SHIELD_IP, '192.0.2.30');
check('missing file → placeholder plex url', missing.PLEX_LOCAL_URL, 'http://192.0.2.10:32400');
check('missing file → placeholder server url', missing.PLEX_URL, 'https://plex.example.com');

fs.rmSync(dir, { recursive: true, force: true });
console.log('done');
process.exit(failed ? 1 : 0);

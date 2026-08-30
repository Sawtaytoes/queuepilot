// Offline gate: a Plex tile's webUrl opens the configured server, not app.plex.tv.
//
// The 2026-08-22 first draft hard-coded `https://app.plex.tv/desktop/#!…` so a phone off
// the LAN could still open the item. The owner then asked for the household reverse-proxy
// instead (decision `2026-08-25-plex-tile-links-use-the-server-url-not-app-plex-tv`). This
// pins both halves of that correction:
//   * the host is `PLEX_API_SERVER_URL` (placeholder-safe; never a hard-coded household host)
//   * the path is `/web/index.html#!/server/{machineId}/details?key=…`
//   * collections use `/library/collections/{ratingKey}`; other items use `/library/metadata/…`
//   * a missing rating key or a blank machine id returns null (no dead link)
//
// Self-contained: stubs `./playback.js` under webLinks so nothing reaches a live Plex.
// Run:  server/node_modules/.bin/tsx e2e/plex-web-url-test.ts
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import { parentIs } from './stubs/module-id.mjs';

declare global {
  // eslint-disable-next-line no-var
  var __WEB_LINKS_MID: string | undefined;
}

const stub = (src: string): string => `data:text/javascript,${encodeURIComponent(src)}`;

const PLAYBACK_STUB = stub(`
  export async function machineIdentifier() {
    return globalThis.__WEB_LINKS_MID === undefined ? 'server-mid' : globalThis.__WEB_LINKS_MID;
  }
`);

const fromWebLinks = parentIs('/server/src/webLinks');
registerHooks({
  resolve(spec, ctx, next) {
    if (fromWebLinks(ctx) && spec === './playback.js') {
      return { url: PLAYBACK_STUB, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

// Force the placeholder host — an inherited PLEX_API_SERVER_URL would make a green run
// against the live household value look like proof the code reads the env, when it would
// also pass if the host were hard-coded to that same value.
process.env.PLEX_API_SERVER_URL = 'https://plex.example.com';
delete process.env.CONFIG_PATH;

const { plexWebUrl } = await import('../server/src/webLinks.js');

let failed = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  try {
    assert.equal(actual, expected);
    console.log(`PASS ${label}`);
  } catch {
    console.log(`FAIL ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    failed++;
  }
};

const url = await plexWebUrl('12345');
check(
  'webUrl uses PLEX_API_SERVER_URL + /web/index.html',
  url,
  'https://plex.example.com/web/index.html#!/server/server-mid/details?key=%2Flibrary%2Fmetadata%2F12345',
);
check('webUrl does not point at app.plex.tv', url?.includes('app.plex.tv') ?? false, false);

check(
  'collection webUrl uses the Plex collection route',
  await plexWebUrl('341063', 'collection'),
  'https://plex.example.com/web/index.html#!/server/server-mid/details?key=%2Flibrary%2Fcollections%2F341063',
);

check('null rating key → null', await plexWebUrl(null), null);
check('empty rating key → null', await plexWebUrl(''), null);

globalThis.__WEB_LINKS_MID = '';
check('blank machine id → null', await plexWebUrl('99'), null);

if (failed) process.exit(1);

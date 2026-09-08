// The pre-switch account observation against a real HTTP fixture.
//
// QueuePilot cannot ask an idle Plex Android app which Home profile it holds. An ACTIVE PMS
// session is different: `/status/sessions` carries both the target Player and the User that
// owns its watch history. This gate proves that the reader selects the configured player,
// never another household session, and abstains when the evidence is incomplete.
//
// Run: server/node_modules/.bin/tsx e2e/profile-session-observation-test.ts

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

interface SessionRow {
  ratingKey: string;
  Player?: { machineIdentifier?: string; title?: string };
  User?: { id?: string | number; title?: string };
}

let sessions: SessionRow[] = [];
let seenToken = '';
const server = createServer((req, res) => {
  if (req.url !== '/status/sessions') {
    res.writeHead(404).end();
    return;
  }
  seenToken = String(req.headers['x-plex-token'] || '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ MediaContainer: { size: sessions.length, Metadata: sessions } }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as AddressInfo;

process.env.PLEX_API_SERVER_URL = `http://127.0.0.1:${address.port}`;
process.env.PLEX_TOKEN = 'admin-test-token';
process.env.SHIELD_CLIENT_MACHINE_ID = 'target-player-id';
process.env.SHIELD_CLIENT_NAME = 'Family Room Player';
process.env.SHIELD_CLIENT_URI = '';

const playback = await import('../server/src/playback.js');

let failures = 0;
function check(label: string, isOk: boolean, detail = ''): void {
  console.log(`${isOk ? 'PASS' : 'FAIL'} ${label}${!isOk && detail ? ` — ${detail}` : ''}`);
  if (!isOk) failures += 1;
}

try {
  sessions = [
    {
      ratingKey: 'other-item',
      Player: { machineIdentifier: 'other-player-id', title: 'Office Player' },
      User: { id: 111, title: 'Other User' },
    },
    {
      ratingKey: 'target-item',
      Player: { machineIdentifier: 'target-player-id', title: 'Family Room Player' },
      User: { id: 222, title: 'Requested User' },
    },
  ];
  let observed = await playback.currentAccount();
  check('selects the configured player rather than the first active session',
    observed.accountId === 222 && observed.title === 'Requested User',
    JSON.stringify(observed));
  check('reads /status/sessions with the admin token', seenToken === 'admin-test-token', seenToken);

  sessions = [{
    ratingKey: 'other-item',
    Player: { machineIdentifier: 'other-player-id', title: 'Office Player' },
    User: { id: 111, title: 'Other User' },
  }];
  observed = await playback.currentAccount();
  check('does not treat another player as the target',
    observed.accountId === null && observed.reason === 'no active session on the target player',
    JSON.stringify(observed));

  sessions = [{
    ratingKey: 'target-item',
    Player: { machineIdentifier: 'target-player-id', title: 'Family Room Player' },
    User: { title: 'Unidentified User' },
  }];
  observed = await playback.currentAccount();
  check('a target session without User.id is not trusted',
    observed.accountId === null
      && observed.title === 'Unidentified User'
      && observed.reason === 'target session carries no User id',
    JSON.stringify(observed));

  sessions = [{
    ratingKey: 'target-by-name',
    Player: { machineIdentifier: 'changed-id', title: 'Family Room Player' },
    User: { id: 333, title: 'Name Match' },
  }];
  observed = await playback.currentAccount();
  check('the configured player name remains a fallback when its machine id changes',
    observed.accountId === 333 && observed.title === 'Name Match',
    JSON.stringify(observed));
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

console.log(failures ? `\nFAILURES: ${failures}` : '\ndone');
process.exit(failures ? 1 : 0);

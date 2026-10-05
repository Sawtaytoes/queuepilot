// The browser smoke's `webServer`: four real servers over the committed fixtures, one process
// for Playwright to start and stop.
//
// Four servers because four fixtures already exist and each is the right data for its routes —
// the same split `vrt-capture.ts` shoots from:
//
//   * LANDING  (base port)     — the task home, overview, people, pending, the collection
//                                 picker, the queue index, one Picks queue and one Rules queue;
//   * CALENDAR (base port + 1) — every combination of a season window and a reset date;
//   * TONIGHT  (base port + 2) — What to Watch/Play, with its queues filed to people;
//   * BOARD GAMES (base port + 3) — the board-game shelf and one result card.
//
// The board-game server starts LAST, so its answering is Playwright's signal that all four are
// up (the Tonight harness has written its trays by then; it awaits them).
//
// Each harness spawns its server DETACHED, in its own process group, because tsx forks the
// real server (see `stubs/server-process.mjs`). Playwright's own teardown therefore cannot
// reach them: `playwright.config.ts` asks for a graceful SIGTERM, and this process takes the
// four groups down with it.
//
// The server's clock starts at a fixed instant and its `Math.random` is seeded
// (`stubs/fixed-clock.mjs`), the same as VRT, so the season window and the reset date a route
// draws do not depend on the day the smoke runs.
//
// Run from the REPO ROOT (the Tonight harness copies its fixtures by relative path).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { startBoardGameServer } from '../board-game-play-harness.js';
import { startFixtureServer } from '../fixture-server.js';
import { killServer, REPO_ROOT } from '../stubs/server-process.mjs';
import { startTonightServer } from '../tonight-harness.js';
import { SMOKE_BASE_PORT, SMOKE_FIXED_NOW } from './ports.js';

process.env.TZ = 'UTC';
process.env.VRT_FIXED_NOW = SMOKE_FIXED_NOW;
process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS,
  `--import=${pathToFileURL(path.join(REPO_ROOT, 'e2e', 'stubs', 'fixed-clock.mjs')).href}`,
]
  .filter(Boolean)
  .join(' ');

const children: Parameters<typeof killServer>[0][] = [];

const stopAll = () => {
  for (const child of children) killServer(child);
  children.length = 0;
};

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}
process.on('exit', stopAll);

try {
  const landing = await startFixtureServer(SMOKE_BASE_PORT, {
    groups: 'landing.groups.yaml',
    people: 'landing.people-mapping.yaml',
    queues: 'landing.queues.yaml',
    sets: 'landing.sets.yaml',
  });
  children.push(landing.child);

  const calendar = await startFixtureServer(SMOKE_BASE_PORT + 1, {
    queues: 'queues.harness.yaml',
    sets: 'calendar.sets.yaml',
  });
  children.push(calendar.child);

  const tonight = await startTonightServer(SMOKE_BASE_PORT + 2);
  children.push(tonight.child);

  const boardGames = await startBoardGameServer(SMOKE_BASE_PORT + 3);
  children.push(boardGames.child);

  console.log(
    `smoke servers up: ${[landing, calendar, tonight, boardGames].map(({ base }) => base).join(' ')}`,
  );
} catch (error) {
  console.error('smoke servers failed to start:', error);
  stopAll();
  process.exit(1);
}

// Stay alive until Playwright sends the signal.
setInterval(() => {}, 1 << 30);

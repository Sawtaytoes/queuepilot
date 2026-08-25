// Boot a server over a synthetic board-game collection AND a confirmed people mapping.
//
// Shared by `board-game-play-test.ts` (the gate) and `shot-board-game-play.ts` (the PR's
// screenshots), so the images and the assertions are taken against the SAME data and neither
// can drift into showing something the other never checked.
//
// **Fixture data, never live.** The cast is Ada, Grace and Linus, and every title, publisher
// and box label below is invented. This repo is public and seeding a fixture from the live
// collection is the shortcut this package's own rules forbid.
//
// The people mapping is `confirmed: true` here — a harness is the one place the answer is
// known in advance. The real import is gated on the owner and nothing may run it for him.
//
// Plex is an unroutable closed port; the other providers point at `.invalid` hosts, which is
// enough to make them CONFIGURED without any of them ever being called.
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { killServer, spawnServer } from './stubs/server-process.mjs';

const NOW = '2026-01-01T00:00:00.000Z';

/** The absorbed app's schema, as `PRAGMA table_xinfo` reports it on a RUNNING database. */
const SOURCE_SCHEMA = `
CREATE TABLE games (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, min_players INTEGER NOT NULL,
  max_players INTEGER NOT NULL, best_with TEXT NOT NULL DEFAULT '[]',
  recommended_with TEXT NOT NULL DEFAULT '[]', weight REAL, min_playtime INTEGER,
  max_playtime INTEGER, min_age INTEGER,
  interaction_types TEXT NOT NULL DEFAULT '["competitive"]',
  interaction_types_source TEXT NOT NULL DEFAULT 'derived',
  categories TEXT NOT NULL DEFAULT '[]', publishers TEXT NOT NULL DEFAULT '[]',
  year_published INTEGER, bgg_id INTEGER, rating REAL,
  source TEXT NOT NULL DEFAULT 'import', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  image_path TEXT);
CREATE TABLE boxes (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'standalone', bgg_id INTEGER,
  homebox_entity_id TEXT, location_text TEXT, image_path TEXT, created_at TEXT NOT NULL,
  version_nickname TEXT, version_year INTEGER, version_languages TEXT NOT NULL DEFAULT '[]');
CREATE TABLE game_overrides (
  game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE, min_players INTEGER,
  max_players INTEGER, best_with TEXT, recommended_with TEXT, weight REAL, min_age INTEGER,
  interaction_types TEXT, is_excluded INTEGER, notes TEXT, updated_at TEXT NOT NULL,
  is_excluded_source TEXT, image_path TEXT);
CREATE TABLE game_links (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL);
CREATE TABLE game_modules (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'owner', box_id TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE categories (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE game_categories (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL REFERENCES categories(name) ON DELETE CASCADE,
  PRIMARY KEY (game_id, name));
CREATE TABLE owner_groupings (
  box_label TEXT PRIMARY KEY, game_id TEXT NOT NULL, game_name TEXT NOT NULL,
  created_at TEXT NOT NULL, listing_bgg_id INTEGER);
CREATE TABLE grouping_reviews (
  box_label TEXT PRIMARY KEY, game_id TEXT, status TEXT NOT NULL, reason TEXT,
  reviewed_at TEXT, parent_game_id TEXT);
CREATE TABLE players (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, birth_year INTEGER, max_weight REAL,
  is_beginner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE plays (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL, notes TEXT);
CREATE TABLE play_players (
  play_id TEXT NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (play_id, player_id));
CREATE TABLE player_known_games (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  confirmed_at TEXT NOT NULL, PRIMARY KEY (player_id, game_id));
`;

/** Ada, Grace and Linus, confirmed — a harness knows the answer in advance. */
const PEOPLE = `confirmed: true
version: 1
people:
- id: ada
  display_name: Ada
  board_game_picker_id: player-ada
  accounts: {}
  birth_year: null
  max_weight: null
  is_beginner: false
- id: grace
  display_name: Grace
  board_game_picker_id: player-grace
  accounts: {}
  birth_year: null
  max_weight: null
  is_beginner: false
- id: linus
  display_name: Linus
  board_game_picker_id: player-linus
  accounts: {}
  birth_year: null
  max_weight: null
  is_beginner: false
`;

/**
 * Four titles, all invented, chosen so the shelf can answer every question this gate asks.
 *
 * ⚠️ **A HISTORICAL PLAY WITH NOBODY AT THE TABLE.** `Quarry Duel` carries one, exactly as the
 * live data does — every play in the absorbed app arrived through the anonymous door. It is
 * here so the screen has to paint that state, and so nothing in this suite quietly back-fills
 * it. The migration test pins the same thing at the row level.
 *
 * ⚠️ **A KNOWN-HOW CLAIM THAT PREDATES EVERYTHING.** Ada's claim on `Quarry Duel` is dated
 * 2026-01-01. Undo must never take that one back, which is the difference between "the claims
 * this finish created" and "every claim on screen".
 */
function writeSource(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(SOURCE_SCHEMA);

  const game = db.prepare(
    `INSERT INTO games (id, name, min_players, max_players, best_with, recommended_with, weight,
       min_playtime, max_playtime, min_age, interaction_types, interaction_types_source,
       categories, publishers, year_published, bgg_id, rating, source, created_at, updated_at,
       image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`,
  );
  game.run('harbour-lantern', 'Harbour Lantern', 2, 5, '[3,4]', '[2,5]', 2.4, 30, 60, 10,
    '["competitive"]', 'derived', '["Card Game"]', '["Northwind Press"]', 2019, 100001, 7.4,
    NOW, NOW, null);
  game.run('quarry-duel', 'Quarry Duel', 2, 4, '[3]', '[2,4]', 1.8, 15, 20, 8,
    '["competitive"]', 'derived', '[]', '["Northwind Press"]', 2016, 100002, 7.1, NOW, NOW,
    null);
  game.run('tidewright', 'Tidewright', 2, 4, '[3]', '[2,4]', 2.1, 20, 40, 10,
    '["cooperative"]', 'owner', '[]', '["Saltmarsh Games"]', 2021, 100003, 7.8, NOW, NOW, null);
  game.run('amber-signal', 'Amber Signal', 2, 6, '[3]', '[2,4]', 4.6, 90, 150, 14,
    '["competitive"]', 'derived', '[]', '["Saltmarsh Games"]', 2022, 100004, 8.2, NOW, NOW,
    null);

  const box = db.prepare(
    `INSERT INTO boxes (id, game_id, label, kind, bgg_id, homebox_entity_id, location_text,
       image_path, created_at, version_nickname, version_year, version_languages)
     VALUES (?, ?, ?, 'standalone', NULL, NULL, ?, NULL, ?, NULL, NULL, '[]')`,
  );
  box.run('box-1', 'harbour-lantern', 'Harbour Lantern', 'Shelf two, left', NOW);
  box.run('box-2', 'quarry-duel', 'Quarry Duel', 'Shelf one, right', NOW);
  box.run('box-3', 'tidewright', 'Tidewright', 'Shelf three', NOW);
  box.run('box-4', 'amber-signal', 'Amber Signal', 'Top of the cupboard', NOW);

  db.prepare(
    `INSERT INTO game_links (id, game_id, kind, label, url, source, created_at)
     VALUES ('link-1', 'harbour-lantern', 'rulebook', 'Rulebook', 'https://example.test/1',
             'owner', ?)`,
  ).run(NOW);

  const player = db.prepare(
    `INSERT INTO players (id, display_name, birth_year, max_weight, is_beginner, created_at)
     VALUES (?, ?, NULL, NULL, 0, ?)`,
  );
  player.run('player-ada', 'Ada', NOW);
  player.run('player-grace', 'Grace', NOW);
  player.run('player-linus', 'Linus', NOW);

  // The historical play: a game id, a timestamp, and nobody. Exactly as it arrived.
  db.prepare(
    "INSERT INTO plays (id, game_id, played_at, notes) VALUES ('play-1', 'quarry-duel', ?, NULL)",
  ).run('2026-02-01T20:00:00.000Z');

  db.prepare(
    `INSERT INTO player_known_games (player_id, game_id, confirmed_at)
     VALUES ('player-ada', 'quarry-duel', ?)`,
  ).run(NOW);

  db.close();
}

export interface BoardGameServer {
  base: string;
  child: ChildProcess;
  dir: string;
  storePath: string;
}

export async function startBoardGameServer(port: number): Promise<BoardGameServer> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'qp-bgplay-'));

  await fs.writeFile(path.join(dir, 'sets.yaml'), 'sets: []\n');
  await fs.writeFile(path.join(dir, 'queues.yaml'), '{}\n');
  await fs.writeFile(path.join(dir, 'groups.yaml'), 'groups: []\n');
  await fs.writeFile(path.join(dir, 'pending.yaml'), 'seen_through: 0\n');
  // The PROPOSAL filename, not a confirmed one: the tool writes this name and confirming is
  // meant to be one edit rather than an edit plus a rename.
  await fs.writeFile(path.join(dir, 'people-mapping-proposal.yaml'), PEOPLE);
  writeSource(path.join(dir, 'board-game-picker-import.sqlite'));

  const child = spawnServer({
    env: {
      ...process.env,
      CACHE_PATH: path.join(dir, 'cache.sqlite'),
      GROUPS_PATH: path.join(dir, 'groups.yaml'),
      HISTORY_PATH: path.join(dir, '.history.json'),
      MQTT_HOST: '',
      MQTT_PASS: '',
      MQTT_PORT: '',
      MQTT_USER: '',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      PENDING_PATH: path.join(dir, 'pending.yaml'),
      PLEX_API_SERVER_URL: 'https://127.0.0.1:1',
      PLEX_TOKEN: '',
      PROVIDERS_PATH: path.join(dir, 'providers.yaml'),
      PROVIDERS_SECRETS_PATH: path.join(dir, 'providers.secrets.yaml'),
      QUEUES_PATH: path.join(dir, 'queues.yaml'),
      SETS_PATH: path.join(dir, 'sets.yaml'),
      STORE_BACKEND: 'sqlite',
      WEB_PORT: String(port),
    },
    stdio: 'ignore',
  });

  const base = `http://localhost:${port}`;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const res = await fetch(`${base}/api/people`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { base, child, dir, storePath: path.join(dir, 'queues.queuepilot.sqlite') };
}

/** Stop the whole process GROUP — `tsx` forks the real server. */
export const stopBoardGameServer = (server: BoardGameServer): void => killServer(server.child);

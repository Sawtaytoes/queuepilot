// THE SYNC WRITE PATH, and the three ways it could lose something quietly.
//
//   1. TAKING BACK AN OWNER'S REMOVAL. `is_excluded_source` is the only thing that separates
//      "a human took this off the shelf" from "an upstream refresh dropped it". Merge the two
//      and the next sync re-offers every hand-excluded title, with no error.
//   2. BLANKING WHAT THE UPSTREAM DOES NOT CARRY. `interaction_types`, `categories` and
//      `publishers` come from the enrichment pass, not from a collection row. A re-import that
//      wrote them would look like a successful sync and cost the collection its facets.
//   3. A MISSING NAMED PARAMETER (WP-4a difference #6). node:sqlite binds NULL where the old
//      driver threw, so an omitted key is silent data loss rather than a crash. The last block
//      proves `prepareChecked` is actually in the path.
//
// EVERY TITLE HERE IS INVENTED. This repo is public.
import { describe, expect, it } from 'vitest';

import { applyBoardGameSync, replaceDerivedLinks } from './boardgameSync.js';
import { importBoardGameRows, type SourceRow } from './boardgameImport.js';
import { loadGroupingRules } from './boardgameRules.js';
import { listBoardGames } from './boardgames.js';
import { migrate, prepareChecked } from './open.js';
import { openSqlite, type SqliteDatabase } from '../sqlite.js';

const fresh = (): SqliteDatabase => {
  const db = openSqlite(':memory:');
  migrate(db);
  return db;
};

const row = (over: Partial<SourceRow> & { name: string }): SourceRow => ({
  bestWith: [],
  bggId: null,
  kind: 'standalone',
  maxPlayers: 4,
  maxPlaytime: null,
  minAge: null,
  minPlayers: 2,
  minPlaytime: null,
  publishers: [],
  rating: null,
  recommendedWith: [],
  versionLanguages: [],
  versionNickname: null,
  versionYear: null,
  weight: null,
  yearPublished: null,
  ...over,
});

const HARBOUR = row({ bggId: 100001, name: 'Harbour Lantern' });
const QUARRY = row({ bggId: 100002, name: 'Quarry Duel' });

const excluded = (db: SqliteDatabase, gameId: string) =>
  prepareChecked<{ is_excluded: number | null; is_excluded_source: string | null }>(
    db,
    'SELECT is_excluded, is_excluded_source FROM board_game_overrides WHERE game_id = :id',
  ).get({ id: gameId });

describe('an import writes the imported layer and nothing else', () => {
  it('collapses boxes into titles and records the boxes under them', () => {
    const db = fresh();
    const stats = importBoardGameRows(
      [HARBOUR, QUARRY, row({ bggId: 100003, kind: 'expansion', name: 'Harbour Lantern: Tides' })],
      db,
    );
    expect(stats.games).toBe(2);
    expect(stats.boxes).toBe(3);
    const games = listBoardGames(db);
    expect(games.map((game) => game.name).sort()).toEqual(['Harbour Lantern', 'Quarry Duel']);
    expect(games.find((game) => game.id === 'harbour-lantern')?.boxes.length).toBe(2);
  });

  it('does NOT blank the three columns the enrichment pass owns', () => {
    const db = fresh();
    importBoardGameRows([HARBOUR], db);
    db.exec(
      `UPDATE board_games SET categories = '["Nautical"]',
         interaction_types = '["cooperative"]', interaction_types_source = 'owner',
         publishers = '["Harbour Press"]' WHERE id = 'harbour-lantern'`,
    );

    // The same row arrives again, the way a nightly sync delivers it.
    importBoardGameRows([HARBOUR], db);

    const game = listBoardGames(db)[0];
    expect(game?.categories).toEqual(['Nautical']);
    expect(game?.interactionTypes).toEqual(['cooperative']);
    expect(game?.publishers).toEqual(['Harbour Press']);
  });

  it('keeps a box’s art and its physical location across the delete-and-rebuild', () => {
    const db = fresh();
    importBoardGameRows([HARBOUR], db);
    db.exec(
      `UPDATE board_game_boxes SET image_path = '/images/abc-600.webp',
         location_text = 'Shelf 2' WHERE game_id = 'harbour-lantern'`,
    );

    importBoardGameRows([HARBOUR], db);

    const box = prepareChecked<{ image_path: string | null; location_text: string | null }>(
      db,
      "SELECT image_path, location_text FROM board_game_boxes WHERE game_id = 'harbour-lantern'",
    ).get({});
    // These came from the enrichment pass, never from an upstream row. Writing NULL over them
    // costs the whole collection its box art until somebody re-runs the enrichment.
    expect(box?.image_path).toBe('/images/abc-600.webp');
    expect(box?.location_text).toBe('Shelf 2');
  });

  it('does not delete a hand-made title that has no boxes', () => {
    const db = fresh();
    db.exec(
      `INSERT INTO board_games (id, name, min_players, max_players, source, created_at, updated_at)
       VALUES ('typed-by-hand', 'Typed By Hand', 2, 4, 'owner', '2026-01-01', '2026-01-01')`,
    );
    importBoardGameRows([HARBOUR], db);
    expect(listBoardGames(db).some((game) => game.id === 'typed-by-hand')).toBe(true);
  });
});

describe('a sync may take back its OWN removal and never the owner’s', () => {
  it('marks a title removed when it leaves the collection, and never deletes it', () => {
    const db = fresh();
    applyBoardGameSync([HARBOUR, QUARRY], db);

    const report = applyBoardGameSync([HARBOUR], db);
    expect(report.removed).toEqual(['Quarry Duel']);
    expect(excluded(db, 'quarry-duel')).toEqual({ is_excluded: 1, is_excluded_source: 'sync' });
    // Removed is not deleted. The title keeps its tags, its links and its play history.
    expect(listBoardGames(db).some((game) => game.id === 'quarry-duel')).toBe(true);
  });

  it('restores a title it removed itself, once it comes back', () => {
    const db = fresh();
    applyBoardGameSync([HARBOUR, QUARRY], db);
    applyBoardGameSync([HARBOUR], db);

    const report = applyBoardGameSync([HARBOUR, QUARRY], db);
    expect(report.restored).toEqual(['Quarry Duel']);
    expect(excluded(db, 'quarry-duel')?.is_excluded).toBe(0);
  });

  it('🐞 LEAVES AN OWNER’S CALL ALONE, IN BOTH DIRECTIONS', () => {
    const db = fresh();
    applyBoardGameSync([HARBOUR, QUARRY], db);

    // A human put a title back that the upstream no longer lists.
    db.exec(
      `INSERT INTO board_game_overrides (game_id, is_excluded, is_excluded_source, updated_at)
       VALUES ('quarry-duel', 0, 'owner', '2026-08-01T00:00:00.000Z')`,
    );

    const report = applyBoardGameSync([HARBOUR], db);
    // Reported, and NOT re-excluded. Re-excluding is the screen that fights you, and it is what
    // happens the moment `is_excluded_source` stops being read.
    expect(report.leftAlone).toEqual(['Quarry Duel']);
    expect(report.removed).toEqual([]);
    expect(excluded(db, 'quarry-duel')).toEqual({ is_excluded: 0, is_excluded_source: 'owner' });
  });

  it('never touches a title the upstream was never going to list', () => {
    const db = fresh();
    // No id at the title level and none on any box: typed in by hand, or a promo. Not "missing".
    applyBoardGameSync([row({ name: 'Hand Typed Promo' }), HARBOUR], db);
    const report = applyBoardGameSync([HARBOUR], db);
    expect(report.removed).toEqual([]);
    expect(excluded(db, 'hand-typed-promo')).toBeUndefined();
  });

  it('counts a merged title as owned when ANY of its boxes is', () => {
    const db = fresh();
    const rules = loadGroupingRules(db);
    expect(rules.prefixes).toEqual([]);

    // A title whose own listing is a family id no box carries, plus two owned season boxes.
    db.exec(
      `INSERT INTO board_game_groupings
         (prefix, game_id, game_name, listing_bgg_id, position, source, created_at)
       VALUES ('harbour lantern', 'harbour-lantern', 'Harbour Lantern', '999999', 0, 'owner',
               '2026-01-01')`,
    );
    const seasons = [
      row({ bggId: 100001, name: 'Harbour Lantern: Season One' }),
      row({ bggId: 100002, name: 'Harbour Lantern: Season Two' }),
    ];
    applyBoardGameSync(seasons, db);
    expect(listBoardGames(db).map((game) => game.id)).toEqual(['harbour-lantern']);

    // Season two leaves the collection; season one is still owned, so the TITLE is still owned.
    const report = applyBoardGameSync([seasons[0]!], db);
    expect(report.removed).toEqual([]);
  });
});

describe('derived links', () => {
  it('replaces its own links and never one somebody typed', () => {
    const db = fresh();
    importBoardGameRows([HARBOUR], db);
    db.exec(
      `INSERT INTO board_game_links (id, game_id, kind, label, url, source, created_at)
       VALUES ('by-hand', 'harbour-lantern', 'rulebook', 'The good scan',
               'https://example.invalid/by-hand.pdf', 'owner', '2026-01-01')`,
    );

    replaceDerivedLinks(
      'harbour-lantern',
      'rulebook',
      [{ label: 'Rulebook', url: 'https://example.invalid/derived.pdf' }],
      db,
    );
    replaceDerivedLinks(
      'harbour-lantern',
      'rulebook',
      [{ label: 'Rulebook', url: 'https://example.invalid/derived-2.pdf' }],
      db,
    );

    const links = listBoardGames(db)[0]?.links ?? [];
    expect(links.map((link) => link.url).sort()).toEqual([
      'https://example.invalid/by-hand.pdf',
      'https://example.invalid/derived-2.pdf',
    ]);
  });

  it('an EMPTY list is a real answer — it clears a link that is no longer true', () => {
    const db = fresh();
    importBoardGameRows([HARBOUR], db);
    replaceDerivedLinks(
      'harbour-lantern',
      'howToPlay',
      [{ label: 'How to play', url: 'https://example.invalid/watch' }],
      db,
    );
    replaceDerivedLinks('harbour-lantern', 'howToPlay', [], db);
    expect(listBoardGames(db)[0]?.links).toEqual([]);
  });
});

describe('WP-4a difference #6 — a missing named parameter', () => {
  it('throws instead of writing NULL', () => {
    const db = fresh();
    importBoardGameRows([HARBOUR], db);
    const statement = prepareChecked(
      db,
      'UPDATE board_games SET name = :name, weight = :weight WHERE id = :id',
    );
    // node:sqlite would bind NULL for `weight` and report a successful write. That is the whole
    // failure mode the shim exists to close, and this asserts it is in this file's path.
    expect(() => statement.run({ id: 'harbour-lantern', name: 'Harbour Lantern' })).toThrow(
      /missing named parameter/,
    );
  });
});

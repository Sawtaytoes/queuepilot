// THE DEFECT GATE. A logged play records who played, and a play never invents a claim.
//
// The app this was absorbed from had three plays and zero participant rows. Every test in the
// first block fails against that behaviour, which is the point of them.
//
// The cast is Ada, Grace and Linus — new people fixtures are invented, never captured
// (AGENTS.md), and so are the titles.
import { describe, expect, it } from 'vitest';

import {
  knownHowForGame,
  logBoardGamePlay,
  setBoardGameKnownHow,
} from './boardgamePlays.js';
import { listBoardGameKnownHow, listBoardGamePlays } from './boardgames.js';
import { migrate } from './open.js';
import { openSqlite, type SqliteDatabase } from '../sqlite.js';

const NOW = '2026-08-25T20:00:00.000Z';

const fresh = (): SqliteDatabase => {
  const db = openSqlite(':memory:');
  migrate(db);

  const game = db.prepare(
    `INSERT INTO board_games (id, name, min_players, max_players, created_at, updated_at)
     VALUES (?, ?, 2, 5, ?, ?)`,
  );
  game.run('harbour-lantern', 'Harbour Lantern', NOW, NOW);
  game.run('quarry-duel', 'Quarry Duel', NOW, NOW);

  const person = db.prepare(
    'INSERT INTO people (id, position, display_name, created_at) VALUES (?, ?, ?, ?)',
  );
  person.run('ada', 0, 'Ada', NOW);
  person.run('grace', 1, 'Grace', NOW);
  person.run('linus', 2, 'Linus', NOW);

  return db;
};

const attendance = (db: SqliteDatabase, playId: string): string[] =>
  db
    .prepare<{ person_id: string }>(
      'SELECT person_id FROM board_game_play_people WHERE play_id = ? ORDER BY person_id',
    )
    .all(playId)
    .map((row) => row.person_id);

describe('a logged play records who played', () => {
  it('writes a participant row for every person at the table', () => {
    const db = fresh();
    const play = logBoardGamePlay(
      { gameId: 'harbour-lantern', personIds: ['ada', 'grace'] },
      db,
    );

    expect(attendance(db, play.id)).toEqual(['ada', 'grace']);
    expect(play.playerIds).toEqual(['ada', 'grace']);
  });

  it('reads the people back out through the play log', () => {
    const db = fresh();
    logBoardGamePlay({ gameId: 'harbour-lantern', personIds: ['grace', 'linus'] }, db);

    expect(listBoardGamePlays(db)[0]?.playerIds).toEqual(['grace', 'linus']);
  });

  it('stores an empty table as an empty table, and still logs the play', () => {
    // The anonymous door: somebody standing at a shelf who says nothing about who was there
    // has told the truth about the game. That is a real answer, not a gap to fill.
    const db = fresh();
    const play = logBoardGamePlay({ gameId: 'quarry-duel', personIds: [] }, db);

    expect(listBoardGamePlays(db)).toHaveLength(1);
    expect(attendance(db, play.id)).toEqual([]);
  });

  it('collapses a person named twice rather than losing the whole play', () => {
    const db = fresh();
    const play = logBoardGamePlay(
      { gameId: 'quarry-duel', personIds: ['ada', 'ada'] },
      db,
    );

    expect(attendance(db, play.id)).toEqual(['ada']);
  });

  it('rolls the play back when a participant cannot be written', () => {
    const db = fresh();
    expect(() =>
      logBoardGamePlay({ gameId: 'no-such-game', personIds: ['ada'] }, db),
    ).toThrow();
    expect(listBoardGamePlays(db)).toEqual([]);
  });
});

describe('a play renews a claim and never invents one', () => {
  it('refreshes a claim the person had already stated', () => {
    const db = fresh();
    setBoardGameKnownHow(
      {
        confirmedAt: '2026-01-01T00:00:00.000Z',
        gameId: 'harbour-lantern',
        isKnown: true,
        personId: 'ada',
      },
      db,
    );

    logBoardGamePlay(
      { gameId: 'harbour-lantern', personIds: ['ada'], playedAt: NOW },
      db,
    );

    expect(knownHowForGame('harbour-lantern', db)).toEqual([
      { confirmedAt: NOW, gameId: 'harbour-lantern', playerId: 'ada' },
    ]);
  });

  it('creates NO claim for a person who had never stated one', () => {
    // The whole decision in one assertion: playing a game is not the same fact as knowing it.
    const db = fresh();
    logBoardGamePlay(
      { gameId: 'harbour-lantern', personIds: ['ada', 'grace', 'linus'], playedAt: NOW },
      db,
    );

    expect(listBoardGameKnownHow(db)).toEqual([]);
  });

  it('does not make a claim look fresher than it is when the play is backdated', () => {
    const db = fresh();
    setBoardGameKnownHow(
      { confirmedAt: NOW, gameId: 'harbour-lantern', isKnown: true, personId: 'ada' },
      db,
    );

    logBoardGamePlay(
      {
        gameId: 'harbour-lantern',
        personIds: ['ada'],
        playedAt: '2026-03-01T20:00:00.000Z',
      },
      db,
    );

    expect(knownHowForGame('harbour-lantern', db)[0]?.confirmedAt).toBe(NOW);
  });

  it('renews only the people who were at THIS table', () => {
    const db = fresh();
    for (const personId of ['ada', 'grace']) {
      setBoardGameKnownHow(
        {
          confirmedAt: '2026-01-01T00:00:00.000Z',
          gameId: 'harbour-lantern',
          isKnown: true,
          personId,
        },
        db,
      );
    }

    logBoardGamePlay(
      { gameId: 'harbour-lantern', personIds: ['ada'], playedAt: NOW },
      db,
    );

    expect(knownHowForGame('harbour-lantern', db)).toEqual([
      { confirmedAt: NOW, gameId: 'harbour-lantern', playerId: 'ada' },
      { confirmedAt: '2026-01-01T00:00:00.000Z', gameId: 'harbour-lantern', playerId: 'grace' },
    ]);
  });

  it('leaves a claim about a DIFFERENT game alone', () => {
    const db = fresh();
    setBoardGameKnownHow(
      {
        confirmedAt: '2026-01-01T00:00:00.000Z',
        gameId: 'quarry-duel',
        isKnown: true,
        personId: 'ada',
      },
      db,
    );

    logBoardGamePlay(
      { gameId: 'harbour-lantern', personIds: ['ada'], playedAt: NOW },
      db,
    );

    expect(knownHowForGame('quarry-duel', db)[0]?.confirmedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});

describe('stating a claim', () => {
  it('ticks a person against a game', () => {
    const db = fresh();
    setBoardGameKnownHow(
      { confirmedAt: NOW, gameId: 'quarry-duel', isKnown: true, personId: 'linus' },
      db,
    );

    expect(knownHowForGame('quarry-duel', db)).toEqual([
      { confirmedAt: NOW, gameId: 'quarry-duel', playerId: 'linus' },
    ]);
  });

  it('re-ticking re-confirms rather than duplicating', () => {
    const db = fresh();
    setBoardGameKnownHow(
      {
        confirmedAt: '2026-01-01T00:00:00.000Z',
        gameId: 'quarry-duel',
        isKnown: true,
        personId: 'linus',
      },
      db,
    );
    setBoardGameKnownHow(
      { confirmedAt: NOW, gameId: 'quarry-duel', isKnown: true, personId: 'linus' },
      db,
    );

    expect(knownHowForGame('quarry-duel', db)).toEqual([
      { confirmedAt: NOW, gameId: 'quarry-duel', playerId: 'linus' },
    ]);
  });

  it('unticking removes the claim, which is what undo runs', () => {
    const db = fresh();
    setBoardGameKnownHow(
      { confirmedAt: NOW, gameId: 'quarry-duel', isKnown: true, personId: 'linus' },
      db,
    );
    setBoardGameKnownHow(
      { gameId: 'quarry-duel', isKnown: false, personId: 'linus' },
      db,
    );

    expect(knownHowForGame('quarry-duel', db)).toEqual([]);
  });
});

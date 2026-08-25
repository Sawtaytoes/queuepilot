// A play, and a known-how claim — the WRITE side of the two people-keyed board-game tables.
//
// ── Why this file exists at all ──────────────────────────────────────────────────────────
//
// The app this was absorbed from logged three plays and attached NOBODY to any of them.
// `board_game_play_people` had never been written to, so the play log could not answer "who
// has played this" — the only question it exists to answer. The write itself was never
// missing: the source repository inserted participants perfectly well, and every caller handed
// it an empty list. So the defect was a UI that logged a play without ever asking who was at
// the table, and the fix is not one line of SQL, it is a play that CANNOT be logged without an
// answer to that question. `logBoardGamePlay` takes `personIds` as a required argument for
// that reason: a caller has to state the empty list on purpose.
//
// ── The rule that governs everything below ───────────────────────────────────────────────
//
// **A PLAY MAY RENEW A KNOWN-HOW CLAIM. IT MUST NEVER INVENT ONE.**
//
// Knowing the rules is a fact a person STATES. It is not a play count and it is not derivable
// from one: six plays of a heavy game and you may still reach for the book, and a game learned
// at somebody else's table has no play row here at all. So the refresh below is an `UPDATE`,
// there is no `INSERT` on that path, and there must never be one. A "mark everyone who played
// as knowing it" default belongs in the UI, where it is a PROPOSAL somebody can correct before
// it is written — never in here, where it would be an inference from a counter.
//
// The `confirmed_at <` guard is the second half of the same rule: logging last March's session
// is not a reason to call a claim fresher than the tick somebody made in August.
//
// ── Empty is a real answer, and it stays one ─────────────────────────────────────────────
//
// A play with nobody named is still a play. Somebody standing at a shelf who taps "we played
// this" and does not fill in a form has told the truth about the game and nothing about the
// table, and the log should hold exactly that. Nothing here invents a participant to make the
// row look complete, and nothing back-fills the historical plays that arrived that way —
// `store/migrate/boardgames.test.ts` pins the empty table as the correct migration result.
import { randomUUID } from 'node:crypto';

import type { KnownGame, Play } from '../../boardgames/types.js';
import { bookOfRecord, prepareChecked } from './open.js';
import type { SqliteDatabase } from '../sqlite.js';

/** One sitting, as a caller states it. `personIds` is REQUIRED — see this file's header. */
export interface PlayWrite {
  gameId: string;
  /** Who was at the table. `[]` is a real answer and is stored as one. */
  personIds: readonly string[];
  notes?: string | null;
  /** ISO 8601. Omit for now. */
  playedAt?: string;
}

/**
 * Log one play, record who was at the table, and RENEW their claims.
 *
 * Three statements in one transaction, because a play whose participants failed to write is
 * the exact defect this file exists to close — a half-written play would look logged on the
 * screen and be anonymous in the log.
 *
 * Duplicate ids in `personIds` are collapsed rather than rejected: the primary key would throw
 * on the second insert, and a UI that manages to send a name twice has a UI bug, not a reason
 * to lose the whole play.
 */
export function logBoardGamePlay(
  play: PlayWrite,
  db: SqliteDatabase = bookOfRecord(),
): Play {
  const id = randomUUID();
  const playedAt = play.playedAt ?? new Date().toISOString();
  const notes = play.notes ?? null;
  const personIds = [...new Set(play.personIds)];

  db.withTransaction(() => {
    prepareChecked(
      db,
      `INSERT INTO board_game_plays (id, game_id, played_at, notes)
       VALUES (:id, :game_id, :played_at, :notes)`,
    ).run({ game_id: play.gameId, id, notes, played_at: playedAt });

    const attend = prepareChecked(
      db,
      `INSERT INTO board_game_play_people (play_id, person_id)
       VALUES (:play_id, :person_id)`,
    );

    // `UPDATE`, never `INSERT` — the header says why, and this is the line it is about.
    const renew = prepareChecked(
      db,
      `UPDATE board_game_known_how SET confirmed_at = :played_at
        WHERE person_id = :person_id AND game_id = :game_id AND confirmed_at < :played_at`,
    );

    for (const personId of personIds) {
      attend.run({ person_id: personId, play_id: id });
      renew.run({ game_id: play.gameId, person_id: personId, played_at: playedAt });
    }
  });

  return { gameId: play.gameId, id, notes, playedAt, playerIds: personIds };
}

/**
 * Tick or untick ONE person against ONE game.
 *
 * This is the control that states the claim, and it is the only door that can create one.
 * Re-ticking an existing claim re-confirms it, which is how a row a screen has called stale
 * gets answered without playing the game.
 *
 * `isKnown: false` DELETES. "I do not know this any more" and "nobody has ever said" are the
 * same state here on purpose — a tombstone would be a third state no screen can paint.
 */
export function setBoardGameKnownHow(
  claim: { gameId: string; personId: string; isKnown: boolean; confirmedAt?: string },
  db: SqliteDatabase = bookOfRecord(),
): void {
  if (!claim.isKnown) {
    prepareChecked(
      db,
      'DELETE FROM board_game_known_how WHERE person_id = :person_id AND game_id = :game_id',
    ).run({ game_id: claim.gameId, person_id: claim.personId });
    return;
  }

  prepareChecked(
    db,
    `INSERT INTO board_game_known_how (person_id, game_id, confirmed_at)
     VALUES (:person_id, :game_id, :confirmed_at)
     ON CONFLICT (person_id, game_id) DO UPDATE SET confirmed_at = excluded.confirmed_at`,
  ).run({
    confirmed_at: claim.confirmedAt ?? new Date().toISOString(),
    game_id: claim.gameId,
    person_id: claim.personId,
  });
}

/**
 * Everyone who has ALREADY stated they know this game.
 *
 * What the finish step needs to tell a proposal from an inference: the people it is about to
 * tick who had never said so are a NEW claim, and the screen has to be able to say which those
 * are before it writes them.
 */
export const knownHowForGame = (
  gameId: string,
  db: SqliteDatabase = bookOfRecord(),
): KnownGame[] =>
  prepareChecked<{ person_id: string; confirmed_at: string }>(
    db,
    `SELECT person_id, confirmed_at FROM board_game_known_how
      WHERE game_id = :game_id ORDER BY person_id`,
  )
    .all({ game_id: gameId })
    .map((row) => ({
      confirmedAt: row.confirmed_at,
      gameId,
      playerId: row.person_id,
    }));

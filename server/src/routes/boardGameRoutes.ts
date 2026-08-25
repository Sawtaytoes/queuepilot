import { Hono } from 'hono';

import { parsePickCriteria, SHORTLIST_SIZE } from '../boardgames/criteria.js';
import { pick } from '../boardgames/pick.js';
import type { Game, PickCandidate, PickResult, Player } from '../boardgames/types.js';
import { errMessage } from '../errors.js';
import {
  knownHowForGame,
  logBoardGamePlay,
  setBoardGameKnownHow,
} from '../store/db/boardgamePlays.js';
import {
  getBoardGame,
  listBoardGameKnownHow,
  listBoardGamePlays,
  listBoardGames,
} from '../store/db/boardgames.js';
import { listPeople } from '../store/db/people.js';
import { readBody } from './readBody.js';

/**
 * The board-game collection, the pick, and the two writes the play log was missing.
 *
 * ## Why this route exists at all — the defect it closes
 *
 * The absorbed app could log a play and did not ask who played it, so its participant table
 * had never been written to and the log could not answer "who has played this". `POST
 * /board-games/plays` takes `personIds` and validates every one of them against the roster,
 * so a play either records a real table or is refused. It does not INVENT a table: an empty
 * list is accepted and stored as empty, because somebody standing at a shelf who says nothing
 * about who was there has still told the truth about the game.
 *
 * ## Known-how is stated, never derived
 *
 * `POST /board-games/:id/known` is the ONLY door that creates a claim, and one person states
 * one claim per call. Logging a play RENEWS the claims of whoever was at the table and creates
 * none — `store/db/boardgamePlays.ts` holds that rule and says why. "Everyone who played knows
 * it" is a default the finish screen PROPOSES and this API never assumes: the screen sends the
 * ticks it ended up with, one call each.
 *
 * ## Not the integration API
 *
 * Everything here is SPA-only. `/api/board-games` says who knows what and who was at a table,
 * which is the household's people; the integration surface another app reads is games-only and
 * stays that way.
 *
 * ## Nothing here writes a COLLECTION row
 *
 * No title, box, link, override or category is editable through this file. Those writers are
 * the sync and the enrichment (WP-4d), and until they land the source app still owns them.
 */
export function boardGameRoutes(): Hono {
  const app = new Hono();

  /**
   * The Collection screen's payload: the shelf, who has played what, and who knows what.
   *
   * Projected rather than shipping whole `Game` objects — boxes, links and modules are a
   * detail screen's data and multiply the payload by roughly four for a list that paints a
   * name, a player count and a poster.
   */
  app.get('/board-games', (c) => {
    try {
      const plays = listBoardGamePlays();
      const playedBy = new Map<string, Set<string>>();
      const lastPlayed = new Map<string, string>();

      // `listBoardGamePlays` answers newest first, so the FIRST play seen for a game is its
      // most recent one.
      for (const play of plays) {
        if (!lastPlayed.has(play.gameId)) lastPlayed.set(play.gameId, play.playedAt);
        const people = playedBy.get(play.gameId) ?? new Set<string>();
        for (const personId of play.playerIds) people.add(personId);
        playedBy.set(play.gameId, people);
      }

      return c.json({
        games: listBoardGames().map((game) => ({
          bestWith: game.bestWith,
          id: game.id,
          imagePath: game.imagePath,
          interactionTypes: game.interactionTypes,
          isExcluded: game.isExcluded,
          lastPlayedAt: lastPlayed.get(game.id) ?? null,
          maxPlayers: game.maxPlayers,
          maxPlaytime: game.maxPlaytime,
          minPlayers: game.minPlayers,
          minPlaytime: game.minPlaytime,
          name: game.name,
          ownerCategories: game.ownerCategories,
          playCount: game.playCount,
          // The question the play log exists to answer, answered on the card.
          playedBy: [...(playedBy.get(game.id) ?? [])].sort(),
          weight: game.weight,
        })),
        knownHow: listBoardGameKnownHow().map((claim) => ({
          confirmedAt: claim.confirmedAt,
          gameId: claim.gameId,
          personId: claim.playerId,
        })),
      });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  /** One title, whole — the card a queue hands you when the queue already chose. */
  app.get('/board-games/:id', (c) => {
    try {
      const game = getBoardGame(c.req.param('id'));
      if (!game) return c.json({ error: 'no such game' }, 404);
      return c.json({ game, knownHow: knownHowClaims(game.id) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  /**
   * Draw one game, plus the two the shortlist control can reveal.
   *
   * The shortlist is drawn HERE and returned with the first card, rather than fetched when the
   * control is tapped. Two reasons, and the second is the important one: a second request would
   * re-draw, so the card already on screen could change under the finger that asked to see more
   * of them. The shortlist is the same weighted draw run again with the previous winners
   * excluded — the ported engine, three times, and no second drawing rule.
   */
  app.post('/board-games/pick', async (c) => {
    try {
      const parsed = parsePickCriteria(await readBody(c));
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);

      const games = listBoardGames();
      const plays = listBoardGamePlays();
      const knownGames = listBoardGameKnownHow();
      const players = listPeople().map(
        (person): Player => ({
          birthYear: person.birthYear,
          displayName: person.displayName,
          id: person.id,
          isBeginner: person.isBeginner,
          maxWeight: person.maxWeight,
        }),
      );

      const drawn: PickCandidate[] = [];
      let result: PickResult | null = null;
      const excluded = [...parsed.criteria.excludedGameIds];

      for (let round = 0; round < SHORTLIST_SIZE; round += 1) {
        const next = pick({
          criteria: { ...parsed.criteria, excludedGameIds: excluded },
          games,
          groups: [],
          knownGames,
          players,
          plays,
        });

        // The FIRST draw is the answer, including when it is empty — a later round running out
        // of candidates just means the shelf held fewer than three, which is not an empty pick.
        if (round === 0) result = next;
        if (next.outcome !== 'picked') break;

        drawn.push(next.candidate);
        excluded.push(next.candidate.game.id);
      }

      return c.json({ result, shortlist: drawn });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  /**
   * Log a play. Body: `{gameId, personIds, notes?, playedAt?}`.
   *
   * `personIds` is REQUIRED and must be an array. Not optional-with-a-default: the whole defect
   * this closes was a caller that never mentioned the people, and a field with a default is a
   * field a caller can keep forgetting.
   */
  app.post('/board-games/plays', async (c) => {
    try {
      const body = await readBody(c);
      const gameId = typeof body.gameId === 'string' ? body.gameId : '';
      if (gameId === '') return c.json({ error: 'gameId required' }, 400);
      if (!getBoardGame(gameId)) return c.json({ error: 'no such game' }, 404);

      if (!Array.isArray(body.personIds)) {
        return c.json({ error: 'personIds[] required — say [] for a table nobody named' }, 400);
      }
      const personIds = body.personIds.map(String);

      // A person id that resolves to nobody would write a row no screen can ever paint beside
      // a name, which is the one failure the whole people package is shaped around.
      const roster = new Set(listPeople().map((person) => person.id));
      const unknown = personIds.filter((id) => !roster.has(id));
      if (unknown.length > 0) {
        return c.json({ error: `not on the roster: ${unknown.join(', ')}` }, 400);
      }

      const play = logBoardGamePlay({
        gameId,
        notes: typeof body.notes === 'string' ? body.notes : null,
        personIds,
        ...(typeof body.playedAt === 'string' ? { playedAt: body.playedAt } : {}),
      });

      return c.json({
        knownHow: knownHowClaims(gameId),
        play: { ...play, personIds: play.playerIds },
      });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  /**
   * Tick or untick ONE person against ONE game. Body: `{personId, isKnown}`.
   *
   * `isKnown: false` is what the finish screen's undo runs, and it is also "I have forgotten
   * this one" on a stale claim. Same call either way — the screen knows which it meant.
   */
  app.post('/board-games/:id/known', async (c) => {
    try {
      const gameId = c.req.param('id');
      if (!getBoardGame(gameId)) return c.json({ error: 'no such game' }, 404);

      const body = await readBody(c);
      const personId = typeof body.personId === 'string' ? body.personId : '';
      if (personId === '') return c.json({ error: 'personId required' }, 400);
      if (!listPeople().some((person) => person.id === personId)) {
        return c.json({ error: `not on the roster: ${personId}` }, 400);
      }

      setBoardGameKnownHow({ gameId, isKnown: body.isKnown === true, personId });
      return c.json({ knownHow: knownHowClaims(gameId) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 500);
    }
  });

  return app;
}

/** The claims about one game, in the wire's own vocabulary. */
const knownHowClaims = (
  gameId: string,
): { confirmedAt: string; gameId: string; personId: string }[] =>
  knownHowForGame(gameId).map((claim) => ({
    confirmedAt: claim.confirmedAt,
    gameId: claim.gameId,
    personId: claim.playerId,
  }));

export type BoardGameCard = {
  bestWith: number[];
  id: string;
  imagePath: string | null;
  interactionTypes: Game['interactionTypes'];
  isExcluded: boolean;
  lastPlayedAt: string | null;
  maxPlayers: number;
  maxPlaytime: number | null;
  minPlayers: number;
  minPlaytime: number | null;
  name: string;
  ownerCategories: string[];
  playCount: number;
  playedBy: string[];
  weight: number | null;
};

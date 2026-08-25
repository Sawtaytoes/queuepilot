// MATCH EACH TITLE TO ITS RULEBOOK IN KAVITA.
//
// The third nightly step. It writes `board_game_links` rows with `source = 'derived'`, so a
// link somebody typed by hand (`source = 'owner'`) is never touched — see `replaceDerivedLinks`.
//
// ── Why box labels are matched as well as titles ─────────────────────────────────────────
//
// A rulebook is filed under the name printed on the BOX. Once several boxes have been collapsed
// into one title, the box label is the only place that name still exists — so matching titles
// alone loses the rulebook for every merged franchise on the shelf.
//
// ── One link per title, and it says "Rulebook" ───────────────────────────────────────────
//
// Every series in this library is already the title's own name plus filing noise, so a label
// built from it repeats the heading it sits under: three links reading "Rulebook — <Title>",
// "Rulebook — <Title> - Missions - Rulebook (" and so on are a wall of the same words, with the
// library's own truncated names and unclosed parenthesis on show.
//
// When several series resolve to one title, the library has filed the same game twice or split
// a manual out of it. The EXACT title match is the game's own shelf and wins; with no exact
// match the shortest name is the most general one, and a stable id breaks any remaining tie so
// a re-run never shuffles the link.
import { listBoxLabels, listLinkableGames } from '../../store/db/boardgameEnrich.js';
import { replaceDerivedLinks } from '../../store/db/boardgameSync.js';
import { authenticate, kavitaConfigFromEnv, listSeries, seriesUrl } from '../links/kavita.js';
import { matchTitle, type MatchTarget } from '../links/match.js';
import { failed, skipped, type CollectionJobResult, type OnProgress } from './types.js';

interface Book {
  confidence: 'exact' | 'prefix';
  id: number;
  name: string;
}

/** The tie-break, said as a function because it is the only judgement in this file. */
const pickOne = (books: Book[]): Book | undefined =>
  [...books].sort(
    (a, b) =>
      Number(b.confidence === 'exact') - Number(a.confidence === 'exact') ||
      a.name.length - b.name.length ||
      a.id - b.id,
  )[0];

export async function runLinkRulebooks(
  { isDryRun = false }: { isDryRun?: boolean } = {},
  onProgress: OnProgress = () => {},
): Promise<CollectionJobResult> {
  const config = kavitaConfigFromEnv();
  if (config === null) {
    return skipped(
      'link-rulebooks',
      'no Kavita configured — set KAVITA_URL and a Kavita API key to link rulebooks',
    );
  }

  try {
    const games = listLinkableGames();
    const targets: MatchTarget[] = [
      ...games.map((game) => ({ gameId: game.id, name: game.name })),
      ...listBoxLabels().map((box) => ({ gameId: box.gameId, name: box.label })),
    ];

    onProgress(`reading ${config.baseUrl} library ${config.libraryId}…`);
    const token = await authenticate(config);
    const series = await listSeries(config, token);
    onProgress(`${series.length} series · ${games.length} title(s)`);

    const matched = new Map<string, Book[]>();
    let exact = 0;
    let prefix = 0;

    for (const one of series) {
      const match = matchTitle(one.name, targets);
      if (match.gameId === null) continue;

      // A resolved match is one of exactly two things — `ambiguous` and `none` both leave
      // `gameId` null. Said as a value rather than left to the reader, because it is what the
      // tie-break sorts on.
      const confidence = match.confidence === 'exact' ? 'exact' : 'prefix';
      if (confidence === 'exact') exact += 1;
      else prefix += 1;

      matched.set(match.gameId, [
        ...(matched.get(match.gameId) ?? []),
        { confidence, id: one.id, name: one.name },
      ]);
    }

    if (!isDryRun) {
      for (const [gameId, books] of matched) {
        const book = pickOne(books);
        if (!book) continue;
        replaceDerivedLinks(gameId, 'rulebook', [
          { label: 'Rulebook', url: seriesUrl(config, book.id) },
        ]);
      }
    }

    return {
      counts: {
        exact,
        linked: matched.size,
        prefix,
        without: games.length - matched.size,
        series: series.length,
      },
      isOk: true,
      isSkipped: false,
      name: 'link-rulebooks',
      summary:
        `${matched.size} title(s) linked (${exact} exact, ${prefix} by prefix); ` +
        `${games.length - matched.size} without one` +
        (isDryRun ? ' — DRY RUN, nothing written' : ''),
    };
  } catch (error) {
    return failed('link-rulebooks', error);
  }
}

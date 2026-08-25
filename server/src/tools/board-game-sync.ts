// THE COLLECTION JOBS, FROM A TERMINAL.
//
//   server/node_modules/.bin/tsx server/src/tools/board-game-sync.ts <step> [options]
//
//   Steps
//     all              sync-bgg, then enrich, then link-rulebooks, then link-videos.
//                      The same four the nightly runs, in the same order.
//     sync-bgg         pull the collection from the upstream and reconcile it
//     enrich           mechanics, categories, publishers and box art
//     link-rulebooks   match each title to its rulebook in Kavita
//     link-videos      find one how-to-play video per title
//     import-csv <path>  seed the collection from a collection CSV export
//
//   Options
//     --limit <n>   stop after n titles (enrich, link-videos)
//     --force       re-fetch even when the cache has an answer
//     --dry-run     work it out and write nothing (link-rulebooks, link-videos)
//
// ── WHY THIS EXISTS WHEN THE NIGHTLY ALREADY DOES IT ─────────────────────────────────────
//
// The scheduled path is MQTT and it is the one that matters. This is for the times somebody is
// already in a terminal: running ONE step, running it with `--limit 5` to see what it would do,
// or running the CSV import, which is not part of the nightly at all and cannot be — it takes a
// file path, and that file is somebody's own collection export and lives outside this repo.
//
// A step nobody has configured prints how to configure it and exits 0. That is not a failure:
// none of these integrations is required.
import { readFileSync } from 'node:fs';

import { runCollectionSync } from '../boardgames/jobs/collectionSync.js';
import { runEnrich } from '../boardgames/jobs/enrich.js';
import { runLinkRulebooks } from '../boardgames/jobs/linkRulebooks.js';
import { runLinkVideos } from '../boardgames/jobs/linkVideos.js';
import { runSyncBgg } from '../boardgames/jobs/syncBgg.js';
import type { CollectionJobResult } from '../boardgames/jobs/types.js';
import { parseCsvRecords, readCsvRow } from '../boardgames/import/csv.js';
import { importBoardGameRows } from '../store/db/boardgameImport.js';

const argv = process.argv.slice(2);
const step = argv[0] ?? '';
const say = (message: string): void => {
  console.log(message);
};

const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const limit = Number(flag('limit') ?? Number.POSITIVE_INFINITY);
const isForced = has('force');
const isDryRun = has('dry-run');

const report = (result: CollectionJobResult): number => {
  say(`\n${result.name}: ${result.isSkipped ? 'skipped' : result.isOk ? 'ok' : 'FAILED'}`);
  say(`  ${result.summary}`);
  for (const [key, value] of Object.entries(result.counts ?? {})) {
    say(`  ${key.padEnd(14)} ${value}`);
  }
  return result.isOk ? 0 : 1;
};

async function main(): Promise<number> {
  switch (step) {
    case 'all': {
      const result = await runCollectionSync(say);
      say('');
      for (const one of result.steps) report(one);
      return result.isOk ? 0 : 1;
    }
    case 'sync-bgg':
      return report(await runSyncBgg(say));
    case 'enrich':
      return report(await runEnrich({ isForced, limit }, say));
    case 'link-rulebooks':
      return report(await runLinkRulebooks({ isDryRun }, say));
    case 'link-videos':
      return report(await runLinkVideos({ isDryRun, isForced, limit }, say));
    case 'import-csv': {
      const path = argv[1];
      if (!path || path.startsWith('--')) {
        say('usage: board-game-sync.ts import-csv <collection.csv>');
        say('');
        say('The CSV is a collection export. It is somebody’s own data: keep it out of');
        say('this repo, which is public.');
        return 1;
      }
      const rows = parseCsvRecords(readFileSync(path, 'utf8'))
        .filter((record) => record.own === '1')
        .map(readCsvRow);
      const stats = importBoardGameRows(rows);
      say(`rows read            ${stats.rowsRead}`);
      say(`titles               ${stats.games}`);
      say(`boxes                ${stats.boxes}`);
      say('');
      say('Gaps you will feel while picking:');
      say(`  no complexity      ${stats.gamesWithoutWeight}`);
      say(`  no count votes     ${stats.gamesWithoutPlayerCountVotes}`);
      say(`  untagged co-op/vs  ${stats.gamesWithUntaggedInteraction}`);
      say('');
      say(`Needs a human call: ${stats.reviews.length}`);
      say('');
      say('Run `enrich` for art on anything new, then `link-rulebooks` / `link-videos`.');
      return 0;
    }
    default:
      say('usage: board-game-sync.ts <all|sync-bgg|enrich|link-rulebooks|link-videos|import-csv>');
      say('       [--limit N] [--force] [--dry-run]');
      return step === '' ? 0 : 1;
  }
}

process.exit(await main());

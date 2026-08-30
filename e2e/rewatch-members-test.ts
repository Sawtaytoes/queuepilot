// Manual members on a Movies Rules queue must join the rewatch candidates. The UI used to
// hide the Members editor for rewatch queues, and the playback branch ignored `members` too;
// removing only the UI gate would have saved a movie which could never play.
//
// Hermetic: direct ratingKey members need only one metadata lookup each. The fake client also
// includes a show member to pin the movie-only boundary — rewatch exclusions address movie
// leaves, not a show's parent key.
import assert from 'node:assert/strict';
import type {
  EngineBinding,
  PlexClient,
  RoutingRotationCfg,
} from '../server/src/types.js';
import { mergeManualMoviesIntoRewatch } from '../server/src/engine/rotation.js';

const metadata: Record<string, { type: string; title: string }> = {
  '10': { type: 'movie', title: 'Outside the Rule' },
  '20': { type: 'movie', title: 'Already in the Rule' },
  '30': { type: 'show', title: 'Not a Movie Leaf' },
};

const client = {
  async accountToken() { return null; },
  async container(path: string) {
    const match = /^\/library\/metadata\/(\d+)$/.exec(path);
    if (!match) throw new Error(`unexpected path ${path}`);
    const item = metadata[match[1]!];
    return { Metadata: item ? [{ ratingKey: match[1], ...item }] : [] };
  },
} as unknown as PlexClient;

const binding: EngineBinding = {
  plex_user: null,
  account_id: null,
  user_uuid: null,
  allowed_ratings: null,
  movie_ratings: null,
  watch_count_accounts: null,
  movie_excludes: ['10', '99'],
};

const cfg = {
  members: [
    { ratingKey: '10', title: 'Outside the Rule', weight: 3 },
    { ratingKey: '20', title: 'Already in the Rule', weight: 2 },
    { ratingKey: '30', title: 'Not a Movie Leaf' },
  ],
} as unknown as RoutingRotationCfg;

const counts = new Map<string, number>([['20', 5]]);
const titles = new Map<string, string | undefined>([['20', 'History Title']]);
const excludes = new Set(binding.movie_excludes);
const weights = await mergeManualMoviesIntoRewatch(
  client,
  cfg,
  binding,
  counts,
  titles,
  excludes,
  { '99': 4 },
);

assert.deepEqual([...counts.entries()].sort(), [['10', 1], ['20', 5]]);
console.log('PASS a movie outside the rule joins at the least-watched floor');

assert.equal(titles.get('10'), 'Outside the Rule');
assert.equal(titles.get('20'), 'History Title');
console.log('PASS a real rule title and count win when the movie is already eligible');

assert.deepEqual([...excludes].sort(), ['99']);
console.log('PASS a manual include wins over an exclusion for the same movie');

assert.deepEqual(weights, { '10': 3, '20': 2, '99': 4 });
console.log('PASS member weights merge without dropping rule weights');

assert.equal(counts.has('30'), false);
console.log('PASS a show parent is not inserted as a rewatch movie leaf');


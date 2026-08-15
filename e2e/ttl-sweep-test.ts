// §B.3 Node mirror test — the completed-entry TTL sweep in server/src/queues.js.
//
// session.js runs the sweep on every scan; this pins the rule it runs — what a done entry's
// done_at means: parseDuration parses the window, entryDoneAt reads the stamp, and
// sweepCompleted removes ONLY past-TTL done entries, honours the never/0 disable, and exempts
// keep_completed / reel sets. Imports the real module against a temp QUEUES_PATH.
//
// Run standalone: server/node_modules/.bin/tsx e2e/ttl-sweep-test.ts   (non-zero on failure)
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const QUEUES_PATH = '/tmp/ttl-queues.yaml';
process.env.QUEUES_PATH = QUEUES_PATH;

let failures = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const read = () => readFileSync(QUEUES_PATH, 'utf8');

// Fixed clock (epoch seconds) so the fixtures are deterministic.
const NOW = 1_000_000_000;
const OLD = NOW - 100_000; // ~27.7h ago: past a 24h TTL
const RECENT = NOW - 60; // a minute ago: within 24h
const FIXTURE = `bob:
  - {title: "Old Done", done: true, done_at: ${OLD}}
  - {title: "Recent Done", done: true, done_at: ${RECENT}}
  - {title: "Legacy Done", done: true}
  - "Active Movie"
`;

function seed() {
  for (const f of [QUEUES_PATH, `${QUEUES_PATH}.lock`, `${QUEUES_PATH}.tmp`]) {
    rmSync(f, { force: true, recursive: true });
  }
  writeFileSync(QUEUES_PATH, FIXTURE);
}

const q = await import('../server/src/queues.js');

// --- parseDuration mirrors the Python parser --------------------------------- //
ok('parseDuration 24h -> 86400', q.parseDuration('24h') === 86400);
ok('parseDuration 7d -> 604800', q.parseDuration('7d') === 604800);
ok('parseDuration 90m -> 5400', q.parseDuration('90m') === 5400);
ok('parseDuration bare number -> seconds', q.parseDuration('45') === 45);
ok('parseDuration 0 -> disabled', q.parseDuration('0') === null);
ok('parseDuration never -> disabled', q.parseDuration('never') === null);
ok('parseDuration blank -> disabled', q.parseDuration('') === null);
ok('parseDuration junk -> disabled', q.parseDuration('soon') === null);

// --- entryDoneAt reads the stamp --------------------------------------------- //
ok('entryDoneAt reads a numeric stamp', q.entryDoneAt({ done: true, done_at: OLD }) === OLD);
ok('entryDoneAt of a stampless done entry -> null', q.entryDoneAt({ done: true }) === null);
ok('entryDoneAt of a scalar entry -> null', q.entryDoneAt('Active Movie') === null);

const keys = async (): Promise<string[]> => (await q.listSet('bob')).map((e) => e.key);

// --- default is keep-forever (opt-in) ---------------------------------------- //
seed();
let res = await q.sweepCompleted('bob', { now: NOW }); // no override -> default 'never'
ok('default (no override) keeps everything — no sweep', res.removed === 0, `removed=${res.removed}`);
ok('default: past-TTL done entry survives', (await keys()).includes('title:Old Done'));

// --- opt-in window removes ONLY past-TTL done entries ------------------------ //
seed();
res = await q.sweepCompleted('bob', { removeCompletedAfter: '24h', now: NOW });
ok('opt-in removed exactly one entry', res.removed === 1, `removed=${res.removed}`);
let ks = await keys();
ok('opt-in removed the past-TTL done entry', !ks.includes('title:Old Done'));
ok('opt-in kept the recent done entry', ks.includes('title:Recent Done'));
ok('opt-in kept the timestamp-less done entry', ks.includes('title:Legacy Done'));
ok('opt-in kept the active (not-done) entry', ks.includes('title:Active Movie'));

// --- never / 0 disables ------------------------------------------------------ //
seed();
res = await q.sweepCompleted('bob', { removeCompletedAfter: 'never', now: NOW });
ok('never disables the sweep', res.removed === 0);
ok('never: past-TTL done entry survives', (await keys()).includes('title:Old Done'));

seed();
res = await q.sweepCompleted('bob', { removeCompletedAfter: '0', now: NOW });
ok('0 disables the sweep', res.removed === 0);
ok('0: past-TTL done entry survives', (await keys()).includes('title:Old Done'));

// --- keep_completed / reel exempt the set (even with a window set) ------------ //
seed();
res = await q.sweepCompleted('bob', { keepCompleted: true, removeCompletedAfter: '24h', now: NOW });
ok('keepCompleted exempts the set', res.removed === 0);
ok('keepCompleted: past-TTL done entry survives', (await keys()).includes('title:Old Done'));

seed();
res = await q.sweepCompleted('bob', { reel: true, removeCompletedAfter: '24h', now: NOW });
ok('reel exempts the set', res.removed === 0);
ok('reel: past-TTL done entry survives', (await keys()).includes('title:Old Done'));

// --- per-set override tightens the window ------------------------------------ //
seed();
res = await q.sweepCompleted('bob', { removeCompletedAfter: '30s', now: NOW });
ks = await keys();
ok('tight window sweeps the recent done entry too',
  res.removed === 2 && !ks.includes('title:Recent Done') && ks.includes('title:Active Movie'));

// A still-populated list must stay a block list (not collapse to flow `[ ... ]`) after a sweep.
ok('kept entries stay a block list', /bob:\n- /.test(read()) && !/bob:\s*\[/.test(read()));

rmSync(QUEUES_PATH, { force: true });
rmSync(`${QUEUES_PATH}.lock`, { force: true, recursive: true });

console.log(failures ? `\n${failures} sweep assertion(s) failed` : '\nall TTL sweep assertions passed');
process.exit(failures ? 1 : 0);

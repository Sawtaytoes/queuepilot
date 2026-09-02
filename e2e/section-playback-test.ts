// PLAYING A SECTION — start at `start.position_ms`, stop at `end.position_ms`, then advance.
//
// The case the old design could not represent AT ALL is the one this harness is built around:
// TWO SECTIONS OF ONE FILE IN ONE LINEUP. A `Map<ratingKey, ms>` physically cannot hold two
// different starts for one file, and a `Set<ratingKey>` of already-considered items answers
// "already considered" for the second occurrence and never seeks it. Both are reachable in
// production since #300, so both are pinned here rather than argued about.
//
// Everything runs offline: a hand-built container client, no Plex, no player, no broker, no
// browser. The watcher under test is the REAL `resume.startWatch()` — the real interval, the
// real one-shot bookkeeping, the real retry decision — driven through its injected seams.
//
// Run:  server/node_modules/.bin/tsx e2e/section-playback-test.ts   (from the repo root)
process.env.PLEX_API_SERVER_URL = 'http://plex.invalid:32400';
process.env.PLEX_TOKEN = 'test-token';
process.env.RESUME_MIN_MS = '30000';
process.env.RESUME_MAX_FRACTION = '0.95';
process.env.RESUME_START_WINDOW_MS = '120000';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type { PlexClient } from '../server/src/types.js';

const SCRATCH = mkdtempSync(nodePath.join(tmpdir(), 'section-playback-'));
const SETS_PATH = nodePath.join(SCRATCH, 'sets.yaml');
const QUEUES_PATH = nodePath.join(SCRATCH, 'queues.yaml');
process.env.SETS_PATH = SETS_PATH;
process.env.QUEUES_PATH = QUEUES_PATH;
process.env.CACHE_PATH = nodePath.join(SCRATCH, 'cache.sqlite');

// INVENTED fixtures. This repo is public: nothing here names a real film, a real library or a
// real person (AGENTS.md, "This repo is PUBLIC on GitHub").
writeFileSync(
  SETS_PATH,
  'sets:\n  - id: reelqueue\n    label: Reel Queue\n    source: queue\n    sections: [1]\n',
);
// The demo-reel shape: the same film twice, at two different places in it, plus a show entry
// that contributes two episodes so the FIRST-UNIT rule has something to be wrong about.
writeFileSync(QUEUES_PATH, [
  'reelqueue:',
  '  - {ratingKey: 1001, title: A Loud Film, start: {position_ms: 3660000}, end: {position_ms: 3960000}}',
  '  - {id: 8f3a2c, ratingKey: 1001, title: A Loud Film, start: {position_ms: 5400000}, end: {position_ms: 5520000}}',
  '  - {ratingKey: 2002, title: A Long Show, episodes: 2, start: {position_ms: 750000}, end: {position_ms: 1020000}}',
  '',
].join('\n'));

const FAILS: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && detail ? `  -- ${detail}` : ''));
  if (!cond) FAILS.push(name);
}

const resolve = await import('../server/src/engine/resolve.js');
const section = await import('../server/src/section.js');
const resume = await import('../server/src/resume.js');

// --------------------------------------------------------------------------- //
// 1. The window reaches the lineup, on the FIRST played unit and nothing after it
// --------------------------------------------------------------------------- //

const FILM_MS = 7_200_000; // two hours
const EPISODE_MS = 1_400_000;

const client: PlexClient = {
  async container(path) {
    const leaves = path.match(/\/library\/metadata\/([^/?]+)\/allLeaves/);
    if (leaves) {
      return {
        Metadata: [1, 2, 3].map((n) => ({
          ratingKey: `2002-e${n}`,
          title: `Episode ${n}`,
          grandparentTitle: 'A Long Show',
          parentIndex: 1,
          index: n,
          duration: EPISODE_MS,
          type: 'episode',
          viewCount: 0,
          viewOffset: 0,
        })),
      };
    }
    const meta = path.match(/\/library\/metadata\/([^/?]+)$/);
    if (meta) {
      const rk = meta[1]!;
      return {
        Metadata: [{
          ratingKey: rk,
          title: rk === '2002' ? 'A Long Show' : 'A Loud Film',
          type: rk === '2002' ? 'show' : 'movie',
          duration: rk === '2002' ? EPISODE_MS : FILM_MS,
          viewOffset: 0,
          viewCount: 0,
        }],
      };
    }
    return { Metadata: [] };
  },
  async accountToken() { return null; },
};

// `length: 4` so the whole lineup is built — the ordered default is ONE entry per sitting, and
// this feature is only interesting once a lineup holds more than one line. `watch_history:
// queue` because a section's completion lands in the queue's OWN ledger (Plex has nowhere to
// put a second position for one file), which is also what stamps `queueEntryKey` on the items.
const CFG = {
  kind: 'movie',
  source: 'queue',
  queue_sections: [1],
  sections: [1],
  length: 4,
  watch_history: 'queue',
};
const entries = resolve.loadEntries('reelqueue');

ok('the two lines of the same file key apart (an `id:` on the second)',
  entries.length === 3 && entries[0]!.key === 'rk:1001' && entries[1]!.key === 'id:8f3a2c',
  JSON.stringify(entries.map((e) => e.key)));

const built = await resolve.nextQueue(
  client, 'reelqueue', CFG, entries, new Set<string>(), null, null,
);
const windows = built.play.map((it) => [it.ratingKey, it.sectionStartMs ?? null, it.sectionEndMs ?? null]);

ok('the SAME file appears twice with DIFFERENT windows',
  JSON.stringify(windows.slice(0, 2))
    === JSON.stringify([['1001', 3_660_000, 3_960_000], ['1001', 5_400_000, 5_520_000]]),
  JSON.stringify(windows));

// The rule the decision record states and the code has to say too.
const episodes = built.play.filter((it) => String(it.ratingKey).startsWith('2002-'));
ok('an entry contributing two episodes windows only the FIRST',
  episodes.length === 2
  && episodes[0]!.sectionStartMs === 750_000 && episodes[0]!.sectionEndMs === 1_020_000
  && episodes[1]!.sectionStartMs == null && episodes[1]!.sectionEndMs == null,
  JSON.stringify(episodes.map((e) => [e.ratingKey, e.sectionStartMs, e.sectionEndMs])));

// --------------------------------------------------------------------------- //
// 2. The HEAD's start is free, and it OUTRANKS a resume marker
// --------------------------------------------------------------------------- //

ok('a section start beats an inferred resume marker on the head',
  section.headStartOffsetMs({ sectionStartMs: 3_660_000 }, 900_000, { playsSections: true })
    === 3_660_000);
ok('…and beats the queue-owned ledger position too — the KIND of fact is what wins',
  section.headStartOffsetMs({ sectionStartMs: 12_000 }, 2_600_000, { playsSections: true })
    === 12_000);
ok('an `end` with no `start` plays from the BEGINNING, not from the marker',
  section.headStartOffsetMs({ sectionEndMs: 90_000 }, 900_000, { playsSections: true }) === 0);
ok('no window at all leaves the resume marker exactly as it was',
  section.headStartOffsetMs({}, 900_000, { playsSections: true }) === 900_000);
ok('an empty head is the resume marker',
  section.headStartOffsetMs(null, 900_000, { playsSections: true }) === 900_000);

// THE CAPABILITY GUARD. A section on a provider that cannot serve one must never reach the
// playback path — not as an offset, and not as a plan.
ok('a provider that cannot play sections gets the resume marker, never the section',
  section.headStartOffsetMs({ sectionStartMs: 3_660_000 }, 900_000, { playsSections: false })
    === 900_000);
ok('…and no plan is built for it at all',
  section.sectionPlan(built.play, { playsSections: false }).size === 0);

const providers = await import('../server/src/providers/config.js');
ok('Plex is the only kind that declares the capability',
  providers.playsSectionsForKind('plex') === true
  && ['kavita', 'board-game', 'steam', 'mister'].every((k) => providers.playsSectionsForKind(k) === false),
  ['plex', 'kavita', 'board-game', 'steam', 'mister']
    .map((k) => `${k}=${providers.playsSectionsForKind(k)}`).join(' '));

// --------------------------------------------------------------------------- //
// 3. The plan is keyed by INDEX, which is the whole point
// --------------------------------------------------------------------------- //

const plan = section.sectionPlan(built.play, { isHeadStartApplied: true });

ok('the plan is keyed by playQueue index, not by ratingKey',
  [...plan.keys()].join(',') === '0,1,2', [...plan.keys()].join(','));
ok('both occurrences of the file survive, with their own ends',
  plan.get(0)?.endMs === 3_960_000 && plan.get(1)?.endMs === 5_520_000,
  JSON.stringify([plan.get(0)?.endMs, plan.get(1)?.endMs]));
ok('the HEAD needs no start seek — playMedia\'s offset already carried it',
  plan.get(0)?.startMs === null && plan.get(0)?.isStartDone === true,
  JSON.stringify(plan.get(0)));
ok('…but the second occurrence still has to be seeked',
  plan.get(1)?.startMs === 5_400_000, String(plan.get(1)?.startMs));
ok('each row carries the LINE it came from, not just the file',
  plan.get(0)?.entryKey === 'rk:1001' && plan.get(1)?.entryKey === 'id:8f3a2c',
  JSON.stringify([plan.get(0)?.entryKey, plan.get(1)?.entryKey]));

// The equivalent resume plan, for contrast — this is the shape that could not do the job.
const asResume = new Map<string, number>();
for (const it of built.play) {
  if (it.sectionStartMs != null) asResume.set(String(it.ratingKey), it.sectionStartMs);
}
ok('a ratingKey-keyed plan would have LOST one of the two windows',
  asResume.size === 2 && asResume.get('1001') === 5_400_000,
  `${asResume.size} row(s), rk 1001 -> ${asResume.get('1001')}`);

// A window past the item's real runtime, at either end.
const silly = section.sectionPlan([
  { ratingKey: '3003', duration: 600_000, sectionStartMs: 900_000, sectionEndMs: 950_000 },
  { ratingKey: '3004', duration: 600_000, sectionStartMs: 60_000, sectionEndMs: 900_000 },
  { ratingKey: '3005', duration: 0, sectionStartMs: 60_000, sectionEndMs: 900_000 },
]);
ok('a start AND an end both past the runtime drop the row entirely',
  !silly.has(0), JSON.stringify(silly.get(0)));
ok('an end past the runtime plays to the natural end, keeping the start',
  silly.get(1)?.startMs === 60_000 && silly.get(1)?.endMs === null,
  JSON.stringify(silly.get(1)));
ok('an unknown duration keeps the window exactly as written',
  silly.get(2)?.startMs === 60_000 && silly.get(2)?.endMs === 900_000,
  JSON.stringify(silly.get(2)));

// --------------------------------------------------------------------------- //
// 4. `consider()` — start, wait, stop, and refusing to guess
// --------------------------------------------------------------------------- //

const place = (index: number) => ({ index, ratingKeys: ['1001', '1001', '2002-e1', '2002-e2'] });

section.arm({ plan: section.sectionPlan(built.play, { isHeadStartApplied: true }), setName: 'reelqueue' });

let d = section.consider({ ratingKey: '1001', viewOffset: 3_670_000 }, place(0));
ok('the head is already at its start, so the read is a WAIT on the end mark',
  d.action === 'wait' && d.dueInMs === 290_000, JSON.stringify(d));

d = section.consider({ ratingKey: '1001', viewOffset: 3_965_000 }, place(0));
ok('past the end mark, the decision is NEXT', d.action === 'next' && d.index === 0, JSON.stringify(d));

// Now the SECOND occurrence of the same file. The whole reason the index exists.
d = section.consider({ ratingKey: '1001', viewOffset: 1_000 }, place(1));
ok('the second occurrence seeks to its OWN start, not the first one\'s',
  d.action === 'seek' && d.ms === 5_400_000 && d.index === 1, JSON.stringify(d));
d = section.consider({ ratingKey: '1001', viewOffset: 5_410_000 }, place(1));
ok('…then waits for its OWN end mark',
  d.action === 'wait' && d.dueInMs === 110_000, JSON.stringify(d));
d = section.consider({ ratingKey: '1001', viewOffset: 5_530_000 }, place(1));
ok('…and stops there', d.action === 'next' && d.index === 1, JSON.stringify(d));

// Ambiguity: two pending windows for one file and no usable index.
section.arm({ plan: section.sectionPlan(built.play, { isHeadStartApplied: true }), setName: 'reelqueue' });
d = section.consider({ ratingKey: '1001', viewOffset: 1_000 }, null);
ok('two windows on one file with NO index declines rather than guessing',
  d.action === 'none' && d.retry === true, JSON.stringify(d));
ok('…and says which item it could not place', String(d.reason).includes('1001'), d.reason);

// A live playQueue that disagrees with the plan's index is not trusted.
d = section.consider(
  { ratingKey: '1001', viewOffset: 1_000 },
  { index: 1, ratingKeys: ['9999', '7777', '1001'] },
);
ok('an index whose live playQueue holds a DIFFERENT file is refused',
  d.action === 'none' && d.retry === true, JSON.stringify(d));

// The unambiguous case never needs an index at all.
section.arm({
  plan: section.sectionPlan(
    [{ ratingKey: '4004', duration: 600_000, sectionStartMs: 12_000, sectionEndMs: 90_000 }],
  ),
  setName: 'reelqueue',
});
ok('one window on one file is NOT ambiguous, so no playQueue read is needed',
  section.isAmbiguous('4004') === false);
d = section.consider({ ratingKey: '4004', viewOffset: 0 }, null);
ok('…and it seeks with no index at all', d.action === 'seek' && d.ms === 12_000, JSON.stringify(d));

// RESUME_MIN_MS is 30 000 ms and this section starts at 0:12. A resume plan would have dropped
// it; an authored one must not.
ok('a 12-second section start is honoured where a 12-second resume marker would be dropped',
  resume.resumePlan([{ ratingKey: '4004', viewOffset: 12_000, viewCount: 0, duration: 600_000 }],
    { headRatingKey: null }).size === 0);

// A closing-gag section (past RESUME_MAX_FRACTION) and a section of an already-watched film.
const lateAndWatched = section.sectionPlan([
  { ratingKey: '5005', duration: 600_000, sectionStartMs: 588_000 },
  { ratingKey: '5006', duration: 600_000, sectionStartMs: 60_000, sectionEndMs: 90_000 },
]);
ok('a closing-gag section survives, where a 98% resume marker would be dropped',
  lateAndWatched.get(0)?.startMs === 588_000, JSON.stringify(lateAndWatched.get(0)));
ok('…and a section of a film already watched survives too (viewCount is not consulted)',
  lateAndWatched.get(1)?.startMs === 60_000, JSON.stringify(lateAndWatched.get(1)));

// A viewer who is genuinely past the start is not yanked backwards — but a STALE reading at
// the transition must not consume the window either.
section.arm({
  plan: section.sectionPlan(
    [{ ratingKey: '4004', duration: 600_000, sectionStartMs: 12_000, sectionEndMs: 90_000 }],
  ),
  setName: 'reelqueue',
});
d = section.consider({ ratingKey: '4004', viewOffset: 300_000 }, null);
ok('a reading past the section start declines, and is RETRYABLE',
  d.action === 'none' && d.retry === true, JSON.stringify(d));
d = section.consider({ ratingKey: '4004', viewOffset: 500 }, null);
ok('…so the settled reading on the next read still seeks',
  d.action === 'seek' && d.ms === 12_000, JSON.stringify(d));

section.arm({
  plan: section.sectionPlan(
    [{ ratingKey: '4004', duration: 600_000, sectionStartMs: 12_000 }],
  ),
  setName: 'reelqueue',
});
for (let i = 0; i < 20; i += 1) section.consider({ ratingKey: '4004', viewOffset: 300_000 }, null);
ok('a viewer who really is past the start is given up on, not fought forever',
  section.pendingCount() === 0, `${section.pendingCount()} pending`);

// A window the player has moved past cannot hold the watcher open.
section.arm({ plan: section.sectionPlan(built.play, { isHeadStartApplied: true }), setName: 'reelqueue' });
section.consider({ ratingKey: '2002-e1', viewOffset: 760_000 }, place(2));
ok('landing on a LATER index retires the windows the player has already passed',
  section.pendingCount() === 1, `${section.pendingCount()} pending`);

// --------------------------------------------------------------------------- //
// 5. The real watcher, driving both plans through one loop
// --------------------------------------------------------------------------- //

interface Run {
  seeks: number[];
  advances: number;
  places: number;
  lines: string[];
}

const runWatcher = async (
  feed: () => { ratingKey: string; viewOffset: number },
  { placeAt = null, resumePlan = new Map<string, number>(), forMs = 120 }: {
    placeAt?: (() => { index: number; ratingKeys: string[] }) | null;
    resumePlan?: Map<string, number>;
    forMs?: number;
  } = {},
): Promise<Run> => {
  const run: Run = { seeks: [], advances: 0, places: 0, lines: [] };
  resume.arm({ plan: resumePlan, device: null, setName: 'reelqueue' });
  resume.startWatch({
    fetchSession: async () => feed(),
    seek: async (ms) => { run.seeks.push(ms); return { seeked: true }; },
    advance: async () => { run.advances += 1; return { ok: true }; },
    fetchPlace: placeAt ? async () => { run.places += 1; return placeAt(); } : null,
    intervalMs: 10,
    retryMs: 5,
    log: (line) => run.lines.push(line),
  });
  await new Promise((r) => { setTimeout(r, forMs); });
  resume.stopWatch();
  return run;
};

// THE HEADLINE CASE, end to end: two sections of one file, in one lineup, through one watcher.
section.arm({ plan: section.sectionPlan(built.play, { isHeadStartApplied: true }), setName: 'reelqueue' });
let stage = 0;
const script: { ratingKey: string; viewOffset: number; index: number }[] = [
  { ratingKey: '1001', viewOffset: 3_670_000, index: 0 }, // the head, mid-window
  { ratingKey: '1001', viewOffset: 3_965_000, index: 0 }, // past its end -> skipNext
  { ratingKey: '1001', viewOffset: 2_000, index: 1 }, // the SECOND section, at 0
  { ratingKey: '1001', viewOffset: 5_410_000, index: 1 }, // seeked, mid-window
  { ratingKey: '1001', viewOffset: 5_530_000, index: 1 }, // past its end -> skipNext
  { ratingKey: '2002-e1', viewOffset: 1_000, index: 2 }, // the show entry's first episode
  { ratingKey: '2002-e1', viewOffset: 760_000, index: 2 },
  { ratingKey: '2002-e1', viewOffset: 1_025_000, index: 2 }, // past its end -> skipNext
];
const two = await runWatcher(
  () => {
    const step = script[Math.min(stage, script.length - 1)]!;
    stage += 1;
    return { ratingKey: step.ratingKey, viewOffset: step.viewOffset };
  },
  {
    placeAt: () => {
      const step = script[Math.min(stage - 1, script.length - 1)]!;
      return { index: step.index, ratingKeys: ['1001', '1001', '2002-e1', '2002-e2'] };
    },
    forMs: 400,
  },
);

ok('two sections of ONE file each got their own start seek',
  JSON.stringify(two.seeks) === JSON.stringify([5_400_000, 750_000]), JSON.stringify(two.seeks));
ok('…and each stopped at its own end mark', two.advances === 3, `${two.advances} advance(s)`);
ok('the playQueue index was read, because the file was ambiguous',
  two.places > 0, `${two.places} read(s)`);
ok('the watcher stopped once every window was spent', resume.watching() === false);
ok('the log names the section path apart from the resume path',
  two.lines.some((l) => l.startsWith('[section]')), two.lines.slice(0, 3).join(' | '));

// One watcher, two plans, with the precedence the whole feature turns on.
section.arm({
  plan: section.sectionPlan(
    [{ ratingKey: '7007', duration: 600_000, sectionStartMs: 12_000 }],
  ),
  setName: 'reelqueue',
});
const both = await runWatcher(
  () => ({ ratingKey: '7007', viewOffset: 0 }),
  { resumePlan: new Map([['7007', 400_000]]), forMs: 100 },
);
ok('an AUTHORED section start outranks an INFERRED resume marker for the same item',
  JSON.stringify(both.seeks) === JSON.stringify([12_000]), JSON.stringify(both.seeks));

// …and an item the section plan does not name still gets its resume marker, through the same
// loop. One watcher must not mean one feature.
section.arm({ plan: new Map(), setName: 'reelqueue' });
const resumeOnly = await runWatcher(
  () => ({ ratingKey: '8008', viewOffset: 1_000 }),
  { resumePlan: new Map([['8008', 400_000]]), forMs: 100 },
);
ok('an item with no window still resumes, through the same watcher',
  JSON.stringify(resumeOnly.seeks) === JSON.stringify([400_000]), JSON.stringify(resumeOnly.seeks));

// No `advance` wired (a caller that only wants starts) must not throw or hang.
section.arm({
  plan: section.sectionPlan(
    [{ ratingKey: '9009', duration: 600_000, sectionEndMs: 90_000 }],
  ),
  setName: 'reelqueue',
});
resume.arm({ plan: new Map(), device: null, setName: 'reelqueue' });
const noAdvance: string[] = [];
resume.startWatch({
  fetchSession: async () => ({ ratingKey: '9009', viewOffset: 95_000 }),
  seek: async () => ({ seeked: true }),
  intervalMs: 10,
  log: (line) => noAdvance.push(line),
});
await new Promise((r) => { setTimeout(r, 60); });
resume.stopWatch();
ok('an end mark with no advance wired says so rather than failing silently',
  noAdvance.some((l) => l.includes('no advance was wired')), noAdvance.join(' | '));

// --------------------------------------------------------------------------- //
// 6. The boundary ledger — "the section stopped it" vs "the viewer did"
// --------------------------------------------------------------------------- //

section.forgetBoundaries();
section.arm({ plan: section.sectionPlan(built.play, { isHeadStartApplied: true }), setName: 'reelqueue' });
section.consider({ ratingKey: '1001', viewOffset: 3_965_000 }, place(0));
const claimed = section.takeBoundary('1001');
ok('firing the end mark records WHICH LINE was stopped',
  claimed?.entryKey === 'rk:1001' && claimed?.setName === 'reelqueue', JSON.stringify(claimed));
ok('a boundary is claimed ONCE — a later ordinary play takes the ordinary path',
  section.takeBoundary('1001') === null);
ok('an item nobody stopped has no boundary at all',
  section.takeBoundary('2002-e1') === null);

section.recordBoundary('1001', {
  entryKey: 'rk:1001', setName: 'reelqueue', isOwnHistory: true, now: () => 0,
});
ok('a boundary nobody claimed within the TTL is not claimable later',
  section.takeBoundary('1001', { now: () => 200_000 }) === null);

section.arm({ plan: section.sectionPlan(built.play, { isHeadStartApplied: true }), setName: 'reelqueue' });
ok('a windowed file is known as such, so no live position is saved against it',
  section.isWindowed('1001') === true && section.isWindowed('4004') === false);
section.consider({ ratingKey: '1001', viewOffset: 3_965_000 }, place(0));
ok('…and it stays windowed after the FIRST section completes, because a second is still to come',
  section.isWindowed('1001') === true);

section.disarm();
resume.disarm();

console.log(FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(', ')}` : '\nall green');
process.exit(FAILS.length ? 1 : 0);

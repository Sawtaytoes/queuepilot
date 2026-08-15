// Harness for driving the REAL server/src/session.js offline.
//
// Everything that would touch the world is swapped via module resolve hooks (see hooks.mjs):
//   * ./engine/plex-live.js  -> the synthetic-corpus replay client (e2e/fixtures/engine-corpus)
//   * ./driver.js            -> records driveToPlaying's arguments (ratingKeys, offset, profile)
//   * ./playback.js          -> records playRatingKeys, never touches a Shield
//   * ./profiles.js, ./adb.js -> scripted profile detection / picker
// The ENGINE, queues.js write-side and the selection engine stay REAL, so a test asserts on
// what the shipped code actually does, including what it writes back to queues.yaml.
import { registerHooks } from 'node:module';
import { isModule, specifierIs, moduleId } from './module-id.mjs';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const CORPUS = path.join(REPO, 'e2e', 'fixtures', 'engine-corpus');

// What the stubs recorded and what the test scripts. Reset per scenario.
export const SESSION_CTL = {
  drives: [],   // driveToPlaying({...}) arguments
  plays: [],    // playRatingKeys(keys, opts)
  states: [],   // _publishState payloads
  lastPlayed: [],
  profileTitle: null,     // what waitForProfile resolves to (null = nobody signed in)
  waitCalls: [],
  switchCalls: [],
  playResult: { queued: 1, played: true, mode: 'client', client: 'SHIELD' },
};

export function resetSession() {
  SESSION_CTL.drives = [];
  SESSION_CTL.plays = [];
  SESSION_CTL.states = [];
  SESSION_CTL.lastPlayed = [];
  SESSION_CTL.profileTitle = null;
  SESSION_CTL.waitCalls = [];
  SESSION_CTL.switchCalls = [];
  SESSION_CTL.playResult = { queued: 1, played: true, mode: 'client', client: 'SHIELD' };
}

const STUB_SRC = {
  './engine/plex-live.js': `
    import { replayClient } from '${new URL('../../server/src/engine/plex-replay.js', import.meta.url).href}';
    export const liveClient = () => replayClient(process.env.PLEX_REPLAY_DIR);
  `,
  './driver.js': `
    import { SESSION_CTL } from '${new URL('./session-harness.mjs', import.meta.url).href}';
    export function setPublishState() {}
    export async function driveToPlaying(_client, args) {
      SESSION_CTL.drives.push(args);
      return SESSION_CTL.playResult;
    }
  `,
  './playback.js': `
    import { SESSION_CTL } from '${new URL('./session-harness.mjs', import.meta.url).href}';
    export async function playRatingKeys(keys, opts = {}) {
      SESSION_CTL.plays.push({ keys: [...keys], ...opts });
      return SESSION_CTL.playResult;
    }
    export async function currentSession() { return null; }
    export async function seekTo() { return { ok: true }; }
    export async function companionReady() { return true; }
  `,
  './profiles.js': `
    import { SESSION_CTL } from '${new URL('./session-harness.mjs', import.meta.url).href}';
    export const LAST_SEEN = { title: null };
    // Mirrors the real watcher: with a \`match\`, only THAT profile satisfies the wait — anyone
    // else signing in leaves it unsatisfied (null) until the timeout, which is the whole point
    // of the gate. Without a match, the first signed-in profile wins.
    export async function waitForProfile({ match = null } = {}) {
      SESSION_CTL.waitCalls.push(match);
      const seen = SESSION_CTL.profileTitle;
      if (match) return seen === match ? seen : null;
      return seen;
    }
    export function setForProfile() { return null; }
  `,
  './adb.js': `
    import { SESSION_CTL } from '${new URL('./session-harness.mjs', import.meta.url).href}';
    export async function ensurePlexOpen() { return true; }
    export async function switchTo(target, cancel, known) {
      SESSION_CTL.switchCalls.push([target, known]);
      return [true, 'selected on the picker'];
    }
    export async function sameProfile(a, b) { return a === b; }
  `,
};

// WHERE THE STUBS SPLICE IN, and why it is two places.
//
// The hook matches on (parent module, specifier). When the `client` seam widened into a
// `provider` seam (decision 2026-08-12-backends-are-providers-behind-a-media-neutral-seam),
// the Plex-shaped imports MOVED OUT of session.js and into providers/plex.js — that is the
// entire point of the widening: session.js no longer knows what a MediaContainer is.
//
// So the replay client, the driver and playback are now stubbed at their new parent, with
// the `../` specifiers that file uses. session.js keeps only profiles/adb, which are about
// the Shield's user picker rather than about a backend.
//
// This is a change to WHERE the stub is injected, not to what the gates assert: the corpus,
// the expected outputs and every assertion are untouched. If a parity gate ever fails after
// a change here, that is the seam having changed behaviour — not a fixture to update.
//
// The parent anchors are written WITHOUT an extension and matched through ./module-id.mjs:
// these files are .ts today and were .js yesterday, and a matcher that misses does not throw,
// it silently runs the real module against the live Plex server.
const PARENT_STUBS = [
  ['/server/src/session', ['./profiles.js', './adb.js', './playback.js', './driver.js']],
  ['/server/src/providers/plex', ['../engine/plex-live.js', '../playback.js', '../driver.js']],
];

// Data-URL modules keep the stubs inline: no extra files, and each one closes over the same
// SESSION_CTL instance (imported by URL, so it resolves to this exact module).
export function stubSessionDeps() {
  // Keyed by extension-free module id, so a `./playback.ts` specifier would find the same
  // stub as today's `./playback.js`. A provider-parent specifier (`../playback.js`) resolves
  // to the SAME stub as its session-parent twin — both parents share one SESSION_CTL, so a
  // test still sees every recorded drive/play.
  const urls = new Map(
    Object.entries(STUB_SRC).map(([spec, src]) => [
      moduleId(spec).replace(/^\.+/, ''), `data:text/javascript,${encodeURIComponent(src)}`,
    ]),
  );
  const stubFor = (spec) => urls.get(moduleId(spec).replace(/^\.+/, ''));

  registerHooks({
    resolve(spec, ctx, next) {
      for (const [parentPath, specs] of PARENT_STUBS) {
        if (isModule(ctx?.parentURL, parentPath) && specifierIs(spec, ...specs)) {
          const url = stubFor(spec);
          if (url) return { url, shortCircuit: true };
        }
      }
      return next(spec, ctx);
    },
  });
}

// Write a temp sets.yaml + queues.yaml pair and point the engine at them. Returns the temp
// queues path so a test can read back what the write-side persisted.
export function useFixtures({ sets, queues }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-'));
  const setsPath = path.join(dir, 'sets.yaml');
  const queuesPath = path.join(dir, 'queues.yaml');
  writeFileSync(setsPath, sets);
  writeFileSync(queuesPath, queues);
  process.env.SETS_PATH = setsPath;
  process.env.QUEUES_PATH = queuesPath;
  process.env.PLEX_REPLAY_DIR = CORPUS;
  // Keep the derived Plex cache in the scratch dir too — the default is /config/cache.sqlite.
  process.env.CACHE_PATH = path.join(dir, 'cache.sqlite');
  return { dir, setsPath, queuesPath, readQueues: () => readFileSync(queuesPath, 'utf8') };
}

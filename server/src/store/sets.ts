// sets.yaml — the FILE behind the set registry.
//
// Everything here was moved out of `sets.ts` verbatim: the path, the cross-process mkdir
// lock, the first-boot seed, the comment-preserving `Document` round-trip and the atomic
// write. What stayed in `sets.ts` is everything that reads or edits the parsed document —
// normalization, the mutations, the registry memo. The split is "who touches the disk".
//
// The `Document` API is not an implementation detail this store is free to change. `sets.yaml`
// is hand-edited over SMB, so a round-trip that drops a comment or reorders a key punishes the
// person who typed it, and `e2e/yaml-roundtrip-test.ts` gates exactly that.
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { isSeq, parse, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { isNodeError } from '../errors.js';

// Read straight off `process.env` rather than through env.ts, deliberately unchanged: the e2e
// harnesses set `process.env.path` and then import the server modules, and this is the
// one place that resolves it. (env.ts has no path equivalent today.)
export const path = process.env.SETS_PATH || '/config/sets.yaml';

const LOCK_DIR = path + '.lock';
const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 10000;
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

async function acquireLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(LOCK_DIR);
      return;
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(LOCK_DIR);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(LOCK_DIR).catch(() => {});
          continue;
        }
      } catch {
        /* lock vanished — retry */
      }
      if (Date.now() > deadline) throw new Error('timed out acquiring sets.yaml lock');
      await sleep(50);
    }
  }
}

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await fs.rmdir(LOCK_DIR).catch(() => {});
  }
}

// The pre-registry state, verbatim: the six curated queues + the two kid rotation tiers
// that used to live hardcoded in queue_builder/config.py + web/src/config.js. Seeded to
// disk on first boot; from then on the FILE is the truth and this constant is only a
// disaster-recovery template.
const DEFAULT_YAML = `# queuepilot set registry — the single source of truth for every set (curated queue
# or dynamic channel). Edited by the web UI at plex-channels.example.com; hand-edits are
# fine too (the web app and the Python service both re-read it).
#
#   * id      IMMUTABLE — HA automations / NFC cards / MQTT reference it ({"set": "<id>"}).
#             Rename the label freely; NEVER change an id.
#   * order   of the entries below = shelf order on the web Home page.
#   * source  queue    = hand-curated wishlist in queues.yaml (orderable, prunes as watched)
#             rotation = rule-based kid channel (computed fresh each scan; filters below)
#   * sections / item_sections  which Plex libraries the set draws from / searches.
#   * keep_completed  (queue sets) true = a NON-CONSUMING / playlist queue: entries are
#             never marked done and never removed when played, so the whole lineup can be
#             re-shown every scan (e.g. the Theater Demo Reel). reel: true implies this.
#   * remove_completed_after  OPT-IN auto-removal of finished entries. Default (absent) =
#             KEEP FOREVER — a finished entry stays, tagged done, until cleared by hand. Set
#             a duration ("24h"/"7d"/"90m") to have finished entries auto-remove that long
#             after they finish; "0"/"never" is the explicit keep-forever. MOVIE queues opt
#             in (24h below); ANIME channels intentionally stay default (kept) — an anime
#             series has no "Season 2", so the finished series is the anchor a hand-added
#             sequel lands next to. keep_completed: true also exempts a set.
#
# Library membership is purely opt-in: a set draws only from the sections it lists, and
# every video library is available in the pickers. Non-video libraries (Music, Photos)
# are never eligible (filtered structurally, not by any hide list).

sets:
  - id: bob
    label: Bob — Movies
    kind: picks
    add_as: priority
    source: queue
    sections: [1, 14]
    remove_completed_after: 24h  # movie queues opt in; anime channels stay keep-forever
  - id: bob_alice
    label: Bob & Alice — Movies
    kind: picks
    add_as: priority
    source: queue
    sections: [1, 14]
    remove_completed_after: 24h
  - id: family
    label: Family — Movies
    kind: picks
    add_as: priority
    source: queue
    sections: [1, 14]
    remove_completed_after: 24h
  - id: bob_anime
    label: Bob — Anime
    kind: picks
    add_as: random
    source: queue
    sections: [11]
  - id: bob_alice_anime
    label: Bob & Alice — Anime
    kind: picks
    add_as: random
    source: queue
    sections: [11]
  - id: family_anime
    label: Family — Anime
    kind: picks
    add_as: random
    source: queue
    sections: [11]
  # The legacy per-tier sets (younger/older) are kept for the soak, marked superseded so
  # they stay readable ({set:"younger"} still plays) but are hidden from every picker and
  # skipped by the set:"auto" router. New installs land already-migrated to the function
  # channels below. (Migration: 2026-07-23-live-tier-migration-to-function-channels.)
  - id: younger
    label: Younger Kids
    kind: rules
    source: rotation
    sections: [5]
    item_sections: [15]
    allowed_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
    movie_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
    blocklist: []
    plex_user: Younger Kids
    account_id: 11111111
    user_uuid: 1111111111111111
    watch_count_accounts: [11111111]
    superseded_by: shows_shorts,movies
  - id: older
    label: Older Kids
    kind: rules
    source: rotation
    sections: [5]
    item_sections: [15]
    allowed_ratings: [TV-PG, PG]
    movie_ratings: [TV-PG, PG]
    blocklist: []
    plex_user: Older Kids
    account_id: 22222222
    user_uuid: 2222222222222222
    watch_count_accounts: [22222222]
    superseded_by: shows_shorts,movies
  # The function channels (cards send set:"auto"; the Shield's signed-in profile picks the
  # tier binding). Named by FUNCTION, not by profile — each carries both tiers as profiles[].
  - id: shows_shorts
    label: Shows & Shorts
    kind: rules
    source: rotation
    behavior: progress
    sections: [5]
    item_sections: [15]
    blocklist: []
    profiles:
      - plex_user: Younger Kids
        account_id: 11111111
        user_uuid: 1111111111111111
        allowed_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        movie_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        watch_count_accounts: [11111111]
      - plex_user: Older Kids
        account_id: 22222222
        user_uuid: 2222222222222222
        allowed_ratings: [TV-PG, PG]
        movie_ratings: [TV-PG, PG]
        watch_count_accounts: [22222222]
  # A rewatch channel pools from the libraries it names, like any other channel: movie
  # libraries in item_sections, show libraries in sections (their one-episode entries —
  # anime films). Add Documentaries/Anime here to widen it.
  - id: movies
    label: Movies
    kind: rules
    source: rotation
    behavior: rewatch
    sections: []
    item_sections: [1]
    blocklist: []
    profiles:
      - plex_user: Younger Kids
        account_id: 11111111
        user_uuid: 1111111111111111
        allowed_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        movie_ratings: [TV-Y, TV-Y7, TV-Y7-FV, TV-G, G]
        watch_count_accounts: [11111111]
      - plex_user: Older Kids
        account_id: 22222222
        user_uuid: 2222222222222222
        allowed_ratings: [TV-PG, PG]
        movie_ratings: [TV-PG, PG]
        watch_count_accounts: [22222222]
`;

export async function ensureFile(): Promise<void> {
  // Seed via an EXCLUSIVE create (wx), not the mkdir lock: readDoc runs inside
  // withLock() from every mutation, and the lock is not reentrant — taking it here
  // deadlocked the first mutation whenever the file didn't exist yet.
  try {
    await fs.access(path);
  } catch {
    try {
      await fs.writeFile(path, DEFAULT_YAML, { flag: 'wx' });
      console.log(`[sets] seeded ${path} from built-in defaults`);
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'EEXIST') throw e; // a concurrent seeder won the race — fine
    }
  }
}

export async function readDoc(): Promise<Document> {
  await ensureFile();
  const doc: Document = parseDocument(await fs.readFile(path, 'utf8'));
  if (!isSeq(doc.get('sets'))) throw new Error('sets.yaml has no sets list');
  return doc;
}

const YAML_OUT = { indentSeq: false, lineWidth: 0 };

export async function writeDoc(doc: Document): Promise<void> {
  const text = doc.toString(YAML_OUT);
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, path);
  } catch {
    await fs.writeFile(path, text, 'utf8');
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}


/**
 * The file's `(mtimeMs, size)`, or null when it is not there yet.
 *
 * Moved from `sets.ts registryCache()`, which memoizes the normalized registry on this pair:
 * every writer — this process, an SMB hand-edit, the Python prune — moves at least one of the
 * two, so a stale hit is not reachable through a normal write.
 */
export async function stat(): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** The same pair as a string, for the `/api/queues` ETag. A stat, not a read. */
export function revision(): string {
  try {
    const st = statSync(path);
    return `${Math.round(st.mtimeMs)}-${st.size}`;
  } catch {
    return '0-0';
  }
}

/**
 * The WHOLE store as one opaque blob, for `history.ts`'s undo/redo stack.
 *
 * Not a read: `readText()` would suggest a cheaper cousin of `readDoc()`, and this is neither
 * cheap nor partial. It is the entire store at a point in time, taken before a mutation and
 * restored byte for byte — which is the only way an undo can bring back the comment somebody
 * typed over SMB and the blank line they left under it.
 *
 * ⚠️ THIS IS THE PAIR THAT DOES NOT SURVIVE WP-2 FOR FREE. A SQLite store has no text to
 * snapshot, so satisfying this interface means one of: a serialized export of the store's rows
 * (still opaque to the caller, which is why the signature is `string` and not a document), or a
 * redesign of undo/redo onto row-level journalling. The plan calls folding `.history.json` in
 * "7 KB, the smallest reader in the set"; the size is right and the conclusion is not. Keeping
 * the capability NAMED here is the point — WP-2 has to answer it deliberately rather than
 * discover it when undo silently stops restoring formatting.
 */
export async function readRawSnapshot(): Promise<string | null> {
  return fs.readFile(path, 'utf8').catch(() => null);
}

/** Put a snapshot back, byte for byte. Same atomic tmp+rename as `writeDoc`, same fallback. */
export async function writeRawSnapshot(text: string): Promise<void> {
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, path);
  } catch {
    await fs.writeFile(path, text, 'utf8');
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * Parse the registry SYNCHRONOUSLY, and THROW rather than decide what a failure means.
 *
 * The engine's read side (`engine/routing.ts loadSets`) is synchronous and runs on the scan
 * path. It owns the error policy — a missing or unreadable file means "keep the current sets"
 * there — so this returns the parse and nothing else. `file` is the fixture seam every offline
 * e2e harness drives `loadSets()` through.
 */
export function readSync(file: string = path): unknown {
  return parse(readFileSync(file, 'utf8'));
}

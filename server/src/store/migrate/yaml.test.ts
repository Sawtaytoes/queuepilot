// The YAML importer: what it carries, what it refuses to carry twice, and the copy it leaves.
//
// Every path this suite touches is a fresh `mkdtemp`, and the env has to be set BEFORE the
// modules are imported — `config.ts` resolves `QUEUES_PATH` and `STORE_PATH` at module load,
// and `store/sets.ts` reads `SETS_PATH` straight off `process.env` for exactly the same reason
// the e2e harnesses rely on. Hence the dynamic imports at the bottom.
//
// The fixture is invented. This repo is public.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'qp-import-'));

const SETS = `# HEAD: the registry.
global:
  excluded_sections: [2]
sets:
- id: bob
  label: Bob — Movies
  kind: picks
  source: queue
  sections: [1]
- id: bob_alice
  label: Bob & Alice
  kind: picks
  source: queue
  sections: [1]
`;
const QUEUES = `bob:
- {ratingKey: "265786", title: "Movie A (2009)"}
- {collection: "A Collection"}
bob_alice: []
`;
const GROUPS = `groups:
- id: bob
  label: Bob
  accounts:
    plex: [bob_plex]
`;
const PENDING = `seen_through: 1755000000
dismissed:
  - "460465"
  - "460345"
libraries:
  - 1
`;

writeFileSync(join(dir, 'sets.yaml'), SETS);
writeFileSync(join(dir, 'queues.yaml'), QUEUES);
writeFileSync(join(dir, 'groups.yaml'), GROUPS);
writeFileSync(join(dir, 'pending.yaml'), PENDING);

process.env.QUEUES_PATH = join(dir, 'queues.yaml');
process.env.SETS_PATH = join(dir, 'sets.yaml');
process.env.GROUPS_PATH = join(dir, 'groups.yaml');
process.env.PENDING_PATH = join(dir, 'pending.yaml');
process.env.STORE_BACKEND = 'sqlite';
// The mirror is off: this suite is about what the IMPORTER does, and a write-through YAML
// writer would move the files under it and change the fingerprint mid-test.
process.env.STORE_YAML_MIRROR = '0';

const { importYaml } = await import('./yaml.js');
const { store } = await import('../index.js');
const { closeBookOfRecord } = await import('../db/open.js');

afterAll(() => {
  closeBookOfRecord();
});

describe('importYaml', () => {
  let first: ReturnType<typeof importYaml>;

  beforeAll(() => {
    first = importYaml();
  });

  it('carries every wire id across VERBATIM, in file order', () => {
    // The whole package rests on this line. A set id is what an NFC card carries.
    expect(first.setIds).toEqual(['bob', 'bob_alice']);
    expect(first.queueIds).toEqual(['bob', 'bob_alice']);
    expect(first.groupIds).toEqual(['bob']);
  });

  it('counts what it wrote', () => {
    expect(first.imported).toBe(true);
    expect(first.entryCount).toBe(2);
    expect(first.dismissedCount).toBe(2);
    expect(first.seenThrough).toBe(1755000000);
  });

  it('copies all four files aside BEFORE it writes a row', () => {
    // This is the replacement for the eighteen hand-made `.bak-*` files in App-Configs: the
    // same habit, run by the thing that needs it rather than by whoever remembers.
    expect(first.backupDir).not.toBeNull();
    const copied = readdirSync(first.backupDir as string).sort();
    expect(copied).toEqual(['groups.yaml', 'pending.yaml', 'queues.yaml', 'sets.yaml']);
    expect(readFileSync(join(first.backupDir as string, 'sets.yaml'), 'utf8')).toBe(SETS);
  });

  it('is IDEMPOTENT — a second run over unchanged YAML writes nothing', () => {
    const again = importYaml();
    expect(again.imported).toBe(false);
    expect(again.reason).toMatch(/has not changed/);
    // …and the rows are exactly what the first run left.
    expect((store.sets.readSync() as { sets: { id: string }[] }).sets.map((set) => set.id)).toEqual([
      'bob',
      'bob_alice',
    ]);
  });

  it('reads a CHANGED file again while the store is still untouched', () => {
    // The bridge release still supports a hand-edit over SMB, so a changed file is not ignored
    // just because an import already happened.
    writeFileSync(join(dir, 'sets.yaml'), `${SETS}- id: carol\n  label: Carol\n  kind: picks\n  source: queue\n`);
    const third = importYaml();
    expect(third.imported).toBe(true);
    expect(third.setIds).toEqual(['bob', 'bob_alice', 'carol']);
  });

  it('REFUSES to re-read the YAML once the store itself has been written', () => {
    // The rule that makes the mirror safe. Every store write also writes YAML, so the
    // fingerprint changes constantly; only this check stops an endless re-import — and, more
    // importantly, stops a stale file overwriting an edit the app has already made.
    return (async () => {
      const doc = await store.sets.readDoc();
      await store.sets.writeDoc(doc);

      writeFileSync(join(dir, 'sets.yaml'), `${SETS}- id: dave\n  label: Dave\n  kind: picks\n  source: queue\n`);
      const fourth = importYaml();

      expect(fourth.imported).toBe(false);
      expect(fourth.reason).toMatch(/has been written since the import/);
      expect((store.sets.readSync() as { sets: { id: string }[] }).sets.map((set) => set.id)).not.toContain(
        'dave',
      );
    })();
  });

  it('imports anyway when it is told to, and still copies aside first', () => {
    const forced = importYaml({ force: true });
    expect(forced.imported).toBe(true);
    expect(forced.setIds).toContain('dave');
    expect(forced.backupDir).not.toBeNull();
  });

  it('keeps `global:` — the key beside the list that belongs to no row', () => {
    expect((store.sets.readSync() as { global: unknown }).global).toEqual({ excluded_sections: [2] });
  });

  it('keeps an EMPTY queue as a queue', () => {
    expect(store.queues.readSync()).toHaveProperty('bob_alice', []);
  });

  it('keeps `libraries: []` and `libraries` absent as DIFFERENT answers', async () => {
    // `[]` means no libraries at all and is a page the owner can choose; absent means nobody
    // has chosen and the screen falls back to every video library. A column that collapsed the
    // two would hand him the wrong screen with no way to say so.
    expect((await store.pending.read()).libraries).toEqual([1]);

    await store.pending.write({ seen_through: 1, dismissed: [], libraries: [] });
    expect((await store.pending.read()).libraries).toEqual([]);

    await store.pending.write({ seen_through: 1, dismissed: [], libraries: null });
    expect((await store.pending.read()).libraries).toBeNull();
  });
});

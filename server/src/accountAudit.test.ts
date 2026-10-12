// The attribution audit: does a gated queue's pushed items end up on the bound account?
//
// decision 2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited. The
// scenarios below are the 2026-09-12 failure and, just as importantly, the normal evenings
// that must NOT be reported — a check that cries wolf on the first run gets switched off, and
// then the real one goes unseen again.
//
// The cast is invented: Ada's and Linus's accounts, and a Shows library. No household account
// id, profile name or library id reaches this repo.
import { describe, expect, it } from 'vitest';

import { auditAttribution } from './accountAudit.js';
import { recordPush } from './store/db/gatedPush.js';
import { migrate } from './store/db/open.js';
import { openSqlite, type SqliteDatabase } from './store/sqlite.js';
import type { PlexClient, PlexMediaContainer, PlexMetadata } from './types.js';

const ADA = 220339333;
const LINUS = 1;

const NOW = 1_800_000_000;
const HOUR = 3600;

const fresh = (): SqliteDatabase => {
  const db = openSqlite(':memory:');
  migrate(db);
  return db;
};

/**
 * A history row as the audit reads it. Spelled as `PlexMetadata` (whose index signature is
 * what lets a raw container stay usable) so the fixtures need no cast and cannot drift from
 * the shape the production code is handed.
 */
type Row = PlexMetadata & { accountID?: number; viewedAt?: number };

/**
 * A Plex client that answers the history read with `rows` and nothing else.
 *
 * `totalSize` is set to the row count so the pager stops after one page, which is what the
 * real server does for a window this size.
 */
const clientWith = (rows: Row[]): PlexClient => ({
  async container(): Promise<PlexMediaContainer> {
    return { Metadata: rows, totalSize: rows.length, size: rows.length };
  },
  async accountToken() { return null; },
});

const throwingClient = (message: string): PlexClient => ({
  async container(): Promise<PlexMediaContainer> { throw new Error(message); },
  async accountToken() { return null; },
});

describe('auditAttribution', () => {
  it('names an item a gated queue played under another account', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows',
      profile: 'Younger Kids',
      accountId: ADA,
      pushedAt: NOW,
      ratingKeys: ['191157', '103916'],
      playQueueId: 15162,
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + HOUR,
      lookbackSeconds: 7 * 24 * HOUR,
      db,
      client: clientWith([
        { ratingKey: '191157', accountID: LINUS, title: 'Flies a Kite', viewedAt: NOW + 600 },
      ]),
    });

    expect(report.unreadable).toBeNull();
    expect(report.pushesChecked).toBe(1);
    expect(report.itemsMatched).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      setId: 'younger_kids_shows',
      profile: 'Younger Kids',
      expectedAccountId: ADA,
      actualAccountId: LINUS,
      ratingKey: '191157',
      playQueueId: 15162,
    });
  });

  it('reports nothing when the bound account played it', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows', accountId: ADA, pushedAt: NOW, ratingKeys: ['191157'],
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + HOUR,
      db,
      client: clientWith([
        { ratingKey: '191157', accountID: ADA, title: 'Flies a Kite', viewedAt: NOW + 600 },
      ]),
    });

    expect(report.itemsMatched).toBe(1);
    expect(report.findings).toEqual([]);
  });

  // THE FALSE POSITIVE THAT WOULD GET THIS SWITCHED OFF. Several queues legitimately draw
  // from one library, each bound to a different account: a family queue on the owner's
  // profile and a kids' queue on a child's both play Shows. A row on another account is only
  // a finding when THIS push put that item in the play queue.
  it('ignores an item this push never pushed', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows', accountId: ADA, pushedAt: NOW, ratingKeys: ['191157'],
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + HOUR,
      db,
      client: clientWith([
        // Same library, same evening, another account's own queue. Not ours.
        { ratingKey: '999999', accountID: LINUS, title: 'Get a Horse!', viewedAt: NOW + 600 },
      ]),
    });

    expect(report.itemsMatched).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('ignores a row viewed before the push', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows', accountId: ADA, pushedAt: NOW, ratingKeys: ['191157'],
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + HOUR,
      db,
      client: clientWith([
        { ratingKey: '191157', accountID: LINUS, title: 'Flies a Kite', viewedAt: NOW - 60 },
      ]),
    });

    expect(report.findings).toEqual([]);
  });

  it('ignores a row past the push window', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows', accountId: ADA, pushedAt: NOW, ratingKeys: ['191157'],
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + 10 * 24 * HOUR,
      lookbackSeconds: 30 * 24 * HOUR,
      db,
      // A week later, somebody played the same short on their own profile. That says nothing
      // about this push.
      client: clientWith([
        { ratingKey: '191157', accountID: LINUS, title: 'Flies a Kite', viewedAt: NOW + 7 * 24 * HOUR },
      ]),
    });

    expect(report.findings).toEqual([]);
  });

  // 2026-09-12 in miniature: two gated queues in turn on one device. The second push ends the
  // first one's window, so each finding is attributed to the queue that actually pushed it.
  it('attributes each finding to the queue that pushed it', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows', profile: 'Younger Kids', accountId: ADA,
      pushedAt: NOW, ratingKeys: ['191157'],
    }, db);
    recordPush({
      setId: 'older_kids_shows', profile: 'Older Kids', accountId: 348723892,
      pushedAt: NOW + 4700, ratingKeys: ['443228'],
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + 6 * HOUR,
      db,
      client: clientWith([
        { ratingKey: '191157', accountID: LINUS, title: 'Flies a Kite', viewedAt: NOW + 600 },
        { ratingKey: '443228', accountID: LINUS, title: 'Heavy Metal War', viewedAt: NOW + 7000 },
      ]),
    });

    expect(report.pushesChecked).toBe(2);
    expect(report.findings.map((f) => [f.setId, f.ratingKey])).toEqual([
      ['younger_kids_shows', '191157'],
      ['older_kids_shows', '443228'],
    ]);
  });

  // A row Plex did not stamp with an account proves nothing, and reporting it as a mismatch
  // against account 0 would be a fabricated finding — worse than a missed one.
  it('does not invent a finding from an unstamped history row', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows', accountId: ADA, pushedAt: NOW, ratingKeys: ['191157'],
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + HOUR,
      db,
      client: clientWith([
        { ratingKey: '191157', title: 'Flies a Kite', viewedAt: NOW + 600 },
      ]),
    });

    expect(report.itemsMatched).toBe(1);
    expect(report.findings).toEqual([]);
  });

  // A FAILED READ IS NOT A CLEAN RUN. The report has to let a caller tell "nothing was
  // mis-filed" from "I could not look" — folding them together is how a broken check reads
  // as a passing one for a month.
  it('reports an unreadable history rather than a clean run', async () => {
    const db = fresh();
    recordPush({
      setId: 'younger_kids_shows', accountId: ADA, pushedAt: NOW, ratingKeys: ['191157'],
    }, db);

    const report = await auditAttribution({
      nowSec: NOW + HOUR,
      db,
      client: throwingClient('plex unreachable'),
    });

    expect(report.unreadable).toContain('plex unreachable');
    expect(report.findings).toEqual([]);
  });

  it('is a clean, cheap no-op when no gated push was logged', async () => {
    const db = fresh();
    let reads = 0;
    const report = await auditAttribution({
      nowSec: NOW,
      db,
      client: {
        async container(): Promise<PlexMediaContainer> {
          reads += 1;
          return {};
        },
        async accountToken() { return null; },
      },
    });

    expect(report.pushesChecked).toBe(0);
    expect(report.findings).toEqual([]);
    // No pushes means there is nothing a history read could be compared against, so it must
    // not spend the request at all.
    expect(reads).toBe(0);
  });
});

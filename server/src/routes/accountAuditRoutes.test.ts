// The attribution audit's HTTP door.
//
// decision 2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited. The audit
// itself is covered by `accountAudit.test.ts`; what matters here is the contract a caller
// sees — a 200 even when there ARE findings, and a `lookbackSeconds` that falls back rather
// than throwing on junk.
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as accountAudit from '../accountAudit.js';
import { ACCOUNT_AUDIT_LOOKBACK_SECONDS } from '../env.js';
import { accountAuditRoutes } from './accountAuditRoutes.js';

afterEach(() => vi.restoreAllMocks());

const report = (
  over: Partial<accountAudit.AttributionReport> = {},
): accountAudit.AttributionReport => ({
  since: 0,
  pushesChecked: 0,
  itemsMatched: 0,
  findings: [],
  unreadable: null,
  ...over,
});

const finding = (): accountAudit.AttributionFinding => ({
  setId: 'younger_kids_shows',
  profile: 'Younger Kids',
  expectedAccountId: 220339333,
  actualAccountId: 1,
  ratingKey: '191157',
  title: 'Flies a Kite',
  viewedAt: 1_800_000_600,
  pushedAt: 1_800_000_000,
  playQueueId: 15162,
});

describe('GET /account-audit', () => {
  it('answers 200 with the findings — a mis-filed item is the ANSWER, not an error', async () => {
    // A non-2xx here would make a caller treat a correct report as a broken endpoint, and the
    // whole point of the route is to be polled by something that is not watching closely.
    vi.spyOn(accountAudit, 'auditAttribution').mockResolvedValue(
      report({ pushesChecked: 1, itemsMatched: 1, findings: [finding()] }),
    );

    const res = await accountAuditRoutes().request('/account-audit');

    expect(res.status).toBe(200);
    const body = await res.json() as accountAudit.AttributionReport;
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ expectedAccountId: 220339333, actualAccountId: 1 });
    expect(body.unreadable).toBeNull();
  });

  it('reports an unreadable history distinctly from a clean run', async () => {
    vi.spyOn(accountAudit, 'auditAttribution').mockResolvedValue(
      report({ pushesChecked: 1, unreadable: 'plex unreachable' }),
    );

    const res = await accountAuditRoutes().request('/account-audit');

    expect(res.status).toBe(200);
    const body = await res.json() as accountAudit.AttributionReport;
    // Both lists are empty on a clean run too, so `unreadable` is the only thing that lets a
    // caller tell "nothing was mis-filed" from "I could not look".
    expect(body.findings).toEqual([]);
    expect(body.unreadable).toBe('plex unreachable');
  });

  it('passes a lookback through, and falls back rather than throwing on junk', async () => {
    const audit = vi.spyOn(accountAudit, 'auditAttribution').mockResolvedValue(report());

    await accountAuditRoutes().request('/account-audit?lookbackSeconds=3600');
    expect(audit).toHaveBeenLastCalledWith({ lookbackSeconds: 3600 });

    for (const bad of ['nonsense', '-5', '0', '']) {
      await accountAuditRoutes().request(`/account-audit?lookbackSeconds=${bad}`);
      expect(audit).toHaveBeenLastCalledWith({
        lookbackSeconds: ACCOUNT_AUDIT_LOOKBACK_SECONDS,
      });
    }

    await accountAuditRoutes().request('/account-audit');
    expect(audit).toHaveBeenLastCalledWith({ lookbackSeconds: ACCOUNT_AUDIT_LOOKBACK_SECONDS });
  });
});

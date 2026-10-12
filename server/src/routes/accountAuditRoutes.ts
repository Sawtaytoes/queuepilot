import { Hono } from 'hono';
import { auditAttribution, summarise } from '../accountAudit.js';
import { ACCOUNT_AUDIT_LOOKBACK_SECONDS } from '../env.js';

/**
 * The attribution audit's trigger surface.
 *
 * GET, not POST, because the audit READS — it compares the gated-push log against Plex
 * history and writes nothing a caller can observe. (It does prune pushes it will never look
 * at again, which is housekeeping, not a mutation of anything the API exposes.)
 *
 * There is no timer behind it, deliberately: a `setInterval` that stops firing is invisible
 * until the answer is wrong, and the repo ships no Home Assistant automation that calls this
 * either, because most people who clone it do not run Home Assistant.
 * (docs/decisions/2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited.md)
 */
export function accountAuditRoutes(): Hono {
  const app = new Hono();

  app.get('/account-audit', async (c) => {
    const raw = c.req.query('lookbackSeconds');
    const parsed = raw == null ? NaN : Number(raw);
    const lookbackSeconds = Number.isFinite(parsed) && parsed > 0
      ? parsed
      : ACCOUNT_AUDIT_LOOKBACK_SECONDS;

    const report = await auditAttribution({ lookbackSeconds });
    console.log(`[audit] attribution: ${summarise(report)}`);
    // 200 even when there are findings: the request succeeded, and the findings are the
    // answer. A non-2xx would make a caller treat a correct report as a broken endpoint.
    return c.json(report);
  });

  return app;
}

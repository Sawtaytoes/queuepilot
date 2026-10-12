// Did a gated queue's items end up on the account the queue is bound to?
//
// decision 2026-10-12-a-profile-observation-expires-and-a-gated-push-is-audited.
//
// The post-play audit in `driver.ts` answers that question for the play it is watching, and
// it is the right place to answer it — it can STOP a mismatch within seconds. What it cannot
// do is answer when it has no opinion, and abstention is deliberately a pass there, because
// failing a play that is probably fine is worse than an audit that occasionally shrugs. Two
// gated queues went to the owner's account on 2026-09-12 through exactly that gap, and the
// report that found them was a person reading Plex history a month later.
//
// This is the net under that. It compares the `gated_push` log against Plex's own history and
// names every item a gated queue pushed that Plex filed under another account.
//
// ⚠️ IT IS EVALUATED ON A READ, AND THERE IS NO TIMER HERE. A `setInterval` that does not
// fire is invisible until the answer is wrong, and this app's schedules belong to Home
// Assistant or to the caller. The route and the MQTT command are the whole trigger surface;
// the repo ships no automation that calls them, because most people who clone it do not run
// Home Assistant.
//
// ⚠️ IT MATCHES ON RATING KEYS, NEVER ON LIBRARIES. Several accounts legitimately play the
// same libraries — a family queue bound to the owner and a kids' queue bound to a child both
// draw from Shows — so "a Shows row on another account" is a normal evening, not a finding.
// Only an item THIS push put in the play queue counts.
import { ACCOUNT_AUDIT_LOOKBACK_SECONDS, ACCOUNT_AUDIT_PUSH_WINDOW_SECONDS } from './env.js';
import { liveClient } from './engine/plex-live.js';
import * as gatedPush from './store/db/gatedPush.js';
import type { GatedPush } from './store/db/gatedPush.js';
import { errMessage } from './errors.js';
import type { SqliteDatabase } from './store/sqlite.js';
import type { PlexClient } from './types.js';

/** One item a gated push played under the wrong account. */
export interface AttributionFinding {
  setId: string;
  profile: string | null;
  /** The account the queue is bound to. */
  expectedAccountId: number;
  /** The account Plex actually filed the item under. */
  actualAccountId: number;
  ratingKey: string;
  title: string | null;
  /** Unix epoch SECONDS, from the history row. */
  viewedAt: number;
  /** Unix epoch SECONDS of the push this item belongs to. */
  pushedAt: number;
  playQueueId: number | null;
}

export interface AttributionReport {
  /** Unix epoch SECONDS — the oldest push this run considered. */
  since: number;
  /** How many `gated_push` rows were examined. */
  pushesChecked: number;
  /** How many history rows were matched to a push, right or wrong. */
  itemsMatched: number;
  findings: AttributionFinding[];
  /**
   * Why the history read failed, when it did. A failed read is NOT a clean run, and a caller
   * must be able to tell "nothing was mis-filed" from "I could not look".
   */
  unreadable: string | null;
}

interface HistoryRow {
  ratingKey?: string | number;
  accountID?: string | number;
  title?: string;
  viewedAt?: number;
}

/** quote_plus, matching `engine/select.ts`'s encoder so both build the same query string. */
function encQ(value: unknown): string {
  return encodeURIComponent(String(value))
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Every history row on the server viewed at or after `sinceSec`, for EVERY account.
 *
 * Deliberately no `accountID` filter: the whole question is which account a row landed on, so
 * filtering by one would make the answer unobtainable. Deliberately no `librarySectionID`
 * either — `viewedAt>` is a Plex server filter and bounds the response by itself. A whole
 * week of this household is 38 rows (measured 2026-10-12), so narrowing by library would add
 * a parameter to thread through two layers and save nothing.
 *
 * ⚠️ The filter key is `viewedAt>`, not `viewedAt>=`. Plex names the operator in the KEY, so
 * the exclusive bound is shifted by a second here rather than spelled differently.
 */
async function historySince(
  client: PlexClient,
  sinceSec: number,
  page = 500,
): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  let start = 0;
  for (;;) {
    const pairs: [string, number | string][] = [
      ['viewedAt>', Math.floor(sinceSec) - 1],
      ['X-Plex-Container-Start', start],
      ['X-Plex-Container-Size', page],
      ['sort', 'viewedAt:asc'],
    ];
    const query = pairs.map(([k, v]) => `${encQ(k)}=${encQ(v)}`).join('&');
    const container = await client.container('/status/sessions/history/all?' + query, null);
    const batch = (container.Metadata || []) as HistoryRow[];
    for (const row of batch) rows.push(row);
    start += batch.length;
    const total = container.totalSize != null
      ? Number(container.totalSize)
      : container.size != null ? Number(container.size) : 0;
    if (!batch.length || start >= total) break;
  }
  return rows;
}

/**
 * Audit the gated pushes in the recent past.
 *
 * `lookbackSeconds` chooses which pushes to examine. Each push is then compared only against
 * history inside its OWN window (`ACCOUNT_AUDIT_PUSH_WINDOW_SECONDS`, and never past the next
 * push of the same set), because a ratingKey played again the following week says nothing
 * about this push.
 */
export async function auditAttribution({
  lookbackSeconds = ACCOUNT_AUDIT_LOOKBACK_SECONDS,
  nowSec = Math.floor(Date.now() / 1000),
  client = liveClient(),
  db,
}: {
  lookbackSeconds?: number;
  nowSec?: number;
  client?: PlexClient;
  /** Test seam. Omitted in production, where the book of record is the only store. */
  db?: SqliteDatabase;
} = {}): Promise<AttributionReport> {
  const since = Math.floor(nowSec - Math.max(0, lookbackSeconds));
  const pushes = db ? gatedPush.pushesSince(since, 500, db) : gatedPush.pushesSince(since);
  const report: AttributionReport = {
    since,
    pushesChecked: pushes.length,
    itemsMatched: 0,
    findings: [],
    unreadable: null,
  };
  if (!pushes.length) return report;

  // The window a push owns ends at the next push of the SAME set, or after the fixed window.
  // Two sets playing in turn on one device is normal (it is what happened on 2026-09-12), so
  // the boundary has to be per set rather than global.
  const nextPushBySet = new Map<string, number[]>();
  for (const push of pushes) {
    const list = nextPushBySet.get(push.setId) ?? [];
    list.push(push.pushedAt);
    nextPushBySet.set(push.setId, list);
  }
  const windowEnd = (push: GatedPush): number => {
    const fixed = push.pushedAt + Math.max(60, ACCOUNT_AUDIT_PUSH_WINDOW_SECONDS);
    const later = (nextPushBySet.get(push.setId) ?? []).filter((at) => at > push.pushedAt);
    return later.length ? Math.min(fixed, Math.min(...later)) : fixed;
  };

  // ONE read, shared by every push. Narrowing or re-reading per push would multiply the cost
  // for an identical answer.
  let history: HistoryRow[];
  try {
    history = await historySince(client, since);
  } catch (e) {
    report.unreadable = errMessage(e);
    return report;
  }

  for (const push of pushes) {
    const wanted = new Set(push.ratingKeys);
    if (!wanted.size) continue;
    const end = windowEnd(push);

    for (const row of history) {
      const ratingKey = row.ratingKey == null ? null : String(row.ratingKey);
      if (ratingKey == null || !wanted.has(ratingKey)) continue;
      const viewedAt = Number(row.viewedAt ?? 0);
      if (viewedAt < push.pushedAt || viewedAt > end) continue;

      report.itemsMatched += 1;
      const actual = Number(row.accountID);
      // An unstamped history row proves nothing. Plex has always stamped `accountID` on this
      // endpoint, but a row without one must not be reported as a mismatch against account
      // 0 — that would be a fabricated finding, which is worse than a missed one.
      if (!Number.isFinite(actual)) continue;
      if (actual === push.accountId) continue;

      report.findings.push({
        setId: push.setId,
        profile: push.profile,
        expectedAccountId: push.accountId,
        actualAccountId: actual,
        ratingKey,
        title: row.title != null ? String(row.title) : null,
        viewedAt,
        pushedAt: push.pushedAt,
        playQueueId: push.playQueueId,
      });
    }
  }

  // Prune on the way out rather than on a timer, for the reason at the top of this file. The
  // audit is the only reader, so anything outside the longest window it will ever ask about
  // is dead weight.
  const pruneBefore = nowSec - Math.max(0, lookbackSeconds) * 4;
  if (db) gatedPush.prunePushesBefore(pruneBefore, db);
  else gatedPush.prunePushesBefore(pruneBefore);

  return report;
}

/** A one-line summary for the runtime log and the MQTT reply. */
export function summarise(report: AttributionReport): string {
  const parts = [
    `${report.pushesChecked} gated push(es)`,
    `${report.itemsMatched} item(s) matched`,
    `${report.findings.length} wrong-account item(s)`,
  ];
  if (report.unreadable) parts.push(`history unreadable: ${report.unreadable}`);
  return parts.join(', ');
}

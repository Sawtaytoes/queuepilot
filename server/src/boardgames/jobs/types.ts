// WHAT A COLLECTION JOB REPORTS.
//
// Every job answers the same three things: did it run, did it work, and what did it do. A job
// that is not configured — no upstream token, no Kavita — is `skipped`, which is NOT a failure:
// none of these integrations is required, and a fresh container with none of them configured is
// a working app rather than a broken one. Only `isOk: false` wakes anybody up.
export type CollectionJobName = 'sync-bgg' | 'enrich' | 'link-rulebooks' | 'link-videos';

export interface CollectionJobResult {
  name: CollectionJobName;
  isOk: boolean;
  /** True when the job had nothing configured to talk to. `isOk` stays true. */
  isSkipped: boolean;
  /** One line for a log or an MQTT payload. Never a stack trace. */
  summary: string;
  /** Counters, for whoever is reading the response. Shape is per job. */
  counts?: Record<string, number>;
}

export const skipped = (name: CollectionJobName, summary: string): CollectionJobResult => ({
  isOk: true,
  isSkipped: true,
  name,
  summary,
});

/** A job that threw. The message, never the stack — this ends up in an MQTT payload. */
export const failed = (
  name: CollectionJobName,
  error: unknown,
): CollectionJobResult => ({
  isOk: false,
  isSkipped: false,
  name,
  summary: error instanceof Error ? error.message : String(error),
});

/** Somewhere to send progress. The CLI prints; the MQTT handler collects. */
export type OnProgress = (message: string) => void;

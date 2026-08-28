// QueuePilot owns the cadence for its own lineup maintenance. The scheduler only decides
// WHEN to wake each path; topup.ts still decides whether anything needs to change.

export const SESSION_TOPUP_INTERVAL_MS = 5 * 60 * 1000;
export const PULL_TOPUP_INTERVAL_MS = 15 * 60 * 1000;

interface TimerHandle {
  unref?: () => void;
}

type Schedule = (callback: () => void, intervalMs: number) => TimerHandle;
type Clear = (timer: TimerHandle) => void;

export interface TopupSchedulerDeps {
  runSession: () => Promise<void>;
  runPullLists: () => Promise<void>;
  schedule?: Schedule;
  clear?: Clear;
  logError?: (scope: 'session' | 'pull', error: unknown) => void;
}

export interface TopupScheduler {
  stop: () => void;
}

/**
 * Start the two application-lifecycle timers.
 *
 * A slow provider call never overlaps itself. The next interval is skipped while that scope
 * is still running, but the session and pull-list scopes remain independent of each other.
 */
export function startTopupScheduler({
  runSession,
  runPullLists,
  schedule = (callback, intervalMs) => setInterval(callback, intervalMs),
  clear = (timer) => clearInterval(timer as NodeJS.Timeout),
  logError = (scope, error) => console.log(`[topup] ${scope} timer failed: ${error instanceof Error ? error.message : String(error)}`),
}: TopupSchedulerDeps): TopupScheduler {
  let isSessionRunning = false;
  let isPullRunning = false;

  const runGuarded = (scope: 'session' | 'pull', run: () => Promise<void>): void => {
    if (scope === 'session' ? isSessionRunning : isPullRunning) return;
    if (scope === 'session') isSessionRunning = true;
    else isPullRunning = true;

    void run()
      .catch((error: unknown) => logError(scope, error))
      .finally(() => {
        if (scope === 'session') isSessionRunning = false;
        else isPullRunning = false;
      });
  };

  const sessionTimer = schedule(
    () => runGuarded('session', runSession),
    SESSION_TOPUP_INTERVAL_MS,
  );
  const pullTimer = schedule(
    () => runGuarded('pull', runPullLists),
    PULL_TOPUP_INTERVAL_MS,
  );
  sessionTimer.unref?.();
  pullTimer.unref?.();

  return {
    stop: () => {
      clear(sessionTimer);
      clear(pullTimer);
    },
  };
}

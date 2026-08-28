import { describe, expect, it, vi } from 'vitest';
import {
  PULL_TOPUP_INTERVAL_MS,
  SESSION_TOPUP_INTERVAL_MS,
  startTopupScheduler,
} from './topupScheduler.js';

describe('top-up scheduler', () => {
  it('owns the session and pull-list cadences inside QueuePilot', () => {
    const callbacks: Array<() => void> = [];
    const intervals: number[] = [];
    const timers = [{ unref: vi.fn() }, { unref: vi.fn() }];
    const clear = vi.fn();

    const scheduler = startTopupScheduler({
      runSession: async () => undefined,
      runPullLists: async () => undefined,
      schedule: (callback, intervalMs) => {
        callbacks.push(callback);
        intervals.push(intervalMs);
        return timers[callbacks.length - 1] as (typeof timers)[number];
      },
      clear,
    });

    expect(callbacks).toHaveLength(2);
    expect(intervals).toEqual([SESSION_TOPUP_INTERVAL_MS, PULL_TOPUP_INTERVAL_MS]);
    expect(timers[0]?.unref).toHaveBeenCalledOnce();
    expect(timers[1]?.unref).toHaveBeenCalledOnce();

    scheduler.stop();
    expect(clear.mock.calls).toEqual([[timers[0]], [timers[1]]]);
  });

  it('does not overlap two runs of the same scope', async () => {
    const callbacks: Array<() => void> = [];
    let finishSession: (() => void) | undefined;
    const runSession = vi.fn(() => new Promise<void>((resolve) => { finishSession = resolve; }));

    startTopupScheduler({
      runSession,
      runPullLists: async () => undefined,
      schedule: (callback) => {
        callbacks.push(callback);
        return {};
      },
      clear: () => undefined,
    });

    callbacks[0]?.();
    callbacks[0]?.();
    expect(runSession).toHaveBeenCalledOnce();

    finishSession?.();
    await Promise.resolve();
    await Promise.resolve();
    callbacks[0]?.();
    expect(runSession).toHaveBeenCalledTimes(2);
  });
});

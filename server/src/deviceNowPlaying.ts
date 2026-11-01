import { configuredPlaybackTargets } from './playbackTargets.js';
import * as mqttc from './mqttc.js';
import * as playback from './playback.js';
import type { Device, NowPlaying } from './types.js';

interface SessionContext { sittingId?: number; isPreparing?: boolean; playQueueID: number | string | null; userUuid: string | null }

/** Secondary clients need telemetry even when they do not advertise Plex Companion. */
export function startDeviceNowPlaying({
  targets = configuredPlaybackTargets(),
  active = () => mqttc.lastState()?.deviceId ?? null,
  context = () => ({ playQueueID: null, userUuid: null }),
  read = (device: Device, ctx: SessionContext) => playback.currentSession({ device, playQueueID: ctx.playQueueID, userUuid: ctx.userUuid, timeoutMs: 1_000, includeTelemetry: true, throwOnError: true }),
  publish = mqttc.recordDeviceNowPlaying,
  intervalMs = 1_500,
}: {
  targets?: Device[];
  active?: () => string | null;
  context?: () => SessionContext;
  read?: (device: Device, ctx: SessionContext) => Promise<playback.CurrentSession | null>;
  publish?: (id: string, now: NowPlaying | null) => void;
  intervalMs?: number;
} = {}): () => void {
  let isStopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    const id = active();
    const ctx = context();
    const device = ctx.isPreparing ? undefined : targets.find((d) => d.id === id);
    try {
      if (device) {
        const observed = await read(device, ctx);
        if (!isStopped && !context().isPreparing && context().sittingId === ctx.sittingId && active() === id && context().playQueueID === ctx.playQueueID && context().userUuid === ctx.userUuid) {
          publish(device.id, observed ? {
            deviceId: device.id, state: observed.state, ratingKey: observed.ratingKey,
            title: observed.title, show: observed.show,
            position: observed.viewOffset / 1_000, duration: Number(observed.duration || 0) / 1_000,
            positionAt: Date.now() / 1_000,
          } : { deviceId: device.id, state: 'idle' });
        }
      }
    } catch { /* A failed observation is not a stop event. Retry on the next tick. */ }
    finally {
      if (!isStopped) {
        timer = setTimeout(() => { void tick(); }, intervalMs);
        timer.unref();
      }
    }
  };
  void tick();
  return () => { isStopped = true; if (timer) clearTimeout(timer); };
}

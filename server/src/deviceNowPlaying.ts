import { configuredPlaybackTargets } from './playbackTargets.js';
import * as mqttc from './mqttc.js';
import * as playback from './playback.js';
import type { Device, NowPlaying } from './types.js';

/** Secondary clients need telemetry even when they do not advertise Plex Companion. */
export function startDeviceNowPlaying({
  targets = configuredPlaybackTargets(),
  active = () => mqttc.lastState()?.deviceId ?? null,
  read = (device: Device) => playback.currentSession({ device, timeoutMs: 1_000, includeTelemetry: true, throwOnError: true }),
  publish = mqttc.recordDeviceNowPlaying,
  intervalMs = 1_500,
}: {
  targets?: Device[];
  active?: () => string | null;
  read?: (device: Device) => Promise<playback.CurrentSession | null>;
  publish?: (id: string, now: NowPlaying | null) => void;
  intervalMs?: number;
} = {}): () => void {
  let isStopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    const id = active();
    const device = targets.find((d) => d.id === id);
    try {
      if (device) {
        const observed = await read(device);
        if (!isStopped && active() === id) {
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

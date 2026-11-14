// Where Chromium keeps its shared memory during the VRT capture.
//
// Playwright launches Chromium with `--disable-dev-shm-usage` by default, because Docker gives
// a container a 64 MiB `/dev/shm` and a busy browser crashes when that fills. With the flag,
// Chromium creates its shared memory as deleted files in the temp directory instead, and every
// rendered frame and resource buffer moves through those files. On the self-hosted VRT runner,
// `/tmp` is the container's overlay on a ZFS pool, so the capture wrote its frames to disk.
//
// The runner now has a 2 GiB tmpfs at `/dev/shm`. When it has room, the capture drops the flag
// and Chromium keeps its shared memory in RAM. The pixels do not change: shared memory carries
// the same buffers either way. This is the same rule, threshold, and log line as Charcuterie's
// shared capture (`packages/ci/src/vrt/sharedMemory.js` in `Sawtaytoes/charcuterie`).
import { statfs } from 'node:fs/promises';

export const SHARED_MEMORY_PATH = '/dev/shm';

// 512 MiB. Docker's 64 MiB default is the case the Playwright flag exists for.
export const MINIMUM_SHARED_MEMORY_BYTES = 512 * 1024 * 1024;

const DISABLE_DEV_SHM_USAGE = '--disable-dev-shm-usage';

export interface SharedMemoryChoice {
  ignoreDefaultArgs: string[];
  isInMemory: boolean;
  message: string;
}

export const chooseSharedMemory = (availableBytes: number | null): SharedMemoryChoice => {
  const mebibytes = availableBytes === null ? null : Math.floor(availableBytes / (1024 * 1024));

  if (availableBytes !== null && availableBytes >= MINIMUM_SHARED_MEMORY_BYTES) {
    return {
      ignoreDefaultArgs: [DISABLE_DEV_SHM_USAGE],
      isInMemory: true,
      message: `[vrt] Chromium shared memory: ${SHARED_MEMORY_PATH} (${mebibytes} MiB free).`,
    };
  }

  return {
    ignoreDefaultArgs: [],
    isInMemory: false,
    message:
      `[vrt] Chromium shared memory: temp files, because ${SHARED_MEMORY_PATH} ` +
      (mebibytes === null ? 'could not be read.' : `has only ${mebibytes} MiB free.`) +
      ` Give the runner a /dev/shm of at least ${MINIMUM_SHARED_MEMORY_BYTES / (1024 * 1024)} MiB` +
      ' so the capture does not write its frames to disk.',
  };
};

export const readAvailableSharedMemory = async (
  path: string = SHARED_MEMORY_PATH,
): Promise<number | null> => {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
};

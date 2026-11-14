// Where Chromium keeps its shared memory during the VRT capture.
//
// Playwright launches Chromium with `--disable-dev-shm-usage` by default, because Docker gives
// a container a 64 MiB `/dev/shm` and a busy browser crashes when that fills. With the flag,
// Chromium creates its shared memory as deleted files in the temp directory instead, and every
// rendered frame and resource buffer moves through those files. On the self-hosted VRT runner,
// `/tmp` is the container's overlay on a ZFS pool, so the capture wrote its frames to disk.
//
// The runner has a 2 GiB tmpfs at `/dev/shm`. In CI the shared `vrt` workflow puts its tools at
// `$VRT_TOOLS`; their `sharedMemory.js` (Charcuterie `packages/ci/src/vrt/sharedMemory.js`)
// drops the flag when `/dev/shm` has at least 512 MiB free and says which one it chose. The
// pixels do not change: shared memory carries the same buffers either way. Asking that module,
// rather than copying its rule, keeps one threshold and one log line for every capture. Outside
// CI, or with tools that lack the module, Playwright's default stays.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface SharedMemoryChoice {
  ignoreDefaultArgs: string[];
  message: string;
}

interface SharedMemoryModule {
  chooseSharedMemory: (availableBytes: number | null) => SharedMemoryChoice;
  readAvailableSharedMemory: () => Promise<number | null>;
}

/** The `ignoreDefaultArgs` for `chromium.launch`. */
export const chooseVrtSharedMemory = async (): Promise<string[]> => {
  const tools = process.env.VRT_TOOLS;
  if (!tools) return [];

  let sharedMemory: SharedMemoryModule;
  try {
    sharedMemory = (await import(pathToFileURL(join(tools, 'sharedMemory.js')).href)) as SharedMemoryModule;
  } catch {
    console.log('[vrt] Chromium shared memory: temp files, because the shared tools have no sharedMemory.js.');
    return [];
  }

  const choice = sharedMemory.chooseSharedMemory(await sharedMemory.readAvailableSharedMemory());
  console.log(choice.message);
  return choice.ignoreDefaultArgs;
};

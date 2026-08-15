// Install `node:module` resolve hooks that swap server/src/{adb,playback,profiles}.js for the
// stubs in this directory — but ONLY for imports made BY server/src/driver.js, so a test can
// still exercise the real adb.js in the same process (fsm-wake-and-skip-test.mjs does both).
//
// Why hooks and not monkeypatching: ESM namespace objects are frozen, so the Python tests'
// `adb.switch_to = fake` has no equivalent. Resolve hooks are the supported seam.
//
// Parents are matched through ./module-id.mjs rather than by literal filename, so these keep
// working across the .js -> .ts conversion and whatever comes after it. See that file for the
// silent-fallthrough failure this prevents.
import { registerHooks } from 'node:module';
import { parentIs, specifierIs } from './module-id.mjs';

const STUBS = {
  './adb.js': new URL('./adb.stub.mjs', import.meta.url).href,
  './playback.js': new URL('./playback.stub.mjs', import.meta.url).href,
  './profiles.js': new URL('./profiles.stub.mjs', import.meta.url).href,
};

const fromAdb = parentIs('/server/src/adb');
const fromDriver = parentIs('/server/src/driver');

// Swap node:child_process for the scripted stub, but ONLY for server/src/adb — so a test
// can drive the real adb module offline while everything else keeps the genuine module.
export function stubAdbShell() {
  const url = new URL('./child-process.stub.mjs', import.meta.url).href;
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'node:child_process' && fromAdb(ctx)) {
        return { url, shortCircuit: true };
      }
      return next(spec, ctx);
    },
  });
}

export function stubDriverDeps() {
  registerHooks({
    resolve(spec, ctx, next) {
      if (fromDriver(ctx)) {
        for (const [name, url] of Object.entries(STUBS)) {
          if (specifierIs(spec, name)) return { url, shortCircuit: true };
        }
      }
      return next(spec, ctx);
    },
  });
}

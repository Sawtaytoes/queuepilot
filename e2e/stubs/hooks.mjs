// Install `node:module` resolve hooks that swap server/src/{adb,playback,profiles}.js for the
// stubs in this directory — but ONLY for imports made BY server/src/driver.js, so a test can
// still exercise the real adb.js in the same process (fsm-wake-and-skip-test.mjs does both).
//
// Why hooks and not monkeypatching: ESM namespace objects are frozen, so the Python tests'
// `adb.switch_to = fake` has no equivalent. Resolve hooks are the supported seam.
import { registerHooks } from 'node:module';

const STUBS = {
  'adb.js': new URL('./adb.stub.mjs', import.meta.url).href,
  'playback.js': new URL('./playback.stub.mjs', import.meta.url).href,
  'profiles.js': new URL('./profiles.stub.mjs', import.meta.url).href,
};

// Swap node:child_process for the scripted stub, but ONLY for server/src/adb.js — so a test
// can drive the real adb.js offline while everything else keeps the genuine module.
export function stubAdbShell() {
  const url = new URL('./child-process.stub.mjs', import.meta.url).href;
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx && ctx.parentURL ? ctx.parentURL : '';
      if (spec === 'node:child_process' && parent.endsWith('/server/src/adb.js')) {
        return { url, shortCircuit: true };
      }
      return next(spec, ctx);
    },
  });
}

export function stubDriverDeps() {
  registerHooks({
    resolve(spec, ctx, next) {
      const parent = ctx && ctx.parentURL ? ctx.parentURL : '';
      if (parent.endsWith('/server/src/driver.js')) {
        for (const [name, url] of Object.entries(STUBS)) {
          if (spec.endsWith(`./${name}`)) return { url, shortCircuit: true };
        }
      }
      return next(spec, ctx);
    },
  });
}

// Extension-agnostic module identity for the e2e resolve hooks.
//
// WHY THIS EXISTS. Every stub in this directory is installed by a `node:module` resolve hook
// that matches on the PARENT module — "swap `./adb.js`, but only when driver.js is the one
// asking". Those matchers used to be hand-written literals (`parent.endsWith('/server/src/
// driver.js')`). When server/src converted to TypeScript the parent URLs became `…/driver.ts`,
// every literal stopped matching, and — this is the dangerous part — NOTHING ERRORED. A hook
// that never fires just falls through to `next()`, so the harness quietly imported the REAL
// module and went to the live network: binding-token-test.mjs reached plex.example.com, and
// the FSM tests shelled out for a physical Shield.
//
// A silent false pass is the worst failure a test harness has, so the matching is centralised
// here and made extension-blind: a stub keyed on '/server/src/driver' fires for driver.js,
// driver.ts, driver.mts — whatever the file is called next.
//
// The SPECIFIER side is deliberately NOT rewritten by the conversion: server/src files still
// import './adb.js' because NodeNext requires the .js extension on TS source and tsx maps it
// back to .ts. These helpers normalise both sides anyway, so neither can drift again.

// .js/.jsx/.mjs/.cjs and their TS twins — the extensions a source module can wear.
const SOURCE_EXT = /\.[cm]?[jt]sx?$/;

/**
 * Canonical, extension-free, query-free form of a module URL or specifier.
 * `file:///a/server/src/session.ts?bridge-case=2` -> `file:///a/server/src/session`
 */
export function moduleId(url) {
  if (!url) return '';
  const s = String(url);
  const q = s.search(/[?#]/);
  return (q === -1 ? s : s.slice(0, q)).replace(SOURCE_EXT, '');
}

/**
 * Does `url` name one of `paths`, ignoring extension and query?
 * Paths are matched as SUFFIXES so callers pass repo-relative anchors:
 *   isModule(ctx.parentURL, '/server/src/driver')
 * Passing a path WITH an extension is fine — it is normalised the same way.
 */
export function isModule(url, ...paths) {
  const id = moduleId(url);
  return id !== '' && paths.some((p) => id.endsWith(moduleId(p)));
}

/**
 * Curried form, for hooks that test the same parent(s) on every resolve:
 *   const fromDriver = parentIs('/server/src/driver');
 *   resolve(spec, ctx, next) { if (fromDriver(ctx)) … }
 * Accepts either the resolve `context` object or a bare URL string.
 */
export function parentIs(...paths) {
  return (ctxOrUrl) => {
    const url = typeof ctxOrUrl === 'string' ? ctxOrUrl : ctxOrUrl?.parentURL;
    return isModule(url, ...paths);
  };
}

/**
 * Specifier match, extension- and depth-blind: `specifierIs('../playback.js', './playback.js')`
 * is true, so a stub table keyed on './playback.js' still fires for a nested parent that
 * reaches it as '../playback.js'. (That leniency is pre-existing behaviour — the old hooks
 * used `spec.endsWith('./adb.js')` — kept so the stub tables read the same.)
 */
export function specifierIs(spec, ...candidates) {
  const id = moduleId(spec);
  return id !== '' && candidates.some((c) => id.endsWith(moduleId(c)));
}

// How an e2e harness starts the real server as a child process.
//
// Two things changed under the harnesses at once and both are fatal to `spawn('node',
// ['server/src/server.js'])`:
//   1. The Express entry point server.js is gone — the Hono server is server/src/index.ts.
//   2. server/src is TypeScript, so plain `node` can neither load the entry nor resolve the
//      `./foo.js` specifiers inside it. Everything runs through tsx.
//
// tsx is a devDependency of server/, not a global, so the binary is addressed by absolute
// path: a harness may be launched from anywhere, and `--import tsx` would be resolved against
// the cwd, which has no node_modules of its own (there is no root manifest in this repo).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The repo root — e2e/stubs/ is two levels down. */
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const TSX_BIN = path.join(REPO_ROOT, 'server', 'node_modules', '.bin', 'tsx');
export const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'src', 'index.ts');

/**
 * Start the server exactly the way e2e/run.sh does. Options are passed straight to `spawn`,
 * so a caller keeps its own env / stdio; `cwd` defaults to the repo root because several
 * harnesses used to rely on being launched from there.
 *
 * `detached: true` puts the child in its OWN PROCESS GROUP, and that is a correctness fix
 * rather than tidiness. tsx does not become the server: it FORKS node, so the server is this
 * process's GRANDchild. A plain `srv.kill()` reaps only the tsx wrapper, the grandchild
 * reparents to PID 1, and it goes on holding the port.
 *
 * The failure that causes is a FALSE PASS, which is why it matters: the next run's server
 * hits EADDRINUSE and dies, the harness then asserts against the ORPHAN from the previous
 * run — happily green, testing code that may no longer exist — and only exits non-zero later,
 * on an `exit` event that never settles. Three such orphans were found squatting 18768/18790/
 * 21883, one of them started from a harness file that had since been deleted.
 *
 * Callers must therefore stop the server with `killServer(srv)` below, never `srv.kill()`.
 */
export function spawnServer(options = {}) {
  return spawn(TSX_BIN, [SERVER_ENTRY], { cwd: REPO_ROOT, detached: true, ...options });
}

/**
 * Stop a server started by `spawnServer` — the whole process group, so the node grandchild
 * behind the tsx wrapper dies with it.
 *
 * Negating the pid is what addresses the group. Guarded because the group is already gone in
 * the ordinary case where the server exited on its own, and an ESRCH there would abort a
 * harness during cleanup — after its assertions had already passed.
 */
export function killServer(srv, signal = 'SIGKILL') {
  if (!srv || srv.pid === undefined) return;
  try {
    process.kill(-srv.pid, signal);
  } catch {
    // Already reaped, or never made it into its own group: fall back to the direct kill so a
    // lone wrapper still goes away.
    try {
      srv.kill(signal);
    } catch {
      /* nothing left to kill */
    }
  }
}

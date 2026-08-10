// One place that answers "which Playwright, and does its browser actually exist?".
//
// This repo has no node_modules of its own for the browser suites — it borrows a sibling's
// Playwright, which is a deliberate choice (installing a second copy would download another
// ~500 MB of browsers into a repo whose runtime image has no browser at all).
//
// What that choice cost, before this module existed: every suite hardcoded
// `createRequire('/mnt/TrueNAS-Apps/Repos/mux-magic/node_modules/')`. Playwright pins a
// browser BUILD NUMBER to each release, so the moment mux-magic's Playwright moved and
// `/opt/pw-browsers` was refreshed for a different sibling, all sixteen browser suites died
// at once with "Executable doesn't exist at .../chromium_headless_shell-1228/…" — a failure
// that says nothing about this repo and blocks every UI gate.
//
// So: try the known siblings in turn and take the first whose chromium is really on disk.
// A version mismatch now costs nothing as long as SOME sibling matches the installed
// browsers, and when none does the error names the actual problem.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const ROOTS = [
  // This repo's OWN node_modules first, when it has one. The sibling-borrowing below is
  // for the NAS sandbox, where those absolute paths exist; in CI they do not, and Node
  // resolves a nonexistent `/mnt/...` prefix by walking up to `/`, never reaching the
  // checkout — so `npm install playwright` at the repo root (which ci.yml does, and which
  // its comment already assumed worked) was in fact unreachable from here.
  new URL('../node_modules/', import.meta.url).pathname,
  '/mnt/TrueNAS-Apps/Repos/mux-magic/node_modules/',
  '/mnt/TrueNAS-Apps/Repos/castkit/node_modules/',
  '/mnt/TrueNAS-Apps/Repos/charcuterie/node_modules/',
  '/mnt/TrueNAS-Apps/Repos/gallery-downloader/node_modules/',
];

function resolve() {
  const tried = [];
  for (const root of ROOTS) {
    let pw;
    try {
      pw = createRequire(root)('playwright');
    } catch {
      continue; // sibling not checked out / no playwright installed
    }
    let exe = '';
    try {
      exe = pw.chromium.executablePath();
    } catch {
      continue;
    }
    if (existsSync(exe)) return pw;
    tried.push(`${root} -> ${exe}`);
  }
  throw new Error(
    'no usable Playwright found. Install browsers for one of:\n  ' + tried.join('\n  '),
  );
}

const playwright = resolve();

export const { chromium } = playwright;
export default playwright;

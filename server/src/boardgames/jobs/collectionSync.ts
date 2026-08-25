// THE NIGHTLY COLLECTION REFRESH — four steps, in order, in this process.
//
// ── ⚠️ THE STEPS ARE NOT `&&`-CHAINED, AND THAT IS THE DESIGN ────────────────────────────
//
// An upstream outage must not skip the night's rulebook links. Each step runs whatever the one
// before it did, and the response says which ones worked. A chain would make the whole night's
// work depend on the flakiest dependency in it.
//
// ── This runs IN PROCESS, unlike the version it was ported from ──────────────────────────
//
// The absorbed app shelled out to `node .yarn/releases/yarn-<pinned>.cjs <script>` per step,
// four child processes against a repo root found by walking up from `import.meta.url`. That
// cannot work here and should not: the production image ships ONE bundled `server/dist/index.js`
// with no `.ts`, no yarn and no repo. Calling the functions also gets back the error messages
// the old `catch {}` threw away — a step that failed used to report a bare `false`.
import { runEnrich } from './enrich.js';
import { runLinkRulebooks } from './linkRulebooks.js';
import { runLinkVideos } from './linkVideos.js';
import { runSyncBgg } from './syncBgg.js';
import type { CollectionJobResult, OnProgress } from './types.js';

export interface CollectionSyncResult {
  /** How many steps FAILED. A skipped step is not one. */
  failed: number;
  isOk: boolean;
  steps: CollectionJobResult[];
}

/**
 * The order is load-bearing. The collection has to arrive before anything can enrich it, and a
 * title has to exist before a link can point at it.
 */
export async function runCollectionSync(
  onProgress: OnProgress = () => {},
): Promise<CollectionSyncResult> {
  const steps: CollectionJobResult[] = [];

  const record = (result: CollectionJobResult): void => {
    steps.push(result);
    onProgress(`[${result.name}] ${result.isSkipped ? 'skipped: ' : ''}${result.summary}`);
  };

  record(await runSyncBgg(onProgress));
  record(await runEnrich({}, onProgress));
  record(await runLinkRulebooks({}, onProgress));
  record(await runLinkVideos({}, onProgress));

  const failed = steps.filter((step) => !step.isOk).length;
  return { failed, isOk: failed === 0, steps };
}

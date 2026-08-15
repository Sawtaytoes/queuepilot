// One-time PR 4 migration runner: younger/older tier sets → shows_shorts + movies
// function channels (legacy entries kept, marked superseded_by). Idempotent — a second
// run is a no-op. Point SETS_PATH at the registry to migrate:
//
//   SETS_PATH=/config/sets.yaml npx tsx server/migrate-tiers.mts
//
// Run it from a CHECKOUT, not from inside the container: the runtime image ships the
// esbuild bundle (server/dist/index.js) and no longer carries server/src, so there is
// nothing there for this to import. It was already a run-once-by-hand tool — the deploy
// runbook copies sets.yaml to sets.yaml.bak-pr4-<date> first — so this costs nothing
// beyond running it next to the repo instead of next to the app.
import { migrateLegacyTiers, SETS_PATH } from './src/sets.js';

const res = await migrateLegacyTiers();
console.log(`[migrate-tiers] ${SETS_PATH}:`, JSON.stringify(res));
if (!res.migrated && res.reason === 'no legacy tier sets to migrate') process.exitCode = 1;

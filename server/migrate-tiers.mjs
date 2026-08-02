// One-time PR 4 migration runner: younger/older tier sets → shows_shorts + movies
// function channels (legacy entries kept, marked superseded_by). Idempotent — a second
// run is a no-op. Point SETS_PATH at the registry to migrate:
//
//   SETS_PATH=/config/sets.yaml node server/migrate-tiers.mjs
//
// Back up the file first (the deploy runbook copies it to sets.yaml.bak-pr4-<date>).
import { migrateLegacyTiers, SETS_PATH } from './src/sets.js';

const res = await migrateLegacyTiers();
console.log(`[migrate-tiers] ${SETS_PATH}:`, JSON.stringify(res));
if (!res.migrated && res.reason === 'no legacy tier sets to migrate') process.exitCode = 1;

// MIGRATION CLI — upgrade a `queues.yaml` to the object entry form and backfill rating keys.
//
//     server/node_modules/.bin/tsx server/src/tools/migrate-entry-objects.ts [options]
//
//       --file <path>     the queues.yaml to read (default: $QUEUES_PATH, else /config/queues.yaml)
//       --sets <path>     the sets.yaml that says which sections/provider each queue uses
//                         (default: $SETS_PATH, else `sets.yaml` beside the queues file)
//       --apply           WRITE the file. Without it this is a dry run and nothing is written.
//       --backup <name>   backup label (default `objectform`) — `queues.yaml.bak-<name>-<date>`
//       --no-plex         do not talk to Plex: reshape only, backfill nothing
//       --verbose         also list the entries that are already in the target shape
//
// PRINT-FIRST. The dry run is the DEFAULT and prints, entry by entry, exactly what would
// change and exactly what could not be resolved and why. Nothing is written without `--apply`,
// and `--apply` writes a `.bak-<name>-<date>` beside the file first.
//
// The migration itself is `entryObjects.ts`; this file is the report and the I/O. What it
// writes, what it preserves and why it is idempotent are documented there.
//
// A NON-PLEX QUEUE IS NEVER RESOLVED AGAINST PLEX. `manga_webtoons` is a Kavita queue whose
// rating keys are Kavita series ids; its `sections: []` falls back to the Plex movie section,
// so a title lookup there would "resolve" a manga to a film. A queue whose provider is not
// Plex is reshaped, never backfilled, and the report says so.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { Document } from 'yaml';

import { describe, resolveQueueEntry, resolveSections } from '../engine/resolve.js';
import type { ResolveCfg } from '../engine/resolve.js';
import { liveClient } from '../engine/plex-live.js';
import * as routing from '../engine/routing.js';
import { definitionFor } from '../providers/config.js';
import { providerIdForSet } from '../providers/blocks.js';
import { migrateDocument } from './entryObjects.js';
import type { PolicyFor, SetPolicy } from './entryObjects.js';

interface Options {
  file: string;
  sets: string;
  apply: boolean;
  backup: string;
  plex: boolean;
  verbose: boolean;
}

function argFor(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? String(argv[i + 1]) : null;
}

function parseArgs(argv: readonly string[]): Options {
  const file = argFor(argv, '--file') || process.env.QUEUES_PATH || '/config/queues.yaml';
  return {
    file,
    sets: argFor(argv, '--sets') || process.env.SETS_PATH || path.join(path.dirname(file), 'sets.yaml'),
    apply: argv.includes('--apply'),
    backup: argFor(argv, '--backup') || 'objectform',
    plex: !argv.includes('--no-plex'),
    verbose: argv.includes('--verbose'),
  };
}

/** Which provider serves a set, as a kind ('plex', 'kavita', …), or null when unknown. */
function providerKind(cfg: ResolveCfg | undefined): string | null {
  if (!cfg) return null;
  try {
    return definitionFor(providerIdForSet(cfg as Record<string, unknown>))?.kind ?? null;
  } catch {
    // A MIXED set throws by design (providers/blocks.ts). It is not a Plex queue for our
    // purposes, so nothing is backfilled and the report says why.
    return null;
  }
}

/** One entry on one line, for the report. */
const short = (value: unknown): string => JSON.stringify(value);

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const text = await fs.readFile(opts.file, 'utf8');
  const doc: Document = parseDocument(text);
  const registry = routing.loadSets(opts.sets);
  const client = opts.plex ? liveClient() : null;

  console.log('queuepilot — queue entries to the object form');
  console.log(`  file    ${opts.file}`);
  console.log(`  sets    ${opts.sets}`);
  console.log(`  mode    ${opts.apply ? 'APPLY (the file is written)' : 'DRY RUN (nothing is written)'}`);
  console.log(`  plex    ${opts.plex ? 'yes — titles are resolved' : 'no (--no-plex) — reshape only'}`);
  console.log('');

  const policyFor: PolicyFor = (setName) => {
    const cfg = registry?.sets[setName];
    if (!cfg) {
      return {
        label: `${setName}  (not in sets.yaml — reshape only)`,
        resolve: null,
        why: 'this queue is not in sets.yaml',
      };
    }
    const kind = providerKind(cfg);
    if (!client) {
      return {
        label: `${setName}  (${kind ?? 'unknown provider'}, --no-plex)`,
        resolve: null,
        why: 'Plex was not consulted (--no-plex)',
      };
    }
    if (kind !== 'plex') {
      return {
        label: `${setName}  (${kind ?? 'unknown provider'} — not resolved)`,
        resolve: null,
        why: `this queue is served by ${kind ?? 'an unknown provider'}, so a Plex lookup would be wrong`,
      };
    }
    const sections = resolveSections(cfg).join(',');
    const policy: SetPolicy = {
      label: `${setName}  (plex, sections ${sections})`,
      // The ENGINE's own resolver, not a second title matcher — so a backfilled key names the
      // item this entry already plays, and the migration FREEZES today's behaviour rather than
      // choosing a new one.
      resolve: async (value: unknown) => {
        const desc = describe(value);
        const [ratingKey, , title] = await resolveQueueEntry(client, desc, cfg, null);
        // A rating-key entry is asking for its missing CAPTION; a title entry for its key.
        return desc.ratingKey ? (title ?? null) : ratingKey;
      },
      why: `nothing in sections ${sections} answers to this title`,
    };
    return policy;
  };

  const { changes, kept, labels } = await migrateDocument(doc, policyFor);

  for (const [name, label] of labels) {
    console.log(label);
    if (opts.verbose) {
      for (const c of kept) {
        if (c.set === name) console.log(`  [${String(c.index).padStart(3)}] keep       ${short(c.before)}`);
      }
    }
    for (const c of changes) {
      if (c.set !== name) continue;
      console.log(`  [${String(c.index).padStart(3)}] ${c.verdict.padEnd(11)}${short(c.before)}  ->  ${short(c.after)}${c.why ? `   (${c.why})` : ''}`);
    }
    console.log('');
  }

  const by = (v: string) => changes.filter((c) => c.verdict === v);
  const unresolved = by('unresolved');
  // Only a REWRITE is a change to the file. An unresolvable entry that is already an object is
  // reported on every run and edits nothing, so a file holding one is still "nothing to do".
  const rewrites = changes.filter((c) => c.rewritten);
  console.log('summary');
  console.log(`  entries               ${kept.length + changes.length}`);
  console.log(`  already in shape      ${kept.length}`);
  console.log(`  rating key backfilled ${by('backfilled').length}`);
  console.log(`  collections reshaped  ${by('collection').length}`);
  console.log(`  scalars reshaped      ${by('reshaped').length}`);
  console.log(`  UNRESOLVED            ${unresolved.length}`);
  if (unresolved.length) {
    console.log('');
    console.log('UNRESOLVED — these keep their title and gain no rating key. Fix them by hand:');
    for (const u of unresolved) console.log(`  ${u.set}[${u.index}]  ${short(u.before)}   ${u.why ?? ''}`);
  }
  console.log('');

  if (!rewrites.length) {
    console.log('nothing to change — the file is already in the object form.');
    return 0;
  }
  if (!opts.apply) {
    console.log(`DRY RUN — ${rewrites.length} entries would change. Re-run with --apply to write.`);
    return 0;
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backup = `${opts.file}.bak-${opts.backup}-${stamp}`;
  await fs.writeFile(backup, text, 'utf8');
  console.log(`backup written: ${backup}`);

  await withLock(opts.file, async () => {
    // `indentSeq: false` + `lineWidth: 0` — the same `YAML_OUT` `queues.ts` writes with, so the
    // migrated file does not churn against the app's own next write.
    await fs.writeFile(opts.file, doc.toString({ indentSeq: false, lineWidth: 0 }), 'utf8');
  });
  console.log(`applied: ${rewrites.length} entries rewritten in ${opts.file}`);
  return 0;
}

// The SAME mkdir-based advisory lock `queues.ts` takes on `<queues.yaml>.lock`. The running app
// edits this file, so a migration that wrote while the editor held the lock could lose whichever
// write finished second. Re-implemented here rather than imported because `queues.ts` binds its
// lock path to `QUEUES_PATH` at import time, and this tool takes the path as a flag.
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const dir = `${file}.lock`;
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await fs.mkdir(dir);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out acquiring ${dir}`);
      await new Promise<void>((r) => { setTimeout(r, 50); });
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(dir).catch(() => {});
  }
}

process.exit(await main());

#!/usr/bin/env tsx
/**
 * One-shot rewrite of sets.yaml product kinds for the picks|rules cutover
 * (decision 2026-08-23-kind-is-picks-or-rules).
 *
 *   SETS_PATH=/mnt/TrueNAS-Apps/App-Configs/queuepilot/sets.yaml \
 *     server/node_modules/.bin/tsx server/src/tools/migrate-picks-rules-kinds.ts
 *
 * Idempotent. Writes a sibling `.bak-picks-rules-<stamp>` before changing anything.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SETS_PATH = process.env.SETS_PATH || '/config/sets.yaml';
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const bak = `${SETS_PATH}.bak-picks-rules-${stamp}`;

const text = readFileSync(SETS_PATH, 'utf8');
const rawLines = text.split('\n');

const blocks: string[][] = [];
let cur: string[] = [];
for (const line of rawLines) {
  if (/^- id:/.test(line) && cur.length) {
    blocks.push(cur);
    cur = [line];
  } else {
    cur.push(line);
  }
}
if (cur.length) blocks.push(cur);

let changed = 0;
const out: string[] = [];
for (const block of blocks) {
  if (!block.some((l) => /^- id:/.test(l))) {
    out.push(...block);
    continue;
  }
  let source = 'queue';
  let kind: string | null = null;
  let kindI = -1;
  let hasAddAs = false;
  for (let i = 0; i < block.length; i++) {
    const l = block[i]!;
    const sm = /^ {2}source:\s*(\S+)/.exec(l);
    if (sm) source = sm[1]!;
    const km = /^ {2}kind:\s*(\S+)/.exec(l);
    if (km) {
      kind = km[1]!;
      kindI = i;
    }
    if (/^ {2}add_as:/.test(l)) hasAddAs = true;
  }
  if (kindI < 0 || kind == null) {
    out.push(...block);
    continue;
  }
  let newKind = kind;
  let addAs: string | null = null;
  if (source === 'rotation') {
    newKind = 'rules';
  } else if (kind === 'movies' || kind === 'movie' || kind === 'demo') {
    newKind = 'picks';
    addAs = 'priority';
  } else if (kind === 'anime') {
    newKind = 'picks';
    addAs = 'random';
  } else if (kind === 'cartoons' || kind === 'cartoon') {
    newKind = 'rules';
  } else {
    out.push(...block);
    continue;
  }
  const next = [...block];
  if (newKind !== kind) {
    next[kindI] = `  kind: ${newKind}`;
    changed += 1;
  }
  if (addAs && !hasAddAs && source === 'queue') {
    next.splice(kindI + 1, 0, `  add_as: ${addAs}`);
    changed += 1;
  }
  out.push(...next);
}

if (!changed) {
  console.log(`[migrate-picks-rules] ${SETS_PATH} already migrated — no write`);
  process.exit(0);
}

copyFileSync(SETS_PATH, bak);
const body = out.join('\n');
writeFileSync(SETS_PATH, text.endsWith('\n') ? `${body.replace(/\n$/, '')}\n` : body);
console.log(`[migrate-picks-rules] wrote ${SETS_PATH} (${changed} edits); backup ${bak}`);

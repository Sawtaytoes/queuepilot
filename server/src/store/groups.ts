// groups.yaml — the FILE behind QueuePilot's groups.
//
// Moved out of `groups.ts` verbatim: the sync read, the seed header and its exclusive-create
// write, the comment-preserving `Document` round-trip and the atomic write. What stayed in
// `groups.ts` is the identity model itself — normalization, `accountsForSet`, membership
// resolution, the mutations.
//
// This file has NO advisory lock, unlike `sets.yaml` and `queues.yaml`, and that is the state
// it shipped in rather than an omission this move made: no second process writes it.
//
// The reads here SWALLOW a parse error and return an empty document, which the two locked
// stores do not. That is deliberate and predates the seam: this file is OPTIONAL, this process
// also serves the web UI, and losing the whole app to a stray comma in an optional config file
// is the worse failure.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSeq, parse, parseDocument, stringify } from 'yaml';
import type { Document } from 'yaml';

import { errMessage, isNodeError } from '../errors.js';
import { GROUPS_PATH } from '../env.js';

/** Where the file is. Named `path` so no caller outside `store/` spells a `.yaml` constant. */
export const path = GROUPS_PATH;

export function readSync(): Record<string, unknown> {
  try {
    return (parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown> | null) || {};
  } catch (e) {
    // Missing is the normal cold-start case — `groups.ts seedIfMissing()` handles it. Anything else
    // is worth a line but must never crash boot: this process also serves the web UI, and
    // losing the whole app to a stray comma in an OPTIONAL config file is the worse failure.
    if (!isNodeError(e) || e.code !== 'ENOENT') {
      console.log(`[groups] could not read ${path}: ${errMessage(e)}`);
    }
    return {};
  }
}

const SEED_HEADER = `# QueuePilot groups — who is watching, and what is theirs.
#
# A group is what you pick at the top of the app; its id is its URL (/g/<id>), so ids are
# IMMUTABLE and labels are free — rename a label whenever, never change an id.
#
# NOT a Plex profile. Plex's profiles are the accounts on the Shield; a group is ours, and
# may be a person (Bob), an audience (Bob & Alice) or neither (Demo).
#
# Membership, in order:
#   1. sets:      this group claims these set ids outright.
#   2. accounts:  provider kind -> account names. Used ONLY for a set no group listed —
#                 so a set you file by hand stays where you filed it.
#
# accounts is also the identity map: Plex calls Bob 'sawtaytoes', Kavita calls him 'Bob'.
# A group with no accounts is membership by hand (Bob & Alice); a set can be in several.
# 'all' is built in and cannot be defined here.
`;

/** True when the file already exists — the `seedIfMissing()` gate. */
export async function exists(): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the starter file, header and all. Returns false when somebody else got there first.
 *
 * The DERIVATION of these groups is `groups.ts seedIfMissing()`'s job and stayed there; this
 * is only the write, so that the header text and the file's shape live in one place.
 */
export async function seed(groups: readonly unknown[]): Promise<boolean> {
  try {
    await fsp.mkdir(dirname(path), { recursive: true });
    // `wx`: another process (or another worker) may have won the race between the access()
    // above and here, and its file is as good as ours. Losing is not an error.
    await fsp.writeFile(path, `${SEED_HEADER}\n${stringify({ groups })}`, { flag: 'wx' });
    console.log(`[groups] seeded ${path} with ${groups.length} group(s) from the registry`);
    return true;
  } catch (e) {
    if (isNodeError(e) && e.code === 'EEXIST') return false;
    console.log(`[groups] could not seed ${path}: ${errMessage(e)}`);
    return false;
  }
}

export async function readDoc(): Promise<Document> {
  let text = '';
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') throw e;
    text = `${SEED_HEADER}\ngroups: []\n`;
  }
  const doc = parseDocument(text);
  if (!isSeq(doc.get('groups'))) doc.set('groups', doc.createNode([]));
  return doc;
}

export async function writeDoc(doc: Document): Promise<void> {
  // `indentSeq: false` + `lineWidth: 0` match sets.yaml's shape, so the two config files in
  // the same directory do not disagree about how a list looks.
  const text = doc.toString({ indentSeq: false, lineWidth: 0 });
  const tmp = `${path}.tmp`;
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, path);
  } catch {
    // Same fallback sets.ts keeps: a rename across a bind-mount boundary can fail where a
    // plain write succeeds. Losing atomicity beats losing the save.
    await fsp.writeFile(path, text, 'utf8');
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

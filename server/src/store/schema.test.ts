// `schema.sql` and `schema.generated.ts` must agree.
//
// The generated module exists because the production image ships ONLY `server/dist/index.js`
// — no `server/src`, no assets — so a schema read off disk at boot works under tsx and every
// e2e harness and then fails in the container. Node 26 has no `with { type: 'text' }` for a
// `.sql` file either. So the SQL is inlined at build time, and this is the gate that makes a
// forgotten `node server/scripts/generate-schema.mjs` a red CI run rather than a production
// database missing a column.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SCHEMA_SQL } from './schema.generated.js';

describe('schema.sql', () => {
  it('is byte-identical to the generated module', () => {
    const source = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    expect(SCHEMA_SQL).toBe(source);
  });

  it('keys every wire-id table on TEXT, never on a surrogate integer', () => {
    // The one rule that outranks everything else in the file. A set id is what an NFC card
    // carries and what Home Assistant puts in `{"set": "<id>"}`; an INTEGER PRIMARY KEY here
    // would put a translation table between a piece of cardboard and the queue it plays.
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS sets \(\n\s+--[^\n]*\n\s+id\s+TEXT PRIMARY KEY,/);
    expect(SCHEMA_SQL).toMatch(/set_id\s+TEXT PRIMARY KEY,/);
    expect(SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS groups \(\n\s+--[^\n]*\n\s+id\s+TEXT PRIMARY KEY,/);
    expect(SCHEMA_SQL).not.toMatch(/INTEGER PRIMARY KEY AUTOINCREMENT/);
  });

  it('is idempotent — every statement can run over an existing file', () => {
    const creates = [...SCHEMA_SQL.matchAll(/^CREATE (TABLE|INDEX)(?! IF NOT EXISTS)/gm)];
    expect(creates.map((match) => match[0])).toEqual([]);
  });
});

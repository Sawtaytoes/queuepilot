/**
 * A CSV reader small enough to read in one sitting, because the one file it has to handle is
 * a collection export and pulling in a parser for that is more dependency than problem.
 *
 * It handles exactly what the format needs: quoted fields, doubled `""` escapes, embedded
 * commas and newlines, and a header row.
 */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let isQuoted = false;
  let hasField = false;

  const endField = () => {
    row.push(field);
    field = '';
    hasField = false;
  };

  const endRow = () => {
    endField();
    // A trailing newline must not produce a phantom row.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    // `!`: the loop condition `i < text.length` on the line above is what proves this index
    // is in range. Without it `char` reads as `string | undefined` and `field += char` would
    // append the literal text "undefined".
    const char = text[i]!;

    if (isQuoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          isQuoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !hasField) {
      isQuoted = true;
      hasField = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\r') {
      // Ignored: `\n` is what ends the row, so CRLF and LF both land in the same place.
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
      hasField = true;
    }
  }

  if (field !== '' || row.length > 0) endRow();

  return rows;
};

export const parseCsvRecords = (text: string): Record<string, string>[] => {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];

  return rows.map((row) => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      record[key] = row[index] ?? '';
    });
    return record;
  });
};

// ── ONE CSV RECORD → ONE `SourceRow` ─────────────────────────────────────────────────────
//
// The other half of the CSV path. It lands here rather than beside the writer because it is
// about the EXPORT FORMAT — column names, the export's own idea of "unknown" — and nothing
// about the store.
//
// ⚠️ THE EXPORT WRITES `0` FOR "WE DO NOT KNOW" in `avgweight`, `playingtime` and friends.
// Letting a 0 through would make an unrated title the SIMPLEST title in the collection and win
// every complexity filter it should have failed. `toPositiveNumber` is that guard, and it is
// why the numeric readers below do not use `toNumber` directly.

import type { SourceRow } from './bgg.js';

const toNumber = (value: string): number | null => {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toPositiveNumber = (value: string): number | null => {
  const parsed = toNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

/** `"3,4"` → `[3, 4]`. Blank → `[]`. */
const toCounts = (value: string): number[] =>
  value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((count) => Number.isInteger(count) && count > 0);

/** `"8+"` / `"10 and up"` → `8` / `10`. */
const toAge = (value: string): number | null => {
  const match = /(\d+)/.exec(value);
  return match ? Number(match[1]) : null;
};

const toList = (value: string): string[] =>
  value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

export const readCsvRow = (record: Record<string, string>): SourceRow => {
  const best = toCounts(record.bggbestplayers ?? '');
  // The export lists a count under BOTH "best" and "recommended" when it is both. Keeping the
  // overlap would double-count the fitness bonus, so "recommended" here means
  // recommended-but-not-best.
  const recommended = toCounts(record.bggrecplayers ?? '').filter(
    (count) => !best.includes(count),
  );

  return {
    bestWith: best,
    bggId: toPositiveNumber(record.objectid ?? ''),
    kind: record.itemtype === 'expansion' ? 'expansion' : 'standalone',
    maxPlayers: toPositiveNumber(record.maxplayers ?? '') ?? 1,
    maxPlaytime: toPositiveNumber(record.maxplaytime ?? ''),
    minAge: toAge(record.bggrecagerange ?? ''),
    minPlayers: toPositiveNumber(record.minplayers ?? '') ?? 1,
    minPlaytime: toPositiveNumber(record.minplaytime ?? ''),
    name: (record.objectname ?? '').trim(),
    publishers: toList(record.version_publishers ?? ''),
    rating: toPositiveNumber(record.average ?? ''),
    recommendedWith: recommended,
    versionLanguages: toList(record.version_languages ?? ''),
    versionNickname: (record.version_nickname ?? '').trim() || null,
    versionYear: toPositiveNumber(record.version_yearpublished ?? ''),
    weight: toPositiveNumber(record.avgweight ?? ''),
    yearPublished: toPositiveNumber(record.yearpublished ?? ''),
  };
};

// Build-time pre-compression of the Vite output.
//
// Why in-repo and not in the reverse proxy: openresty sits in front of this app but is NOT
// versioned with it, so a compression rule there is invisible to `git log`, invisible to CI,
// and silently absent on any other deployment of the image. Doing it at build time means the
// bytes ship inside the container and `server/src/server.js`'s staticCompressed middleware
// only has to pick the right file.
//
// Brotli at quality 11 is the maximum, which would be absurd per-request but is free here —
// it runs once per build, on assets that are then served thousands of times. gzip is emitted
// beside it for the rare client that negotiates no `br`.
//
// Measured on the 2026-08-03 bundle: 282,615 B of JS → ~72 KB, 93,532 B of CSS → ~13 KB.
import { constants, brotliCompressSync, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'dist', 'assets');

// Only text-ish assets. Images and fonts (woff2) are already compressed; running brotli over
// them costs build time and produces a LARGER file, which the middleware would then serve.
const COMPRESSIBLE = new Set(['.js', '.css', '.svg']);

// Below this, the ~20-byte encoding overhead plus the extra round trip through zlib is not
// worth it, and some proxies mangle tiny encoded bodies.
const MIN_BYTES = 1024;

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // no dist/assets (e.g. a build that emitted nothing) — nothing to do
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

let files = 0;
let raw = 0;
let br = 0;
let gz = 0;

for (const file of walk(ASSETS_DIR)) {
  const ext = path.extname(file);
  if (!COMPRESSIBLE.has(ext)) continue;
  // Never re-compress our own output on a rebuild into a non-empty dist.
  if (file.endsWith('.br') || file.endsWith('.gz')) continue;
  const size = statSync(file).size;
  if (size < MIN_BYTES) continue;

  const buf = readFileSync(file);
  const brBuf = brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      // Telling brotli the uncompressed size lets it size its window optimally.
      [constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  });
  const gzBuf = gzipSync(buf, { level: 9 });

  // A "compressed" file that grew would make the middleware serve MORE bytes than the
  // original. Skip it rather than write it — the middleware falls through when absent.
  if (brBuf.length < size) {
    writeFileSync(file + '.br', brBuf);
    br += brBuf.length;
  }
  else br += size;
  if (gzBuf.length < size) {
    writeFileSync(file + '.gz', gzBuf);
    gz += gzBuf.length;
  }
  else gz += size;

  files += 1;
  raw += size;
}

console.log(
  `[precompress] ${files} file(s): ${kb(raw)} raw -> ${kb(br)} br / ${kb(gz)} gzip`,
);

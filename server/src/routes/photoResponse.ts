import type { Context } from 'hono';

/**
 * The photo as an HTTP answer, with its validators. Shared by `GET /api/people/:id/photo` and
 * the TV's `GET /api/native/people/:id/avatar`, so the two can never disagree about headers.
 */
export function photoResponse(
  c: Context,
  photo: { bytes: Uint8Array; mime: string; version: string },
): Response {
  const etag = `"${photo.version}"`;
  const cacheControl =
    c.req.query('v') === photo.version
      ? 'private, max-age=31536000, immutable'
      : 'private, no-cache';
  const headers = {
    'Cache-Control': cacheControl,
    ETag: etag,
    // The bytes are always our own re-encode, but the header is what stops a browser from
    // second-guessing the declared type.
    'X-Content-Type-Options': 'nosniff',
  };
  const ifNoneMatch = c.req.header('if-none-match') ?? '';
  if (ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { headers, status: 304 });
  }
  return new Response(
    new Uint8Array(photo.bytes.buffer, photo.bytes.byteOffset, photo.bytes.byteLength),
    {
      headers: {
        ...headers,
        'Content-Length': String(photo.bytes.byteLength),
        'Content-Type': photo.mime,
      },
    },
  );
}

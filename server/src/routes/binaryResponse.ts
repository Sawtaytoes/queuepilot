/**
 * The `res.end(buffer)` replacement for the two image proxies (`/api/thumb/:ratingKey` and
 * `/api/providers/:id/cover/:itemId`).
 *
 * `c.body()` is NOT the way to do this: its accepted `Data` is `string | ArrayBuffer |
 * ReadableStream`, so a Node `Buffer` only compiles through a cast — and the obvious cast is
 * a lie twice over. A Buffer is a *view*, often into a SHARED pool for small allocations, so
 * `buffer.buffer` is very often not "these bytes" but "these bytes plus whatever else the
 * pool is holding". Returning a plain `Response` over an explicitly-bounded `Uint8Array`
 * view is both correct and copy-free.
 */
export function binaryResponse({
  buffer,
  cacheControl,
  contentType,
}: {
  buffer: Buffer;
  cacheControl: string;
  contentType: string;
}): Response {
  return new Response(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    { headers: { 'Cache-Control': cacheControl, 'Content-Type': contentType } },
  );
}

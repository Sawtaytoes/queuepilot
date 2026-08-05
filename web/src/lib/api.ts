/**
 * The one fetch wrapper, ported verbatim from `web/app.js`'s `api()`: the server
 * answers `{error}` on a failure, so a non-ok response is turned into a thrown
 * `Error` carrying that message and every call site does its own try/catch with a
 * toast. Keeping that shape means the error strings the user sees are unchanged.
 */
export async function api<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    method,
  })

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }

    throw new Error(payload.error || res.statusText)
  }

  return (await res.json()) as T
}

/**
 * A sentinel `api()` returns for a 304 Not Modified, distinct from any real payload.
 * The SSE refresh path checks for it and skips `setState` entirely — no re-render, no
 * CLS, no gesture disruption. See `apiConditional`.
 */
export const NOT_MODIFIED = Symbol("not-modified")

/**
 * `/api/queues` now sends an ETag (`W/"<qmtime>-<smtime>-<generation>"`), so a GET
 * that carries the last-seen tag as `If-None-Match` comes back `304` with an empty
 * body whenever nothing changed — which is the common case for an SSE storm, where a
 * `now-playing` event fires but the queues didn't move. That makes an SSE-triggered
 * refresh nearly free instead of a full 2.7 s (pre-Phase-B) refetch.
 *
 * The last tag per URL lives in module state. A `304` returns `NOT_MODIFIED`; a `200`
 * records its new tag and returns the parsed body. The main `api()` above is left
 * untouched so every other call site is unchanged.
 */
const etags = new Map<string, string>()

export async function apiConditional<T = unknown>(
  url: string,
): Promise<T | typeof NOT_MODIFIED> {
  const prev = etags.get(url)
  const res = await fetch(url, {
    headers: prev ? { "If-None-Match": prev } : undefined,
    method: "GET",
  })

  if (res.status === 304) return NOT_MODIFIED

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }

    throw new Error(payload.error || res.statusText)
  }

  const tag = res.headers.get("ETag")

  if (tag) etags.set(url, tag)
  else etags.delete(url)

  return (await res.json()) as T
}

/**
 * Poster URL. The `?v=2` cache-buster is part of the 480x720 transcode decision
 * (`2026-07-21-shelf-ui-conventions`) — bump it if the proxy's size changes.
 */
export const thumbUrl = (ratingKey: string | number) =>
  `/api/thumb/${ratingKey}?v=2`

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
 * Poster URL. The `?v=2` cache-buster is part of the 480x720 transcode decision
 * (`2026-07-21-shelf-ui-conventions`) — bump it if the proxy's size changes.
 */
export const thumbUrl = (ratingKey: string | number) =>
  `/api/thumb/${ratingKey}?v=2`

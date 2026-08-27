/**
 * The one fetch wrapper, ported verbatim from `web/app.js`'s `api()`: the server
 * answers `{error}` on a failure, so a non-ok response is turned into a thrown
 * `Error` carrying that message and every call site does its own try/catch with a
 * toast. Keeping that shape means the error strings the user sees are unchanged.
 */
/**
 * How many WRITES this page has made, ever.
 *
 * A background pass that swaps a whole payload in — phase 3's `revalidate()` — asked the
 * server a question whose answer is only true of the files as they were when the request
 * went OUT. That pass takes about seven seconds, so a promote made while it is in flight is
 * already missing from the answer when it arrives, and committing it paints the entry back
 * where it was: the screen undid a move the FILE had kept, about a second after the tap.
 *
 * A caller reads this before its fetch and again after, and drops the payload if the number
 * moved. It counts at CALL time rather than on completion, so a write still in flight counts
 * too — that is the same race one beat earlier.
 *
 * The live path solves the same problem two other ways, and neither one covers this pass: the
 * conditional GET 304s when the YAML has not moved (`?fresh=1` always reads the providers, so
 * it always answers 200), and `uiBusy()` defers a commit landing mid-gesture (a tap on a menu
 * row is not a gesture and leaves nothing busy).
 */
let writes = 0

export const writeCount = () => writes

export async function api<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  if (method !== "GET") writes += 1

  const res = await fetch(url, {
    body: body ? JSON.stringify(body) : undefined,
    headers: body
      ? { "Content-Type": "application/json" }
      : undefined,
    method,
  })

  if (!res.ok) {
    const payload = (await res
      .json()
      .catch(() => ({}))) as { error?: string }

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
    const payload = (await res
      .json()
      .catch(() => ({}))) as { error?: string }

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

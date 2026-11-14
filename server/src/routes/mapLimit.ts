/**
 * Run an async mapper over `items` with bounded concurrency, preserving input order.
 *
 * Two route modules need it — the flattened poster/resolve fan-out in `/api/queues` and the
 * per-member resolve in `/api/sets/:id/members` — so it lives beside them rather than being
 * copied into both. Lifted verbatim from `server.js`.
 */
export async function mapLimit<TItem, TOut>(
  items: readonly TItem[],
  limit: number,
  fn: (item: TItem, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const out = new Array<TOut>(items.length)
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const idx = nextIndex++
          out[idx] = await fn(items[idx] as TItem, idx)
        }
      },
    ),
  )
  return out
}

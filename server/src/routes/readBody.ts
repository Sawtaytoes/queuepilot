import type { Context } from 'hono';

/**
 * `req.body || {}` under `express.json()`, in Hono terms.
 *
 * `express.json()` handed every handler a parsed object OR `{}` — empty body, a
 * non-JSON content-type, a parse failure; none of them ever threw into these handlers — and
 * every handler then wrote `req.body || {}` and destructured with NO validation.
 * `c.req.json()` REJECTS on an empty or malformed body, so the `.catch` here is what
 * preserves that behaviour.
 *
 * Deliberately still permissive, and deliberately `any`-valued: the routes destructure
 * arbitrary user JSON and hand it to the `queues`/`sets` writers, which do their own
 * coercion. Adding validation at this seam would be a behaviour change, not a type fix.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readBody(c: Context): Promise<Record<string, any>> {
  const parsed = await c.req.json().catch(() => null);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

import { createQueryClient } from "@charcuterie/logic/query"

/**
 * The app's single TanStack Query client, built through Charcuterie's blessed
 * `createQueryClient` so the fleet's defaults (and any future fleet-wide default)
 * have one home. See
 * `@charcuterie/logic/query` and the 2026-08-11 data-fetching decision.
 *
 * We keep the shared defaults as-is (retries on for ordinary request/response
 * calls). Per-call opt-outs — e.g. the device menu surfaces a fetch error as UI
 * immediately rather than retrying — are set on the individual `useQuery`.
 *
 * This is the request/response half only. The live SSE refresh channel
 * (`state/live.ts`, `/api/events`) is the push side — the future
 * `@charcuterie/streams` — and is deliberately left untouched.
 */
export const queryClient = createQueryClient()

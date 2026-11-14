import type { Provider } from "../types.js"

/**
 * `provider.profileToken(userUuid)`, called as a method, for the call sites that have never
 * guarded it.
 *
 * `profileToken` is OPTIONAL on `Provider`, but the push start and the reconcile have always
 * called it without a check, so a provider without it throws there. That throw is a latent
 * requirement of those paths, not of the interface, and this keeps it: a guard that skipped
 * the call would change behavior.
 */
export function profileTokenOf(
  provider: Provider,
  userUuid: string | null,
): ReturnType<NonNullable<Provider["profileToken"]>> {
  if (!provider.profileToken)
    throw new TypeError(
      `The ${provider.id} provider has no profileToken`,
    )
  return provider.profileToken(userUuid)
}

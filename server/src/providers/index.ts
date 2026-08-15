// The provider registry — the single place that turns a definition into a live provider.
//
// The engine talks only to the interface below. Nothing above this line may branch on
// `kind`; if it does, the seam has leaked and the next backend will have to leak too.
//
//   buckets(ctx)          -> { play: [...], ... }   the ordered lineup
//   progressState(ctx)    -> provider-shaped progress
//   materialize(items)    -> a runtime artifact descriptor
//   handoff(artifact)     -> how to START it: a push result, or a URL to open
//   delivery              -> 'push' | 'pull'
//
// materialize/handoff is the load-bearing split. Collapsing them into one play() would
// hard-code the push model and lock Kavita out — see decision
// 2026-08-12-backends-are-providers-behind-a-media-neutral-seam.
import type { PlexClient, Provider, ProviderDefinition } from '../types.js';
import type { KavitaHttpClient } from './kavita-client.js';

import { definitions, definitionFor, requireToken, isConfigured } from './config.js';
import { plexProvider } from './plex.js';
import { kavitaProvider } from './kavita.js';

/**
 * The injected client, which is per-KIND: `plex-replay.js` for Plex, a stubbed Kavita HTTP
 * client for Kavita. There is no single "provider client" type and inventing one would be a
 * lie — so this is the union, and each branch below asserts the half its own provider needs.
 * That assertion is exactly as safe as the switch it sits in: `def.kind` chose the branch.
 */
export type InjectedProviderClient = PlexClient | KavitaHttpClient;

/**
 * Instantiate a provider by id.
 * `client` is injected by the parity gates (plex-replay) and by the offline Kavita tests (a
 * stubbed fetch), which is what keeps this seam honest.
 * @throws when the provider is unknown, of an unsupported kind, or NOT CONFIGURED.
 */
export function providerFor(
  id: string,
  { client = null }: { client?: InjectedProviderClient | null } = {},
): Provider {
  const def = definitionFor(id);
  if (!def) throw new Error(`unknown provider '${id}' — not in providers.yaml and not a built-in`);

  switch (def.kind) {
    case 'plex':
      // Plex's token resolution predates this file and stays in config.js (PLEX_TOKEN /
      // PLEX_API_KEY), so there is nothing to require here — plex.js reaches the same
      // credential through plex.js/config.js exactly as it always did.
      return plexProvider({ def, client: client as PlexClient | null });

    case 'kavita': {
      // Fails loudly and by name. Never an empty string, never an unauthenticated request:
      // a placeholder that looks like config produces a working-looking app that quietly
      // talks to nothing, which is how two prior outages reached the couch.
      const apiKey = client ? 'stub' : requireToken(def.id, def.kind);
      return kavitaProvider({ def, apiKey, client: client as KavitaHttpClient | null });
    }

    default:
      throw new Error(
        `provider '${id}' has unsupported kind '${def.kind}' — this build knows plex, kavita`,
      );
  }
}

/**
 * The BROWSER-facing URL for one provider item's cover art.
 *
 * Always built here, never by hand and never client-side, because the browser must not be
 * handed the provider's own image URL: Kavita's wants the API key as a query parameter (the
 * credential-in-URL hazard docs/kavita-feasibility.md flags), so the app re-serves the bytes
 * through /api/providers/:id/cover/:itemId and the key stays server-side. The Plex analogue
 * is /api/thumb/:ratingKey, which the frontend still builds for Plex items.
 */
export const coverUrl = (providerId: string, itemId: string | number): string => (
  `/api/providers/${encodeURIComponent(providerId)}/cover/${encodeURIComponent(itemId)}`
);

/** Every provider that is both supported and configured, ready to serve a queue. */
export function availableProviders(): ProviderDefinition[] {
  return definitions().filter((d) => (
    (d.kind === 'plex' || d.kind === 'kavita') && isConfigured(d.id, d.kind)
  ));
}

export { definitions, definitionFor, isConfigured };

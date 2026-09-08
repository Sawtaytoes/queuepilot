// The one mutable object `e2e/season-window-test.ts` and its `providers/index.js` stub share.
//
// It exists for the reason `stubs/session-harness.mjs`'s `SESSION_CTL` does: a stub spliced in
// by a resolve hook is a data-URL module, so the only way it and the test can hold the same
// array is to import it from a real file by URL. `reconcileQueue` answers `{reconciled: false}`
// whether the season gate stopped it or the provider work failed, so WHETHER IT REACHED THE
// PROVIDER is the only thing that tells the two apart — and that is what this records.
export const RECONCILE_CTL = { providerCalls: [] };

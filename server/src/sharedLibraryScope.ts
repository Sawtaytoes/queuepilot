/** A missing server key means every library granted on that shared server. */
export type SharedLibraryScope = Record<string, string[]>;

export function sharedLibraryScope(raw: unknown): SharedLibraryScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: SharedLibraryScope = {};
  for (const [server, libraries] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9-]+$/.test(server) || !Array.isArray(libraries)) continue;
    const ids = [...new Set(libraries.map(String).map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
    if (ids.length) result[server] = ids;
  }
  return result;
}

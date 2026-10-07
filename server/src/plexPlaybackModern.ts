// New Android TV Plex accepts playback deep links instead of Companion HTTP.
// Keep the server-created playQueue intact; never substitute a single media item.
export function modernQueueLink(serverId: string, queueId: string | number, offsetMs = 0, ratingKey: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(serverId) || !/^\d+$/.test(String(queueId)) || !/^\d+$/.test(ratingKey)) {
    throw new Error('invalid Plex playback queue identity');
  }
  if (!Number.isFinite(offsetMs) || offsetMs < 0) throw new Error('invalid playback offset');
  const key = `/library/metadata/${ratingKey}`;
  const uri = `server://${serverId}/com.plexapp.plugins.library${key}`;
  // This route takes seconds, unlike Companion's millisecond offset.
  return `plex://watch/video?uri=${encodeURIComponent(uri)}&containerKey=${encodeURIComponent(`/playQueues/${queueId}`)}&key=${encodeURIComponent(key)}&offset=${Math.floor(offsetMs / 1000)}`;
}

export function plexOwnsMediaButtons(dump: string | null): boolean {
  return /^\s*Media button session is com\.plexapp\.android\//m.test(dump || '');
}

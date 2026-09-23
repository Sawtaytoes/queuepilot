// Process preload for the finished-live server child. The app's Plex Home helpers use
// global fetch for plex.tv while local Plex calls use undici.request, so this replaces only
// the three plex.tv answers needed to mint the synthetic managed-profile token.
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === 'https://plex.tv/api/v2/home/users') {
    return Response.json([
      {
        title: 'Older Kids', id: 700002, uuid: 'older-kids-uuid', admin: false, restricted: true,
      },
      {
        title: 'Fixture Owner', username: 'fixture-owner', id: 999999, uuid: 'owner-uuid',
        admin: true, restricted: false,
      },
    ]);
  }
  if (url === 'https://plex.tv/api/v2/home/users/older-kids-uuid/switch') {
    return Response.json({ authToken: 'managed-switch-token' });
  }
  if (url === 'https://plex.tv/api/v2/resources?includeHttps=1') {
    return Response.json([
      { clientIdentifier: 'offline-server', accessToken: 'older-kids-server-token' },
    ]);
  }
  return realFetch(input, init);
};

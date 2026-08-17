// v2 API slice (browserless, self-contained — spawns its OWN server on a private port with
// private temp files, no browser/MQTT/Plex). Covers the Node workstreams: remove-completed +
// `done` surfacing (B), collection-typed add + `collections=1` search (C), per-account
// /api/ratings with static fallback (D), and rotation createSet/updateSet knobs (E + I).
// Plex/plex.tv are unreachable here, so the Plex-dependent bits assert the DEGRADED path.
import { killServer, spawnServer } from './stubs/server-process.mjs';
import { promises as fs } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

/**
 * A JSON body off the API. `Response.json()` is honestly `unknown`, and this suite reads
 * deep into payloads the server itself produces (`reg.sets.find(...).starts['777'].season`)
 * on nearly every line. Re-declaring each route's response shape here would be a second
 * copy of server/src/routes that rots on its own; so the cast lives HERE, once, and every
 * read below is deliberately unchecked.
 */
type JsonBody = Record<string, any>;

const PORT = 18772;
const QUEUES = '/tmp/queues-apiv2.yaml';
const SETS = '/tmp/sets-apiv2.yaml';
const HIST = '/tmp/history-apiv2.json';
const env = {
  ...process.env,
  WEB_PORT: String(PORT),
  QUEUES_PATH: QUEUES,
  SETS_PATH: SETS,
  HISTORY_PATH: HIST,
  // Force the Plex-down path deterministically regardless of the caller's env.
  PLEX_API_SERVER_URL: 'https://127.0.0.1:1', // nothing listens → every plex fetch fails fast
  PLEX_TOKEN: '',
  MQTT_HOST: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
};
const ok = (n: string, c: boolean) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}`); if (!c) process.exitCode = 1; };
const api = (p: string, opts?: RequestInit): Promise<JsonBody> =>
  fetch(`http://localhost:${PORT}/api${p}`, opts).then((r) => r.json() as Promise<JsonBody>);
const post = (p: string, body?: unknown) =>
  api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const patch = (p: string, body?: unknown) =>
  api(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

// A queues.yaml with two done entries (mapping w/ done:true) + two plain entries under a
// seeded curated queue (`bob` exists in the default sets.yaml the server writes on boot).
const QUEUES_SEED = `bob:
- "Plain Movie A (2020)"
- {title: "Done Movie B (2019)", done: true}
- {ratingKey: 555, title: "Done Movie C", done: true}
- "Plain Movie D"
`;

for (const f of [QUEUES, SETS, HIST]) {
  await fs.rm(f, { force: true });
  await fs.rm(f + '.lock', { recursive: true, force: true });
}
await fs.writeFile(QUEUES, QUEUES_SEED, 'utf8');

async function startServer(): Promise<ChildProcess> {
  const child = spawnServer({ env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await api('/history'); return child; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('server did not come up');
}
const stop = (child: ChildProcess) => new Promise((r) => { child.once('exit', r); killServer(child); });

const srv = await startServer();
try {
  // --- B: done surfacing + remove-completed ---------------------------------- //
  let q = (await api('/queues')).sets.bob.items;
  ok(`queues surfaces 4 bob items (${q.length})`, q.length === 4);
  const doneCount = q.filter((i: JsonBody) => i.done).length;
  ok(`two entries surface done:true (${doneCount})`, doneCount === 2);
  ok('plain string entry is not done', q.find((i: JsonBody) => i.raw === 'Plain Movie A (2020)')?.done === false);
  ok('mapping w/ done:true is done', q.find((i: JsonBody) => i.raw === 'Done Movie B (2019)')?.done === true);

  const rc = await post('/queues/bob/remove-completed');
  ok(`remove-completed removed 2 (removed=${rc.removed})`, rc.removed === 2);
  q = (await api('/queues')).sets.bob.items;
  ok(`only the 2 plain entries remain (${q.length})`, q.length === 2 && q.every((i: JsonBody) => !i.done));

  const rc2 = await post('/queues/bob/remove-completed');
  ok('remove-completed is idempotent (0 the second time)', rc2.removed === 0);
  const bad = await post('/queues/nope_not_a_set/remove-completed');
  ok('remove-completed 400s on an unknown set', bad.error === 'unknown set');

  // remove-completed goes through the undo snapshot middleware.
  const hist = await api('/history');
  ok(`mutations snapshotted for undo (undo=${hist.undo})`, hist.undo >= 1);

  // --- C: collection-typed add + collections search flag --------------------- //
  const addColl = await post('/queues/bob/items', { type: 'collection', value: { title: 'Marvel Cinematic Universe' } });
  ok('collection add accepted', addColl.added === true);
  q = (await api('/queues')).sets.bob.items;
  ok('collection written as "Collection: <name>" string',
    Boolean(q.find((i: JsonBody) => i.raw === 'Collection: Marvel Cinematic Universe')));
  const addColl2 = await post('/queues/bob/items', { type: 'collection', value: 'Collection: Studio Ghibli' });
  ok('an already-prefixed collection name is not doubled', addColl2.added === true);
  q = (await api('/queues')).sets.bob.items;
  ok('prefixed name kept verbatim (no "Collection: Collection:")',
    Boolean(q.find((i: JsonBody) => i.raw === 'Collection: Studio Ghibli')) &&
    !q.find((i: JsonBody) => /Collection: Collection:/.test(i.raw)));
  const emptyColl = await post('/queues/bob/items', { type: 'collection', value: { title: '' } });
  ok('empty collection name 400s', emptyColl.error === 'empty collection name');

  // Search degrades cleanly (Plex unreachable) with the collections flag on — no throw, [].
  const search = await api('/search?set=bob&q=star&collections=1');
  ok('search?collections=1 degrades to [] with Plex down', Array.isArray(search.results) && search.results.length === 0);

  // --- D: per-account ratings with static fallback --------------------------- //
  // `younger` (seeded default, has user_uuid) → account-token mint fails (no plex.tv) →
  // contentRatings fails (no Plex) → static fallback list.
  const rat = await api('/ratings?set=younger');
  ok('ratings falls back to static list with Plex down',
    Array.isArray(rat.ratings) && rat.ratings.includes('G') && rat.ratings.includes('PG'));
  const ratBad = await api('/ratings?set=does_not_exist');
  ok('ratings 400s on an unknown set', ratBad.error === 'unknown set');

  // --- E + I: create + configure a rotation channel from Node ----------------- //
  const created = await post('/sets', {
    label: 'Tween Zone',
    source: 'rotation',
    kind: 'cartoons',
    sections: [5],
    item_sections: [15],
    allowed_ratings: ['TV-PG', 'PG'],
    movie_ratings: ['PG'],
    blocklist: ['999'],
    plex_user: 'Tween Kids',
    account_id: 424242,
    user_uuid: 'deadbeefcafe0001',
    watch_count_accounts: [424242],
    mode: 'both',
    audio_language: 'jpn',
    movie_excludes: ['111', '222'],
  });
  ok('rotation createSet returns an id', typeof created.id === 'string' && created.id.length > 0);
  const rid = created.id;

  let reg = await api('/sets');
  let ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('created set is a rotation source', ns && ns.source === 'rotation');
  ok('rotation carries user_uuid (previously dropped)', ns.user_uuid === 'deadbeefcafe0001');
  ok('rotation carries watch_count_accounts', Array.isArray(ns.watch_count_accounts) && ns.watch_count_accounts[0] === 424242);
  ok('rotation carries account_id as a number', ns.account_id === 424242);
  ok('rotation carries mode', ns.mode === 'both');
  ok('rotation carries audio_language', ns.audio_language === 'jpn');
  ok('rotation carries movie_excludes', Array.isArray(ns.movie_excludes) && ns.movie_excludes.join(',') === '111,222');
  ok('rotation carries allowed_ratings + movie_ratings',
    ns.allowed_ratings.includes('PG') && ns.movie_ratings.join(',') === 'PG');

  // updateSet: the new rotation knobs are in the allow-list and coerce/persist.
  await patch(`/sets/${rid}`, { mode: 'episodic', audio_language: 'eng', movie_excludes: ['333'], watch_count_accounts: [1, 2] });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('updateSet changed mode', ns.mode === 'episodic');
  ok('updateSet changed audio_language', ns.audio_language === 'eng');
  ok('updateSet changed movie_excludes', ns.movie_excludes.join(',') === '333');
  ok('updateSet changed watch_count_accounts', ns.watch_count_accounts.join(',') === '1,2');

  // Per-show start overrides for the dynamic rule pool (decision
  // 2026-08-07-dynamic-pool-start-override): a {ratingKey: {season, episode}} map that the
  // Channels view writes and reads back to seed the "Start from…" picker. Whole-map replace,
  // and an empty map drops the key — same shape the members[] write uses.
  await patch(`/sets/${rid}`, { starts: { 777: { season: 2, episode: 5 }, 888: { episode: 3 } } });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('updateSet persists starts keyed by ratingKey',
    ns.starts && ns.starts['777'] && ns.starts['777'].season === 2 && ns.starts['777'].episode === 5);
  ok('a single-season start stores just the episode', ns.starts['888'].episode === 3 && ns.starts['888'].season == null);
  // A cleared entry (no episode, no series) is dropped, not stored as an empty object.
  await patch(`/sets/${rid}`, { starts: { 777: { season: 2, episode: 5 } } });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('updateSet whole-map replace drops the omitted key', ns.starts['888'] == null && ns.starts['777'] != null);
  // An empty map removes the field entirely (every show back to natural next-unwatched).
  await patch(`/sets/${rid}`, { starts: {} });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('updateSet empty starts map clears to {}', !ns.starts || Object.keys(ns.starts).length === 0);

  const badMode = await patch(`/sets/${rid}`, { mode: 'bogus' });
  ok('updateSet rejects an invalid mode', /invalid mode/.test(String(badMode.error || '')));
  // id + source are immutable — a patch attempting them is ignored, not applied.
  await patch(`/sets/${rid}`, { source: 'queue', id: 'hacked' });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('source stays rotation (immutable)', ns && ns.source === 'rotation');
  ok('id unchanged (immutable)', Boolean(reg.sets.find((s: JsonBody) => s.id === rid)) && !reg.sets.find((s: JsonBody) => s.id === 'hacked'));

  // A rotation create with NO library at all is ACCEPTED, and means every video library
  // (decision 2026-08-17-no-libraries-checked-means-every-library). It used to be rejected
  // with "at least one library section required", which is what stopped anyone from saying
  // "search all of it".
  const noSecs = await post('/sets', { label: 'Every Lib Chan', source: 'rotation', sections: [] });
  ok('rotation createSet accepts NO library — it means all of them', typeof noSecs.id === 'string' && noSecs.id.length > 0);
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === noSecs.id);
  ok('the unscoped channel persists empty sections', ns && Array.isArray(ns.sections) && ns.sections.length === 0);

  // --- Shorts-only channels: a rotation channel may have no SHOW library ------ //
  // The Younger Kids Shows/Shorts split (2026-07-27) needs a channel that draws purely
  // from item_sections. Before this, `sections: []` was rejected outright, so a
  // Shorts-only channel could be hand-written into sets.yaml but never saved from the UI.
  const shortsOnly = await post('/sets', {
    label: 'Shorts Only', source: 'rotation', kind: 'cartoons',
    sections: [], item_sections: [15],
  });
  ok('rotation createSet allows no show library when item_sections has one',
    typeof shortsOnly.id === 'string' && shortsOnly.id.length > 0);
  const sid = shortsOnly.id;
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === sid);
  ok('shorts-only channel persists empty sections',
    ns && Array.isArray(ns.sections) && ns.sections.length === 0);
  ok('shorts-only channel keeps its item_sections', ns.item_sections.join(',') === '15');

  // Patching sections to [] is fine while item_sections still holds a library...
  const clearSecs = await patch(`/sets/${rid}`, { sections: [] });
  ok('updateSet allows clearing sections when item_sections remain', !clearSecs.error);
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('cleared sections persisted', ns.sections.length === 0 && ns.item_sections.join(',') === '15');

  // ...and so is emptying BOTH: unchecking the last box is a real edit that means "draw
  // from every library", not a save error.
  const emptyBoth = await patch(`/sets/${rid}`, { sections: [], item_sections: [] });
  ok('updateSet allows emptying every library', !emptyBoth.error);
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === rid);
  ok('the emptied scope persisted', ns.sections.length === 0 && ns.item_sections.length === 0);

  // A CURATED queue needs no section either — its search widens to every library instead.
  const curatedNoSecs = await post('/sets', { label: 'Unscoped Queue', sections: [], item_sections: [] });
  ok('curated createSet accepts NO section', typeof curatedNoSecs.id === 'string' && curatedNoSecs.id.length > 0);

  // --- default_profile: the UI-seed hint the Play/Channels dropdowns start on --- //
  // A two-binding rotation channel that names one binding as its default; it must
  // round-trip on create, be re-pointable, and clear back to "no default" (dropdowns
  // then fall back to profiles[0]). (decision 2026-08-07-default-profile-per-channel)
  const dp = await post('/sets', {
    label: 'Default Profile Chan', source: 'rotation', kind: 'cartoons',
    sections: [5], item_sections: [15],
    profiles: [
      { plex_user: 'Younger Kids', account_id: 1, allowed_ratings: ['TV-Y'] },
      { plex_user: 'Older Kids', account_id: 2, allowed_ratings: ['TV-PG'] },
    ],
    default_profile: 'Older Kids',
  });
  const dpid = dp.id;
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === dpid);
  ok('createSet persists default_profile', ns && ns.default_profile === 'Older Kids');
  ok('default_profile channel has explicit profiles', ns.has_explicit_profiles === true);

  await patch(`/sets/${dpid}`, { default_profile: 'Younger Kids' });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === dpid);
  ok('updateSet re-points default_profile', ns.default_profile === 'Younger Kids');

  await patch(`/sets/${dpid}`, { default_profile: '' });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === dpid);
  ok('updateSet clears default_profile to null', ns.default_profile == null);
  await api(`/sets/${dpid}`, { method: 'DELETE' });

  // --- Queue flags: keep_completed / reel / remove_completed_after (Set editor) --- //
  // These lived hand-YAML only until the SetModal exposure; the API must round-trip
  // them so the UI can read and write. (decision 2026-08-08-set-modal-queue-flags)
  const playlist = await post('/sets', {
    label: 'Playlist Queue', kind: 'movies', sections: [1],
    keep_completed: true, remove_completed_after: '24h',
  });
  const plid = playlist.id;
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === plid);
  ok('createSet persists keep_completed', ns && ns.keep_completed === true);
  ok('createSet persists remove_completed_after', ns && ns.remove_completed_after === '24h');
  ok('createSet leaves reel false when unset', ns && ns.reel === false);

  await patch(`/sets/${plid}`, { reel: true });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === plid);
  ok('updateSet reel:true lands', ns.reel === true);
  ok('updateSet reel implies keep_completed on normalize', ns.keep_completed === true);

  await patch(`/sets/${plid}`, { reel: false, keep_completed: false, remove_completed_after: '' });
  reg = await api('/sets');
  ns = reg.sets.find((s: JsonBody) => s.id === plid);
  ok('updateSet clears reel', ns.reel === false);
  ok('updateSet clears keep_completed', ns.keep_completed === false);
  ok('updateSet blank remove_completed_after → null (keep forever)', ns.remove_completed_after == null);

  // Rotation channels reject the queue-only knobs (they have no consumption model).
  const rotReject = await patch(`/sets/${sid}`, { keep_completed: true });
  ok('rotation rejects keep_completed', /only valid on curated queues/.test(String(rotReject.error || '')));
  const rotRejectTtl = await patch(`/sets/${sid}`, { remove_completed_after: '7d' });
  ok('rotation rejects remove_completed_after', /only valid on curated queues/.test(String(rotRejectTtl.error || '')));
  await api(`/sets/${plid}`, { method: 'DELETE' });

  // --- Rotation channels are now DELETABLE (2026-07-27; was blocked before) ---- //
  const del = await api(`/sets/${sid}`, { method: 'DELETE' });
  ok('rotation channel deletes (no longer blocked)', del.deleted === true);
  reg = await api('/sets');
  ok('deleted rotation channel is gone from the registry', !reg.sets.find((s: JsonBody) => s.id === sid));
  const delMissing = await api(`/sets/${sid}`, { method: 'DELETE' });
  ok('deleting an already-gone set reports not-deleted', delMissing.deleted === false);
} finally {
  await stop(srv);
}
console.log('done');

import { Hono } from 'hono';
import * as enginePreview from '../engine/preview.js';
import * as engineRouting from '../engine/routing.js';
import { errMessage } from '../errors.js';
import * as mqttc from '../mqttc.js';
import * as providerBlocks from '../providers/blocks.js';
import { coverUrl, providerFor } from '../providers/index.js';
import * as sets from '../sets.js';
import { lastNow, withContext } from '../sse.js';
import { readBody } from './readBody.js';

/** Playback + channels, over the MQTT bridge: devices, play, session state, now-playing. */
export function playbackRoutes(): Hono {
  const app = new Hono();

  // The "Play on ▾" dropdown — the Python service's retained device registry.
  app.get('/devices', (c) => {
    if (!mqttc.connected()) return c.json({ error: 'MQTT not connected', devices: [] }, 503);
    return c.json({ devices: mqttc.devices() });
  });

  // Start a queue/channel on a device. Body: {set, kind?, target?}. kind normally comes
  // from the registry; the two overrides mirror the physical cards: set='auto' lets the
  // Shield's signed-in profile pick the tier, and kind='movie' on a rotation set plays
  // that tier's Movies channel (weighted rewatch) instead of the shows rotation.
  app.post('/play', async (c) => {
    const { set: setId, kind: kindReq, target, profile, only } = await readBody(c);
    const tgt = target ? String(target) : undefined;
    // PR 4: an explicit profile names the binding on a profiles[] function channel (the
    // Play-landing profile selector); the auto path keeps letting the Shield decide.
    const prof = profile ? String(profile) : undefined;
    // The grid's per-tile ▶: play ONE entry of a curated set. Only a curated set has entries
    // to name, so asking for one on a rotation channel is a request error rather than a
    // silently-ignored field — a rotation's pool is a rule, and nothing in it has a key.
    const entryKey = only ? String(only) : undefined;
    try {
      if (setId === 'auto') {
        if (entryKey) return c.json({ error: 'set "auto" cannot play a single entry' }, 400);
        return c.json({ sent: mqttc.play('auto', kindReq === 'movie' ? 'movie' : 'cartoons', tgt) });
      }
      const s = await sets.getSet(String(setId || ''));
      if (!s) return c.json({ error: 'unknown set' }, 400);
      if (entryKey && s.source !== 'queue') {
        return c.json({ error: `'${s.label || s.id}' is a rule-based channel — it has no entries to play one of` }, 400);
      }
      const kind = s.source === 'rotation'
        ? (kindReq === 'movie' ? 'movie' : 'cartoons')
        : s.kind === 'anime' ? 'anime' : 'movie';
      return c.json({ sent: mqttc.play(s.id, kind, tgt, prof, entryKey) });
    } catch (e) {
      return c.json({ error: errMessage(e) }, 503);
    }
  });

  // Last session state (retained plex-channels/state) — the play-result toast's source.
  app.get('/state', (c) => c.json({ state: mqttc.lastState(), mqtt: mqttc.connected() }));

  // Which queue is live, and what's on screen. `set` comes from the session state (the queue
  // we STARTED) — authoritative for "which queue is active" in a way the Plex-side payload
  // can't be, since Plex has no idea our queues exist.
  app.get('/now', async (c) => {
    // A retained payload can land before the first fetch, so fall back to resolving it here.
    const now = lastNow() || (await withContext(mqttc.lastNowPlaying()));
    const st = mqttc.lastState();
    return c.json({ now, set: st?.set || null, kind: st?.kind || null, mqtt: mqttc.connected() });
  });

  // Channels view: a rotation set's eligible pool, computed in-process by the engine.
  app.get('/generic/:id/preview', async (c) => {
    try {
      const s = await sets.getSet(c.req.param('id'));
      if (!s || s.source !== 'rotation') return c.json({ error: 'not a rotation channel' }, 400);

      // A PULL channel's pool is its provider's, not the Plex engine's. Without this the
      // Channels view renders "Empty" for a reading channel that in fact has a full lineup —
      // previewRotation walks Plex sections, and a Kavita channel has none.
      if (s.delivery === 'pull') {
        // Spread, not `s`: see the note in providers/launcher.ts — `BlockSourceCfg`'s index
        // signature is satisfied by an anonymous object type but never by an interface.
        const block = providerBlocks.resolveSingle({ ...s });
        const p = providerFor(block.provider);
        // `pool()` is optional on the Provider surface. The JS called it unconditionally and a
        // provider without one produced a TypeError that this try/catch turned into a 503; the
        // explicit throw keeps that exact status and body shape with a message that names the
        // provider instead of naming a property.
        if (typeof p.pool !== 'function') throw new Error(`${p.label} does not compute a pool`);
        const pool = await p.pool({ libraries: block.libraries, members: (s.members || []).map(String) });
        // Returned as `buckets`, the SAME key and shape the Plex preview uses, so the Channels
        // grid renders a reading pool with no second code path. See kavita.js pool().
        return c.json({
          id: s.id,
          label: s.label,
          provider: block.provider,
          delivery: 'pull',
          // `cover` is the one field the Plex shape has no equivalent of: a Plex bucket's
          // artwork is /api/thumb/<ratingKey>, which the frontend builds from the id it already
          // has. A provider id needs its provider's proxy instead, so the URL is sent.
          // `unit` goes with it: the shape is Plex's, and Plex's next-up line counts EPISODES.
          // A reading bucket's number is a chapter, so the tile must say "Ch 113", not "E113".
          buckets: pool.map((b) => ({
            ...b,
            cover: coverUrl(block.provider, b.ratingKey),
            unit: p.unit || 'episode',
          })),
        });
      }

      const profile = c.req.query('profile') ?? '';
      // Widened on purpose: `previewRotation()` has no declared return type yet, so TS infers
      // the narrow shape of its first `return` literal and rejects the `routing` field this
      // route bolts on afterwards. A `RotationPreview` interface exported from
      // engine/preview.ts is the real fix — that file belongs to another agent this round.
      const node: Record<string, unknown> = await enginePreview.previewRotation(s.id, profile);
      try {
        node.routing = engineRouting.forSet(s.id, profile);
      } catch (e) {
        console.log(`[engine] routing preview failed for ${s.id}: ${errMessage(e)}`);
      }
      return c.json(node);
    } catch (e) {
      return c.json({ error: errMessage(e) }, 503);
    }
  });

  return app;
}

// The photo's HTTP doors: set, read, revalidate, remove — and the TV avatar preferring it.
//
// decision 2026-10-22-a-person-photo-is-a-row-in-the-book-of-record. The normalizer itself is
// `personPhoto.test.ts`; this file is the contract a caller sees. It runs against a throwaway
// book of record in a temp directory, never `/config`. The cast is Ada, Grace and Linus.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Hono } from 'hono';

const directory = mkdtempSync(join(tmpdir(), 'qp-person-photo-'));

let api: Hono;
let people: typeof import('../store/db/people.js');
let photos: typeof import('../store/db/personPhotos.js');

beforeAll(async () => {
  // Set BEFORE the first import: `config.ts` reads both at module load.
  process.env.STORE_PATH = join(directory, 'queuepilot.sqlite');
  process.env.QUEUES_PATH = join(directory, 'queues.yaml');
  const { Hono } = await import('hono');
  const { peopleRoutes } = await import('./peopleRoutes.js');
  const { nativeTvRoutes } = await import('./nativeTvRoutes.js');
  const { undoSnapshot } = await import('./undoSnapshot.js');
  people = await import('../store/db/people.js');
  photos = await import('../store/db/personPhotos.js');

  const root = new Hono();
  const inner = new Hono();
  inner.use('*', undoSnapshot('/api'));
  inner.route('/', peopleRoutes());
  inner.route('/', nativeTvRoutes());
  root.route('/api', inner);
  api = root;

  for (const [position, name] of ['Ada', 'Grace', 'Linus'].entries()) {
    people.upsertPerson({ displayName: name, id: name.toLowerCase(), position });
  }
});

afterAll(async () => {
  const { closeBookOfRecord } = await import('../store/db/open.js');
  closeBookOfRecord();
  rmSync(directory, { force: true, recursive: true });
});

/** A JPEG with an invented camera make and GPS block, so "stripped" can be proved. */
const jpegWithLocation = (): Promise<Buffer> =>
  sharp({ create: { background: '#3a7bd5', channels: 3, height: 600, width: 900 } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'FixtureCam' },
      IFD3: { GPSLatitude: '51/1 30/1 0/1', GPSLatitudeRef: 'N' },
    })
    .toBuffer();

const put = (id: string, body: Uint8Array, type = 'image/jpeg') =>
  api.request(`/api/people/${id}/photo`, {
    body,
    headers: { 'content-type': type },
    method: 'PUT',
  });

describe('PUT /api/people/:id/photo', () => {
  it('stores a raw-body JPEG as a 512 px WebP with no metadata', async () => {
    const res = await put('ada', new Uint8Array(await jpegWithLocation()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      photo: { height: number; mime: string; url: string; version: string; width: number };
    };
    expect(body.photo).toMatchObject({ height: 512, mime: 'image/webp', width: 512 });
    expect(body.photo.url).toBe(`/api/people/ada/photo?v=${body.photo.version}`);

    const stored = photos.readPersonPhoto('ada');
    expect(stored?.version).toBe(body.photo.version);
    const meta = await sharp(stored?.bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(Buffer.from(stored?.bytes ?? []).toString('latin1')).not.toContain('FixtureCam');
  });

  it('takes a multipart upload in the `photo` field', async () => {
    const form = new FormData();
    form.append(
      'photo',
      new Blob([new Uint8Array(await sharp({ create: { background: '#d58a3a', channels: 4, height: 300, width: 300 } }).png().toBuffer())], { type: 'image/png' }),
      'grace.png',
    );
    const res = await api.request('/api/people/grace/photo', { body: form, method: 'PUT' });
    expect(res.status).toBe(200);
    expect(photos.readPersonPhoto('grace')?.mime).toBe('image/webp');
  });

  it('refuses a multipart form with no file in it', async () => {
    const form = new FormData();
    form.append('photo', 'not a file');
    const res = await api.request('/api/people/linus/photo', { body: form, method: 'PUT' });
    expect(res.status).toBe(400);
  });

  it('reads the type from the BYTES — a GIF labelled image/jpeg is a 415', async () => {
    const gif = await sharp({ create: { background: '#000', channels: 3, height: 8, width: 8 } })
      .gif()
      .toBuffer();
    const res = await put('linus', new Uint8Array(gif), 'image/jpeg');
    expect(res.status).toBe(415);
    expect(photos.readPersonPhoto('linus')).toBeNull();
  });

  it('answers 404 for somebody who is not on the roster', async () => {
    const res = await put('nobody', new Uint8Array(await jpegWithLocation()));
    expect(res.status).toBe(404);
  });

  it('refuses an oversized body with 413 before it is read whole', async () => {
    const res = await put('linus', new Uint8Array(16 * 1024 * 1024), 'application/octet-stream');
    expect(res.status).toBe(413);
  });
});

describe('GET /api/people/:id/photo', () => {
  it('serves the bytes with an ETag, and a 304 when the client already has them', async () => {
    const res = await api.request('/api/people/ada/photo');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const etag = res.headers.get('etag');
    expect(etag).toBe(`"${photos.readPersonPhoto('ada')?.version}"`);

    const again = await api.request('/api/people/ada/photo', {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(again.status).toBe(304);
  });

  it('is immutable when the URL names the current version, and only then', async () => {
    const version = photos.readPersonPhoto('ada')?.version;
    const current = await api.request(`/api/people/ada/photo?v=${version}`);
    expect(current.headers.get('cache-control')).toContain('immutable');
    const stale = await api.request('/api/people/ada/photo?v=0000000000000000');
    expect(stale.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('answers 404 for somebody with no photo, so a face falls back to initials', async () => {
    expect((await api.request('/api/people/linus/photo')).status).toBe(404);
    expect((await api.request('/api/people/nobody/photo')).status).toBe(404);
  });
});

describe('GET /api/people', () => {
  it('projects the photo VERSION, never the bytes', async () => {
    const res = await api.request('/api/people');
    const body = (await res.json()) as {
      people: { id: string; photoVersion: string | null }[];
    };
    const byId = new Map(body.people.map((p) => [p.id, p]));
    expect(byId.get('ada')?.photoVersion).toBe(photos.readPersonPhoto('ada')?.version);
    expect(byId.get('linus')?.photoVersion).toBeNull();
    expect(Object.keys(byId.get('ada') ?? {}).sort()).toEqual([
      'displayName',
      'id',
      'photoVersion',
      'position',
    ]);
  });
});

describe('GET /api/native/people/:id/avatar', () => {
  it('serves the QueuePilot photo first, with no Plex call', async () => {
    const res = await api.request('/api/native/people/ada/avatar');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('etag')).toBe(`"${photos.readPersonPhoto('ada')?.version}"`);
  });
});

describe('DELETE /api/people/:id/photo', () => {
  it('removes the photo, and a second delete is a no-op rather than an error', async () => {
    const first = await api.request('/api/people/grace/photo', { method: 'DELETE' });
    expect(await first.json()).toMatchObject({ ok: true, removed: true });
    const second = await api.request('/api/people/grace/photo', { method: 'DELETE' });
    expect(await second.json()).toMatchObject({ ok: true, removed: false });
    expect((await api.request('/api/people/grace/photo')).status).toBe(404);
    expect((await api.request('/api/people/nobody/photo', { method: 'DELETE' })).status).toBe(404);
  });

  it('goes with the person — removing somebody cascades their photo', () => {
    expect(photos.readPersonPhoto('ada')).not.toBeNull();
    people.deletePerson('ada');
    expect(photos.readPersonPhoto('ada')).toBeNull();
    expect(photos.photoVersionsByPerson().has('ada')).toBe(false);
  });
});


describe('person-card chooser photos', () => {
  it('projects the owned versioned photo, changes its URL on replacement, and omits absent photos', async () => {
    const { chooserPerson } = await import('../chooserCatalog.js');
    const first = await sharp({ create: { background: '#126faa', channels: 3, height: 64, width: 64 } }).png().toBuffer();
    expect((await put('grace', new Uint8Array(first), 'image/png')).status).toBe(200);
    const selected = chooserPerson('grace');
    expect(selected).toEqual({ id: 'grace', name: 'Grace', artworkPath: `/api/people/grace/photo?v=${photos.readPersonPhoto('grace')?.version}` });
    const response = await api.request(selected!.artworkPath!);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(photos.readPersonPhoto('grace')!.bytes));
    const replacement = await sharp({ create: { background: '#aa6f12', channels: 3, height: 64, width: 64 } }).png().toBuffer();
    expect((await put('grace', new Uint8Array(replacement), 'image/png')).status).toBe(200);
    expect(chooserPerson('grace')?.artworkPath).not.toBe(selected?.artworkPath);
    photos.deletePersonPhoto('grace');
    expect(chooserPerson('grace')).toEqual({ id: 'grace', name: 'Grace' });
    expect(chooserPerson('missing')).toBeUndefined();
  });
});

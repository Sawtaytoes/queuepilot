// The upload normalizer: what is accepted, what is refused, and what survives the re-encode.
//
// Every input is GENERATED here with sharp — no binary fixture, and no real photograph. The
// GPS block in the "strips the location" case is invented coordinates, not anybody's house.
import { crc32 } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  MAX_PHOTO_UPLOAD_BYTES,
  normalizePersonPhoto,
  PHOTO_EDGE,
  PhotoRejected,
  sniffImageType,
} from './personPhoto.js';

const solid = (width: number, height: number) =>
  sharp({
    create: { background: { b: 160, g: 90, r: 40 }, channels: 3, height, width },
  });

/** A JPEG carrying an EXIF orientation, a camera make and a GPS position. */
const jpegWithLocation = (): Promise<Buffer> =>
  solid(800, 400)
    .jpeg()
    .withExif({
      IFD0: { Make: 'FixtureCam', Model: 'Fixture 1', Software: 'fixture' },
      IFD3: {
        GPSLatitude: '51/1 30/1 0/1',
        GPSLatitudeRef: 'N',
        GPSLongitude: '0/1 7/1 0/1',
        GPSLongitudeRef: 'W',
      },
    })
    .toBuffer();

const rejection = async (input: Uint8Array): Promise<PhotoRejected> => {
  try {
    await normalizePersonPhoto(input);
  } catch (e) {
    if (e instanceof PhotoRejected) return e;
    throw e;
  }
  throw new Error('expected a rejection');
};

/** A PNG whose header claims `width` x `height` with a token IDAT — enough for a decoder to read
 *  the dimensions and refuse, which is the decompression-bomb shape. */
const pngClaiming = (width: number, height: number): Buffer => {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

describe('sniffImageType', () => {
  it('reads JPEG, PNG and WebP from their magic bytes', async () => {
    expect(sniffImageType(await solid(4, 4).jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniffImageType(await solid(4, 4).png().toBuffer())).toBe('image/png');
    expect(sniffImageType(await solid(4, 4).webp().toBuffer())).toBe('image/webp');
  });

  it('refuses everything else, whatever it would be called', async () => {
    expect(sniffImageType(await solid(4, 4).gif().toBuffer())).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    // A RIFF container that is not WebP — a WAV.
    expect(sniffImageType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('normalizePersonPhoto', () => {
  it('stores a centre-cropped 512 px square WebP', async () => {
    const photo = await normalizePersonPhoto(await solid(800, 400).png().toBuffer());
    expect(photo.mime).toBe('image/webp');
    expect([photo.width, photo.height]).toEqual([PHOTO_EDGE, PHOTO_EDGE]);
    const meta = await sharp(photo.bytes).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([PHOTO_EDGE, PHOTO_EDGE]);
    expect(photo.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('strips EXIF and GPS — the re-encode keeps no metadata at all', async () => {
    const upload = await jpegWithLocation();
    // The fixture really does carry the block, or the assertion below proves nothing.
    expect((await sharp(upload).metadata()).exif?.toString('latin1')).toContain('FixtureCam');

    const photo = await normalizePersonPhoto(upload);
    const meta = await sharp(photo.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(photo.bytes.toString('latin1')).not.toContain('FixtureCam');
    expect(photo.bytes.toString('latin1')).not.toContain('Exif');
  });

  it('turns a photo upright from its EXIF orientation before cropping', async () => {
    // 600 x 300 landscape pixels tagged "rotate 90° CW to display" — a portrait phone photo.
    // Left half red, right half blue: upright, red is on TOP.
    const halves = await sharp({
      create: { background: { b: 255, g: 0, r: 0 }, channels: 3, height: 300, width: 600 },
    })
      .composite([
        {
          input: await sharp({
            create: { background: { b: 0, g: 0, r: 255 }, channels: 3, height: 300, width: 300 },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const photo = await normalizePersonPhoto(halves);
    const { data } = await sharp(photo.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const at = (y * PHOTO_EDGE + x) * 3;
      return { b: data[at + 2] as number, r: data[at] as number };
    };
    // Rotated 90° clockwise, the LEFT (red) half is on top.
    expect(pixel(256, 40).r).toBeGreaterThan(200);
    expect(pixel(256, 470).b).toBeGreaterThan(200);
  });

  it('refuses a type it was not built for, with 415', async () => {
    expect((await rejection(await solid(8, 8).gif().toBuffer())).status).toBe(415);
    expect(
      (await rejection(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).status,
    ).toBe(415);
  });

  it('refuses an empty or a damaged file with 400', async () => {
    expect((await rejection(new Uint8Array())).status).toBe(400);
    const jpeg = await solid(64, 64).jpeg().toBuffer();
    expect((await rejection(jpeg.subarray(0, 40))).status).toBe(400);
  });

  it('refuses an upload over the byte cap with 413, before decoding it', async () => {
    const huge = Buffer.alloc(MAX_PHOTO_UPLOAD_BYTES + 1);
    huge.set([0xff, 0xd8, 0xff]);
    expect((await rejection(huge)).status).toBe(413);
  });

  it('refuses a small file that would decode into a huge bitmap', async () => {
    const bomb = pngClaiming(20_000, 20_000);
    expect(bomb.byteLength).toBeLessThan(200);
    const refused = await rejection(bomb);
    expect(refused.status).toBe(400);
    expect(refused.message).toMatch(/too many pixels/);
  });
});

// Turning an uploaded picture into the one shape QueuePilot stores: a 512 x 512 WebP with no
// metadata.
//
// ── Nothing the browser sends is kept ────────────────────────────────────────────────────
//
// An upload is a phone photo, a screenshot, or a picture saved out of another app. Every one
// of those can carry EXIF, and a phone photo usually carries GPS — the exact location of the
// house. So the stored bytes are never the uploaded bytes: the image is decoded, turned upright
// from its EXIF orientation, center-cropped to a square, scaled to 512 px and re-encoded. sharp
// writes NO metadata unless asked (`withMetadata` / `keepExif` are never called here), so the
// EXIF and GPS blocks do not survive the re-encode; `personPhoto.test.ts` proves it on a JPEG
// that carries both.
//
// ── The type comes from the BYTES, never from a header ───────────────────────────────────
//
// `Content-Type` and a file name are the uploader's claims. The magic bytes are what the
// decoder will actually run on, so they are the gate: JPEG, PNG and WebP, and nothing else.
// SVG is refused on purpose — it is a document that can carry script, not a picture — and so
// are GIF, HEIC and AVIF, which the owner's devices do not produce for this.
//
// ── Why sharp ────────────────────────────────────────────────────────────────────────────
//
// It is ALREADY a runtime dependency (`boardgames/enrich/images.ts` squares box art with it),
// already external in `build-server.mjs`, and already installed in the runtime image. It wraps
// libvips. Provenance, checked for the no-Chinese-origin rule: sharp is Lovell Fuller's
// (UK), libvips is John Cupitt's and Kirk Martinez's (UK, University of Southampton origin).
// Nothing new enters the lockfile.
import { createHash } from 'node:crypto';

import sharp, { type OutputInfo } from 'sharp';

/** The square edge, in pixels. Twice the largest face any screen draws (the TV's 70 dp at
 *  ~2x density is ~140 px; the web's largest is under 40 CSS px at 3.75 DPR), with room. */
export const PHOTO_EDGE = 512;

/** The largest UPLOAD accepted, before decoding. A 12 MP phone JPEG is 3–6 MB; 15 MiB leaves
 *  room for a 50 MP one and refuses a mistake (a video, a RAW) before it is read into memory. */
export const MAX_PHOTO_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * The largest image DECODED, in pixels. A small file can still decompress into a huge bitmap
 * (a "decompression bomb"), and the byte cap above cannot see that. 100 MP covers every phone
 * camera's default mode with room; sharp refuses anything larger before allocating it.
 */
export const MAX_PHOTO_INPUT_PIXELS = 100_000_000;

export type SniffedImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** What the stored row holds. */
export interface NormalizedPhoto {
  bytes: Buffer;
  mime: 'image/webp';
  width: number;
  height: number;
  /** A hash prefix of `bytes` — the ETag and the web's cache-buster. */
  version: string;
}

/** A refusal the route turns into a status code. */
export class PhotoRejected extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
  ) {
    super(message);
    this.name = 'PhotoRejected';
  }
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  bytes.length >= at + signature.length && signature.every((value, i) => bytes[at + i] === value);

/** The image type the magic bytes say, or null when they are not one of the three accepted. */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  // JPEG: SOI marker followed by the start of another marker.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG: the full eight-byte signature, which exists precisely to be unambiguous.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // WebP: a RIFF container whose form type is WEBP.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp';
  return null;
}

/**
 * Validate and re-encode one upload. Throws `PhotoRejected` with the status to answer.
 *
 * The crop is the CENTER square, deliberately not sharp's `attention` strategy: the people
 * editor previews the upload with `object-fit: cover`, which is a center crop, so the preview
 * a person approves is the picture that gets stored.
 */
export async function normalizePersonPhoto(upload: Uint8Array): Promise<NormalizedPhoto> {
  if (upload.byteLength === 0) throw new PhotoRejected('the upload is empty', 400);
  if (upload.byteLength > MAX_PHOTO_UPLOAD_BYTES) {
    throw new PhotoRejected(
      `a photo may be at most ${MAX_PHOTO_UPLOAD_BYTES / 1024 / 1024} MB; this one is ${(upload.byteLength / 1024 / 1024).toFixed(1)} MB`,
      413,
    );
  }
  if (!sniffImageType(upload)) {
    throw new PhotoRejected('a photo must be a JPEG, PNG, or WebP image', 415);
  }

  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await sharp(upload, {
      // A truncated or corrupt file is refused rather than stored half-grey.
      failOn: 'error',
      limitInputPixels: MAX_PHOTO_INPUT_PIXELS,
    })
      // Upright from the EXIF orientation BEFORE the crop, or a portrait phone photo is
      // cropped sideways. The orientation tag itself is then gone with the rest of the EXIF.
      .autoOrient()
      .resize(PHOTO_EDGE, PHOTO_EDGE, { fit: 'cover', position: 'center' })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new PhotoRejected(
      /pixel limit/i.test(message)
        ? 'the image has too many pixels to process'
        : 'the image could not be read — it may be damaged',
      400,
    );
  }

  return {
    bytes: output.data,
    height: output.info.height,
    mime: 'image/webp',
    version: createHash('sha256').update(output.data).digest('hex').slice(0, 16),
    width: output.info.width,
  };
}

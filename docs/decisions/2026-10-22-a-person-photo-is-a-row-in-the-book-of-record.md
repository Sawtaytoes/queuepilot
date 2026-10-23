# A person's photo is QueuePilot's own, and it is a row in the book of record

- **Status:** Accepted
- **Date:** 2026-10-22
- **Type:** Product / storage / UI / API
- **Supersedes:** —
- **Superseded by:** —

## Decision

1. **QueuePilot owns a photo per person.** It is uploaded in the people editor and shown
   everywhere a face is drawn: the people filter chips, landing cards, shelf headings, the queue
   trays, the Tonight checklist, the group editor, the Add-to menus and the TV.
2. **It is stored as a ROW**, `person_photos` in `/config/queuepilot.sqlite`: `person_id`
   (primary key, foreign key to `people` with `ON DELETE CASCADE`), `mime`, `bytes` (BLOB,
   CHECK 1 byte to 1 MiB), `width`, `height`, `version` (a SHA-256 prefix of the bytes) and
   `updated_at`. Not a directory under `/config`, and never `cache.sqlite`.
3. **The stored bytes are never the uploaded bytes.** `server/src/personPhoto.ts` takes the
   type from the magic bytes — JPEG, PNG or WebP, nothing else — refuses an upload over
   **15 MiB** (413) or a decode over **100 MP** (400), turns the picture upright from its EXIF
   orientation, center-crops it to **512 x 512** and re-encodes it as WebP at quality 82. sharp
   writes no metadata unless asked, so EXIF and GPS do not survive.
4. **The API:**
   - `PUT /api/people/:id/photo` — the raw image as the body (`Content-Type` is ignored for
     the type decision), or `multipart/form-data` with the file in a `photo` field. Answers
     `{ok, photo: {version, url, mime, width, height, bytes}}`. 404 no such person, 413 too
     large, 415 not JPEG/PNG/WebP, 400 unreadable.
   - `GET /api/people/:id/photo` — the WebP, with `ETag: "<version>"` and a 304 on
     `If-None-Match`. `?v=<current version>` answers `Cache-Control: private, max-age=31536000,
     immutable`; anything else `private, no-cache`. 404 when there is no photo.
   - `DELETE /api/people/:id/photo` — `{ok, removed}`; idempotent. 404 no such person.
   - `GET /api/people` gains `photoVersion` (null when there is none). The bytes never ride on
     a list read.
   - The writes sit behind exactly the door the other roster writes use; there is no separate
     guard and none is weaker.
5. **The TV avatar prefers the owned photo.** `GET /api/native/people/:id/avatar` serves the
   `person_photos` row first and falls back to the single Plex Home thumb, as before. The TV
   player only ever loads that URL, so it needs no change.
6. **The web face is Charcuterie's `Avatar`.** `PersonFace` stops being a hand-rolled circle
   and adapts the library component: it chooses the photo URL (with the version in it) and keys
   the color on the id. A group never has a photo. Every face is the library's `sm` step.
7. **The editor:** each row in the people editor has a **Photo** button that opens a panel
   with a Charcuterie `FileDropZone` (file picker and drop) plus paste. A chosen picture is
   previewed in the same center circle the server will crop to, and is uploaded only on
   **Save photo**. **Remove photo** deletes it.
8. **A photo write is not undoable.** `undoSnapshot.ts` skips `/people/:id/photo`, for the
   board-game routes' reason: the row lives in no snapshot, so an undo would restore files that
   never changed.
9. **No schema version bump.** The table is additive, no older image reads it, and its only
   rule that touches other rows — the cascade — is SQLite's own. A rollback keeps working and
   shows initials.

## Context

Before this a face was a colored initial on every web screen. The TV drew a Plex Home user's
`thumb`, and only for a person holding exactly one Plex account. Most household Plex accounts
have no picture, so the TV showed placeholders too. The household's pictures exist in other
apps, and none of them is a source QueuePilot can read.

`@charcuterie/ui` gained an `Avatar` with an `imageUrl` and an initials fallback after
`PersonFace` was written as a stand-in for exactly that gap. It also ships `FileDropZone`. The
fleet survey (`rg -uu` over the app repos) found no shared image-crop component; the crop is
done on the server, where it can be center-only and predictable.

## Why

- **A row and not a file.** The bytes are small and bounded — about 20–60 KB each after the
  re-encode, under a megabyte for a whole roster — so storage cost is not a reason to leave
  the database. In exchange: `queuepilot.sqlite` stays the ONE file a restore puts back; the
  foreign key removes a person's photo in the same transaction as the person; and an upload
  is a single UPSERT that no reader can see half-written. `cache.sqlite` is deletable by
  design and would lose the owner's data on a schema bump.
- **Re-encode everything.** A phone photo carries GPS — the house's location — and EXIF that
  says which phone. Stripping by re-encoding cannot miss a block the way a metadata editor
  can, and it also makes every stored picture the same size and format, so the TV and the web
  both decode a 512 px WebP and nothing larger.
- **Magic bytes, not headers.** A header is the uploader's claim; the bytes are what the decoder
  runs on. SVG is refused because it is a document that can carry script.
- **sharp.** Already a runtime dependency (board-game box art), already external in the
  server bundle and installed in the runtime image, so nothing new enters the lockfile.
  Provenance for the no-Chinese-origin rule: sharp is by Lovell Fuller (UK); libvips by John
  Cupitt and Kirk Martinez (UK, University of Southampton origin).
- **Center crop, not saliency.** The preview in the editor is a center `object-fit: cover`. A
  saliency crop on the server would store a different square from the one the person approved.
- **The version in the URL.** A replaced photo is a new URL, so the old one can be cached for a
  year and a stale face is impossible.
- **Charcuterie's `Avatar` over a photo in the hand-rolled circle.** Adding an `<img>` to the
  stand-in would be fixing a shared shape per app. The library one already handles a photo that
  fails to load. Faces repaint to the library's categorical colors, keyed on the same id, so
  a rename still does not move anybody's color.
- **One size.** At this app's density the library's `sm` Avatar is about 30 px, which is
  larger than the old 26 px face and big enough to recognize a photo. `md` (about 34 px) made
  initials heavier than the names printed beside them. The old 19 px face has no library step;
  an `xs` would be a Charcuterie change.

## Evidence

The owner, 2026-10-22, relayed verbatim by the orchestrating agent (chat id not available to
the implementing agent): *"None of my family members have pictures. We should add those to
QueuePilot itself. We have them in various apps."*

- `server/src/personPhoto.test.ts` — the type gate, the 512 px square, the EXIF/GPS strip on a
  JPEG that carries both, the orientation, and the byte, damage and decompression-bomb refusals.
- `server/src/routes/personPhotoRoutes.test.ts` — the HTTP contract: raw and multipart PUT,
  415 by bytes, 404, 413, ETag and 304, `immutable` only on the current `?v=`, the projection,
  the TV avatar preferring the owned photo, idempotent DELETE, and the cascade.
- `e2e/smoke/person-photos.spec.ts` — the editor in all four windows: choose, preview, save,
  the face draws the photo, paste previews, remove, and no sideways overflow.
- `e2e/shot-person-photos.ts` — the before/after screenshots on the pull request.

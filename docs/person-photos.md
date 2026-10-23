# Person photos

Every person on the roster can have a photo. QueuePilot stores it and shows it wherever that
person's face appears: the people filter, the queue cards and shelves, the queue editor, What to
Watch/Play, and the TV app. A person with no photo keeps the colored initials.

The design and its reasons are in
[the decision record](decisions/2026-10-22-a-person-photo-is-a-row-in-the-book-of-record.md).

## Set a photo in the app

1. Open **People**, then **Edit people**.
2. Press **Photo** on the person's row.
3. Choose a file, drop one on the box, or paste an image.
4. Check the preview. The photo is cropped to a square from the center.
5. Press **Save photo**.

**Remove photo** in the same panel removes it. A photo change cannot be undone with Undo.

## What is stored

- JPEG, PNG and WebP are accepted. The type is read from the file's contents, not from its
  name or the request header.
- The largest upload is 15 MiB, and the largest image is 100 megapixels.
- Every upload is turned upright, cropped to a centered square, resized to 512 x 512 and saved
  as WebP. All metadata is removed, including EXIF camera data and GPS location.
- The photo is a row in `/config/queuepilot.sqlite` (table `person_photos`), so a backup of
  that file includes it. Removing a person removes their photo.

## API

The photo routes have the same access as the other roster edits.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| `PUT` | `/api/people/:id/photo` | The image bytes, or `multipart/form-data` with the file in a `photo` field | `200 {ok, photo: {version, url, mime, width, height, bytes}}`. `404` no such person, `413` too large, `415` not JPEG/PNG/WebP, `400` unreadable |
| `GET` | `/api/people/:id/photo` | — | `200 image/webp` with an `ETag`, `304` for a matching `If-None-Match`, `404` when there is no photo |
| `DELETE` | `/api/people/:id/photo` | — | `200 {ok, removed}`. Removing a photo that is not there answers `removed: false`. `404` no such person |

`GET /api/people` includes `photoVersion` for each person, or `null`. A photo URL that names the
current version, `/api/people/:id/photo?v=<photoVersion>`, may be cached permanently; any other
photo request revalidates.

`GET /api/native/people/:id/avatar`, which the TV app loads, returns the QueuePilot photo first
and falls back to the person's Plex Home picture.

### Upload with curl

```sh
# The raw image as the body:
curl -X PUT --data-binary @photo.jpg -H 'Content-Type: image/jpeg' \
  http://<queuepilot-host>:8768/api/people/<person-id>/photo

# Or as a form upload:
curl -X PUT -F photo=@photo.jpg http://<queuepilot-host>:8768/api/people/<person-id>/photo
```

The person id is the `id` from `GET /api/people`.

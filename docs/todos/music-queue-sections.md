# Parked: playing a SECTION of a music track

- **Status:** Parked — worth looking into, not scoped; do not build until asked
- **Date:** 2026-09-01
- **Asked from:** the video-section work
  ([`2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror`](../decisions/2026-09-01-a-start-point-carries-a-position-and-end-is-its-mirror.md))

## The ask

> "Also could be useful for music. We don't have that functionality for music queues yet, but
> document that we might wanna look into it. At least, for music videos, it's just regular Plex,
> and pulling a part for queued content is super beneficial."

## What is already true, so nobody builds the wrong half

**A music VIDEO needs nothing.** It is an ordinary Plex video item and travels the same Plex
push path as any other video, so it gets `start.position_ms` / `end.position_ms` the day the
video work ships. The demo-reel case — a chorus, a specific verse, the bit with the good bass —
already works on it. That half is done, not parked.

**A music TRACK is the parked part, and QueuePilot does not queue music at all today.** The five
providers are Plex (video), Kavita, Board Game Picker, Steam and MiSTer. There is no audio
provider, no audio queue, and no audio player QueuePilot commands. Music in this household is
Music Assistant, which owns its own queue, its own players and its own transport.

So this is not "add two fields to an existing music queue". It is at least three questions, and
they should be answered in this order:

## The questions, in order

1. **Whose queue is it?** Either QueuePilot grows a Music Assistant provider — a `push`
   provider, since MA has an addressable player and a real transport, unlike the four `pull`
   providers — or the section idea moves to Music Assistant and QueuePilot stays out of audio.
   Nothing else in this doc matters until that is settled. The Music Assistant MCP already
   exposes `queue_*`, `playback_seek`, `playback_play_index` and `players_*`, so the seam
   exists; the question is whether a second queue system is wanted at all.

2. **Does the provider capability flag already answer it?** The video work puts a
   "can play a section" capability on the provider, following `stampsQueuedAt`. A Music Assistant
   provider would declare it `true` and inherit the whole entry-level model — `start.position_ms`,
   `end.position_ms`, both optional, the window on the first played unit — with no new data model.
   That is the strongest argument for doing it as a provider rather than as a separate feature.

3. **What is a "unit" for audio?** For video it is an episode or a film. For audio it is a track,
   but a queue entry might reasonably name an album or a playlist, in which case the
   first-unit-only rule needs the same look it got for video.

## What is genuinely different about audio

- **A gapless boundary matters more.** Cutting a video at a mark and skipping is fine; doing the
  same mid-phrase in a song is audible in a way a video cut is not. Whether a section needs a
  fade or a crossfade at its edges is a real question the video work never had to ask.
- **Sub-second accuracy matters more.** The video work's latency budget targets a boundary
  landing within a second or so. That is generous for a film and obvious for a hook.
- **Music Assistant may already do this.** Check before building anything: MA has its own queue
  model and its own seek. If it can express a per-item window, the answer may be to drive it
  rather than to re-implement it.

## Do not

- Do not add an audio arm to the Plex provider. Plex music is a different section type, a
  different player path and a different transport; the capability flag exists precisely so a
  provider that cannot serve a section offers no control for it.
- Do not build a music queue as a side effect of a section feature. If QueuePilot is going to
  queue music, that is its own decision with its own record.

---
status: reference
tier: operator
---

# Database storage and media staging

How media is stored in SQLite, how its writes are bounded, how much free space admission needs, and how long video conversion takes. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

Uploaded and imported media stay in SQLite as encrypted 4 MiB chunks. Format v2 stores each chunk as one raw
AES-GCM BLOB (a format byte, IV, tag and ciphertext), within about 0.1% of the raw file. Chunks written before this
release (format v1: base64 JSON sealed and then base64 again, about 1.78 times the raw file) remain readable and drain
within the 30-minute upload lifetime; retained originals are read in either format. `AMCP_MEDIA_CHUNK_FORMAT=v1` keeps
writing v1 for one release, so a rollback to an older release can still read new uploads.

`secure_delete` stays ON (owner decision D24), so deleted media is overwritten. Writes are bounded instead:

- Staging writes one chunk per transaction and the manifest last; removal withdraws the manifest first and then
  erases one chunk per statement. An interrupted staging or removal leaves only unreadable chunks, which the 15-second
  maintenance timer (and every later cleanup) erases. The backup snapshot strips chunks the same way.
- `journal_size_limit` is 64 MiB. After deletions, the maintenance timer runs `wal_checkpoint(TRUNCATE)` when no job
  holds a lease; it never waits, and a busy result is retried on the next tick.
- Freed pages are reused, but the database file does not shrink without a `VACUUM`; its size is a high-water mark.
- Not yet bounded: keeping a retained original still copies all of its chunks (up to the 128 MiB media limit) in one
  transaction, so that one write path can still grow the WAL by about the file's stored size (about 1 times the raw
  size with v2, instead of 1.78 times with v1). Free-space admission counts that copy; `journal_size_limit` returns
  the WAL to 64 MiB after the next checkpoint.

`npm run benchmark:media-storage` stages and removes one synthetic 32 MiB file per format on a temporary database
(`-- --check` exits non-zero outside the bounds). On the review workstation (2026-10-09) the staging peak was 1.127
times the encoded size in both formats (the review's scratch measurement of the earlier code found about 2 times,
because one transaction held the whole file in the WAL), the deletion log peaked at 1.01 chunks, and v2 stored 1.001
times the raw size.

Before admitting media, AMCP reads the free space of the database volume. A website upload (at its declared size), a
link or Drive import (at the 128 MiB media limit, since its size is not known yet), a review or variant staging (at
its exact size) and a retained copy are refused with retryable `STORAGE_LOW` (HTTP 503) when free space would fall
below twice the stored size plus a floor: `AMCP_STORAGE_FLOOR_MB` when set (0 to 65536), otherwise the larger of
256 MiB and 10% of the volume, capped at 1 GiB. If free space cannot be read, nothing is refused. On a small volume
this refuses large imports early; size the volume for the expected media (at least 4 GiB is a reasonable start) or
lower the floor deliberately.

Transactions retry only their `BEGIN IMMEDIATE` after `SQLITE_BUSY`, with jittered pauses, for at most 5 seconds in
total including SQLite's own wait (the same five seconds a single `BEGIN` could wait before); nothing has run when BEGIN
fails, so every kind of work may retry it. The wait blocks the HTTP process, so it is not longer than before.

### Video conversion time

`npm run benchmark:media-variants` uses the FFmpeg and ffprobe named by `AMCP_FFMPEG_PATH` and `AMCP_FFPROBE_PATH`. It
makes a synthetic 180-second 1080p H.264/AAC source (a moving test pattern with camera-like noise, about 98 MiB),
converts it to five preset variants with the production settings (libx264 veryfast, CRF 23, two threads) and reports
each time, whether the streams were copied, and the share of `VIDEO_CONVERSION_TIMEOUT_MS`. `-- --check` exits non-zero
when a conversion takes more than half of the limit; `-- --seconds=N` shortens the source and `-- --source=2160p`
measures a 4K source, which fit also converts.

Measured on the review workstation (FFmpeg 9.0, i7-12700H), which other builds shared at varying CPU load:

| Run | Landscape contain | Vertical crop | Vertical contain | Portrait contain | Square crop | Fit |
|---|---|---|---|---|---|---|
| 2026-10-11, light load | 63.7 s | 46.5 s | 42.6 s | 45.9 s | 42.4 s | no conversion |
| 2026-10-12, heavy load | 135.6 s | 167.2 s | 97.6 s | 110.8 s | 105.5 s | no conversion |
| 2026-10-12, after the changes below | 2.9 s (copied) | 147.6 s | 103.2 s | 44.9 s | 41.1 s | no conversion |

A 60-second 2160p source took 113.6 s to fit to 1920 × 1080 and 86.6 s for a vertical crop (2026-10-11).

The first run used 53% of the earlier 120-second limit, so `VIDEO_CONVERSION_TIMEOUT_MS` became 180 seconds, still
inside the five-minute reservation a variant or review holds while it is prepared (a fit conversion also uses part of
that review's five minutes). Under heavy load the earlier limit would have refused two variants, and the vertical
crop used 93% of the new one, so two conversions now do less work instead of the limit growing further (MED-04):

- A video already stored at the preset's exact size as upright H.264 (yuv420p, square pixels) with AAC or no audio is
  copied into the MP4 variant without re-encoding, as fit already does for media that fits.
- A crop cuts the centered region of the preset's shape and scales only that region (a 608 × 1080 region of a 1080p
  frame for vertical), instead of scaling the whole frame up and discarding most of it. On a 30-second clip at the same
  load this took 21–29 s instead of 31–33 s; the encode, not the scaling, remains most of the time.

What remains: a noisy 180-second 1080p source turned vertical stays the slowest case and kept less than twice its time
under heavy load; on a host that slow it can reach the limit and is refused with `MEDIA_CONVERSION_TIMEOUT`, never cut
short. A 180-second 2160p source that fits the 128 MiB media limit needs about three times the 60-second times above,
so its fit or crop variant is refused the same way. A noisy 1080p variant re-encoded to 1920 × 1080 comes close to the
128 MiB media limit, and a larger output is refused with `MEDIA_TOO_LARGE`. The production image (FFmpeg 5.1 in the
Docker build) has not been measured; run the same command in the container before relying on its headroom.

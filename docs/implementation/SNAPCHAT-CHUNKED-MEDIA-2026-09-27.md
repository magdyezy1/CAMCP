# Snapchat chunked media upload — 2026-09-27

Base revision: `fefc545` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: the reviewed media import sent every Snapchat file with the simple upload, which Snap limits
to 32 MB. Longer or higher-quality Top Snap videos are often larger, so they could not be uploaded
through AMCP, and the chunked upload actions were blocked writes.

Contract source: Snap Marketing API, [Media](https://developers.snap.com/api/marketing-api/Ads-API/media)
("Upload large media files"), read on 2026-09-27. Key facts:

- Files larger than 32 MB are uploaded in chunks of at most 32 MB, at most 32 chunks (1 GB).
- `POST /v1/media/{media_id}/multipart-upload-v2?action=INIT` with `file_name`, `file_size` and
  `number_of_parts` returns `upload_id`, `add_path` and `finalize_path`.
- Each part is posted to `add_path` with `file`, `part_number` and `upload_id`, in any order.
- `finalize_path` with `upload_id` completes the media after every part; it returns the media in
  `result`, like the simple upload.
- All three are multipart form posts. The documentation example returns paths naming a different
  media ID from the INIT request.

## Change

`src/media-upload.ts`, Snapchat branch of the reviewed media import:

| Part | Behaviour |
|---|---|
| Choice | Up to 32,000,000 bytes (32 MB in either unit) keeps the simple upload; larger files use chunks |
| Parts | 16 MiB each, below the part limit in either unit; AMCP's 512 MiB maximum needs at most 32 parts |
| INIT | Multipart form with the reviewed file name, exact size and part count |
| Paths | `add_path` and `finalize_path` must name the allocated media and their action; otherwise `MEDIA_RESPONSE_INVALID` before any part |
| ADD | Parts in order with `part_number` from 1; a part response that is not `SUCCESS` stops the upload |
| FINALIZE | Only after every part; the result must name the media and the selected account |
| Progress | Upload ID, part count, confirmed parts and bytes, and the start of finalization are journaled |
| Recovery | An interrupted upload is uncertain and is neither resumed nor retried; a new review can target the same `existing_media_id` |

`src/transport.ts` sends a multipart form without a file part only for Snapchat
`multipart-upload-v2` INIT and FINALIZE. `src/media-routing.ts` routes the native INIT action
(three aliases) with a Drive link to the same reviewed import into that existing, owned media; the
raw ADD and FINALIZE actions stay blocked. The ownership of an `existing_media_id` is now checked
before the Drive download instead of after it.

Other code: `src/provider-contracts.ts` (Snapchat contract version 8). Guidance:
`Skills/amcp-campaign-builder/references/media.md`.

## Tests

`tests/snapchat-chunked-media.test.mjs`, six tests:

1. A 33,000,000-byte video is uploaded once in two parts with exact INIT, ADD and FINALIZE forms, the parts reassemble to the reviewed bytes, and a replay sends nothing.
2. A video of exactly 32,000,000 bytes keeps the simple upload.
3. The native INIT action prepares a reviewed import into an owned media allocation (an unowned one is refused before any download); the raw ADD action stays blocked.
4. INIT paths for another media stop before any part; a lost part response is uncertain, is not finalized or retried, and recovery shows one confirmed part without resume.
5. Field-only multipart forms are refused outside the Snapchat INIT and FINALIZE paths without requests.
6. The ledger lists the three INIT actions as the media workflow and keeps ADD and FINALIZE blocked.

Red/green against a build of `fefc545`: five of the six tests fail (no chunked upload, no field-only forms, the INIT actions still blocked); the exactly-32,000,000-byte test passes, since the base always used the simple upload. Local log:
`.runtime/snapchat-chunked-media-20260927/red-check.log`.

## Verification

- Targeted: 148 related suite files, including every DV360, Snapchat, media, scope and security suite, with FFmpeg
  configured: 1,769/1,769.
- Guidance coverage: 266 write-path refusals across 146 modules accounted for.
- Full qualification: see
  [SNAPCHAT-CHUNKED-MEDIA-VERIFICATION-2026-09-27.json](SNAPCHAT-CHUNKED-MEDIA-VERIFICATION-2026-09-27.json).

Remaining rows: 884 (three Snapchat rows move to the media workflow; Snapchat blocked writes
89 → 86). Live acceptance is unverified; it needs the updated deployment, a Drive video over
32 MB and a Snapchat ad account.

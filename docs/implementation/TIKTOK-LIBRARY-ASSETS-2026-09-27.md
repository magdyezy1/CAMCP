---
status: record
tier: engineering
---

# TikTok asset library edits — 2026-09-27

Base revision: `d397f7c` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: images and videos reach the TikTok asset library through the media workflow, but they could
not be renamed or removed. The two rename routes (each under two action names) and the creative
asset deletion were five blocked-write rows.

Contract source, read in the rendered TikTok API for Business documentation on 2026-09-27:

- "Update the name of an image" (`POST /v1.3/file/image/ad/update/`) and "Update the name of a
  video" (`POST /v1.3/file/video/ad/update/`): `image_id` or `video_id` and `file_name`, 1–100
  characters. "If another image uses the same file name under the same advertiser_id, there will
  a millisecond timestamp added at the end" (videos alike); longer names are cut to 100
  characters. Replies carry empty data.
- "Delete creative assets" (`POST /v1.3/creative/asset/delete/`): `video_ids` and `image_ids`, at
  most 50 each; the reply lists `failed_video_ids` and `failed_image_ids`. Deleting an asset that
  ads use is not described.
- "Search for images" and "Search for videos" (`GET /v1.3/file/image/ad/search/` and
  `/file/video/ad/search/`): `filtering` by up to 100 IDs, with `file_name` in each row.

## Change

New reviewed family `tiktok_library_assets` (`src/tiktok-library-assets.ts`), five rows:

| Part | Behaviour |
|---|---|
| Request | Rename one image or video (1–100 characters without leading or trailing spaces); delete 1–50 images and/or 1–50 videos |
| State | The named images and videos from the ID-filtered searches (ID and name only; preview URLs change hourly); for deletions every ad and Upgraded Smart+ ad with the videos and images it names |
| Checks | Unknown assets and unchanged names are refused; an asset an ad or Upgraded Smart+ ad uses is not deleted (`ASSET_IN_USE`, AMCP's rule) |
| Safety | Nothing serves differently, so no spending confirmation; deletions count under owner deletion policies |
| Receipt | A non-zero `code`, or failed IDs in a deletion reply, is a failure never resubmitted (the other assets may already be gone) |
| Verification | The asset searched again: the sent name, or the sent name with TikTok's 13-digit timestamp when the name was taken; deleted assets gone |

New refusal codes: `INVALID_TIKTOK_LIBRARY_ASSET` and `ASSET_IN_USE`; `STATE_NOT_FOUND` is reused.

Other code: `src/preflight.ts` (spending exemption), `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (TikTok
contract version 28). Guidance: "TikTok asset library edits" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-library-assets.test.mjs`, four tests:

1. An image and a video are renamed through both action names and verify; a name another image already has verifies with TikTok's timestamp; a replay sends nothing.
2. Two unused images and a video are deleted in one request and verify gone; images and videos an ad or an Upgraded Smart+ ad uses are refused with the ads named; an unknown video is refused; an owner deletion rule refuses deletions but not renames.
3. Eleven malformed requests are refused before any request; an unknown image and an unchanged name are refused after reading, without writes.
4. An error reply and a partial deletion reply are never resubmitted; ignored edits are not verified; the ledger lists the five rows in the family.

Red/green against a build of `d397f7c`: all four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-library-assets-20260927/red-check.log`.

## Verification

- Targeted: 201 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,995/1,995.
- Guidance coverage: 336 write-path refusals across 198 modules accounted for.
- Full qualification: see
  [TIKTOK-LIBRARY-ASSETS-VERIFICATION-2026-09-27.json](TIKTOK-LIBRARY-ASSETS-VERIFICATION-2026-09-27.json).

Remaining rows: 721 (five TikTok rows reviewed; TikTok blocked writes 175 → 170). Live acceptance
is unverified; it needs the updated deployment and a TikTok advertiser with library assets.

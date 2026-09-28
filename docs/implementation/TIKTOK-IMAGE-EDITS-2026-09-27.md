# TikTok library image edits — 2026-09-27

Base revision: `0319a4c` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: TikTok placements take images of set sizes, and the library could not produce a resized copy
through AMCP: `POST /v1.3/creative/image/edit/` was a blocked write.

Contract source: TikTok API for Business v1.3 "Edit an image", read on 2026-09-28. The endpoint takes
`advertiser_id`, `image_id`, `width`, `height`, `edit_method` (`fix_size`: "fixed length and width
cropping, no trimming"; `only_gauss_pad`: "only Gaussian blur trimming, no cropping";
`gauss_padding_reserve_score`: Gaussian blur fitted to the main subject; `fix_size` by default) and
`image_name`. It "only supports cropping/trimming of an image that has been uploaded to the Asset
Library. The edited images will be automatically uploaded to the Asset Library and the new picture
ID will be returned", with the new image's width, height, format and file name. Library names have
1–100 characters and a taken name gets a millisecond timestamp ("Update the name of an image").

## Change

New reviewed family `tiktok_image_edits` (`src/tiktok-image-edits.ts`):

| Part | Behaviour |
|---|---|
| Request | `advertiser_id` of the selected advertiser, `image_id`, whole-pixel `width` and `height`, an optional documented `edit_method` and an optional `image_name` of 1–100 characters; nothing else |
| State | The source image, found by ID through "Search for images": name, width, height and format (not its expiring URL) |
| Checks | The image is in the advertiser's library (`STATE_NOT_FOUND`); an edit to the size the image already has is refused |
| Safety | A new library image changes no ad, so no spending confirmation (the family is exempt from the generic spend pattern) |
| Receipt | `code` 0 with the new `image_id`; anything else is a failure never resubmitted |
| Verification | The new image searched by ID: present, with the requested width and height and, when sent, the name (or the name with TikTok's millisecond timestamp) |

Allowing the timestamp on a taken name follows the library naming rule of the rename reference; the
edit reference does not repeat it. New refusal code: `INVALID_TIKTOK_IMAGE_EDIT`.

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/preflight.ts` (spend pattern exemption), `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (TikTok contract version 30). Guidance: an
image edit paragraph in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an
executable inspect example.

## Tests

`tests/tiktok-image-edits.test.mjs`, three tests:

1. A cropped copy with a name and a padded copy without one are created and verify; the source image is unchanged; a taken name verifies with TikTok's timestamp; a replay sends nothing.
2. Nine malformed edits (an unknown field, no width, a zero height, a fractional width, an unknown method, a padded name, a 101-character name, a path-like image ID, another advertiser) are refused before any request; an unknown image and an unchanged size are refused after reading.
3. An error reply is never resubmitted; a missing or differently sized new image is not verified; the ledger lists the row in the family.

Red/green against a build of `0319a4c`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-image-edits-20260927/red-check.log`.

## Verification

- Targeted: 211 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,061/2,061.
- Guidance coverage: 343 write-path refusals across 205 modules accounted for.
- Full qualification: see
  [TIKTOK-IMAGE-EDITS-VERIFICATION-2026-09-27.json](TIKTOK-IMAGE-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 705 (one TikTok row reviewed; TikTok blocked writes 169 → 168). Live acceptance is
unverified; it needs the updated deployment and a TikTok advertiser with a library image.

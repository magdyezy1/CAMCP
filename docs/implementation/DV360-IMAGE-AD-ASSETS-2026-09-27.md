---
status: record
tier: engineering
---

# DV360 Demand Gen image ad assets — 2026-09-27

Base revision: `a9f32c0` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Demand Gen image and carousel ads need image ad assets, and video ads can take a logo and a
companion banner. Ads (`a9f32c0`) and YouTube video assets (`e8e4a8a`) were qualified, but image
assets still had to be uploaded in Display & Video 360, so a Demand Gen campaign could not be
built through AMCP alone.

Contract source: the pinned Display & Video 360 API v4 Discovery document (`adAssets.upload`,
`UploadAdAssetRequest`, `UploadAdAssetResponse`, `AdAsset`; revision 20260902),
[Create ad assets](https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/create-ad-assets)
and the image requirements of
[Create a Demand Gen ad](https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/create-dg-ad),
read on 2026-09-27. Key facts:

- `adAssets.upload` is a multipart media upload at
  `/upload/v4/advertisers/{advertiserId}/adAssets:uploadAdAsset`. Its metadata is `filename` (up
  to 240 UTF-8 bytes), `adAssetType` (only `AD_ASSET_TYPE_IMAGE`) and an optional AI attestation;
  the response is the created `AdAsset`.
- `get` and `list` return only YouTube video assets, so an uploaded image cannot be read back.
- Demand Gen images are limited to 5120 KB (companion banners 150 KB, 300x60). Minimum sizes depend
  on the slot: landscape 600x314, square 300x300, portrait 480x600, logo 128x128.

## Change

The reviewed media upload (`amcp_media`, `src/media-upload.ts`) gains a DV360 ad asset target:

| Part | Behaviour |
|---|---|
| Request | `amcp_media` `prepare` with `platform: dv360`, `dv360_target: ad_asset` and optional `synthetic_content` (`NOT_SYNTHETIC`, `IS_SYNTHETIC`), or the native `DV360_ADVERTISERS_AD_ASSETS_UPLOAD` with a Drive link and optional `adAssetType: AD_ASSET_TYPE_IMAGE` and `syntheticContentAttestationStatus` |
| Checks | The target and label only for DV360; images only (videos become ad assets by video ID); PNG or JPEG up to 5120 KB; other native fields refused; execution uses the frozen review |
| Review | The Drive bytes are frozen and encrypted for five minutes, with the advertiser read as before-state |
| Upload | One multipart upload after confirmation, with the filename, image type and label |
| Receipt | `adAssetId` of an `AD_ASSET_TYPE_IMAGE` asset of the advertiser, with the requested label when DV360 returns one; the result gives `dv360_ad_asset_id` and `creative_reference: {assetId}` |
| Evidence | The receipt (`status_source: upload_receipt`); a receipt for another type, advertiser or label is `MEDIA_RESPONSE_INVALID`, keeps the allocated ID and is never uploaded again |

Without `dv360_target`, DV360 imports remain creative assets (10 MB). The transport allows its
multipart-related body only for the two DV360 upload paths. `platform_media_upload` validates
against its captured operation schema and keeps uploading creative assets only. Asset matching
for reuse compares the target, so a creative asset is never offered for an ad asset of the same
bytes.

Other code: `src/media-routing.ts` (the native route and its fields), `src/transport.ts` and
`src/provider-contracts.ts` (DV360 contract version 10). Guidance: "Demand Gen ad assets" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and
`Skills/amcp-campaign-builder/references/media.md`.

## Tests

`tests/dv360-image-ad-assets.test.mjs`, six tests:

1. An image ad asset is reviewed, uploaded once with its filename, type and AI label, returns its assetId and is listed; a replay makes no second upload.
2. The native route prepares the same reviewed upload; `platform_media_upload` refuses the ad asset target.
3. Nine malformed requests fail before any download or upload; a video is refused after download; the 5120 KB limit applies to ad assets but not creative assets.
4. Receipts naming a video asset, another advertiser or another label, or no ID, are failures that are not uploaded again.
5. Creative asset uploads keep their route and receipt.
6. The method, metadata, scopes and read limits match the pinned Discovery document, and the ledger lists the route as a media workflow.

Red/green against a build of `a9f32c0` (with the pinned document present): all six fail (unknown
media parameter, `WRITE_CONTRACT_UNAVAILABLE` for the native route, and the route still blocked in
the ledger); all pass with this change. Local log:
`.runtime/dv360-image-ad-assets-20260927/red-check.log`.

## Verification

- Targeted: 141 related suite files, including every DV360 and media suite, with FFmpeg
  configured: 1,673/1,673.
- Guidance coverage: 266 write-path refusals across 145 modules accounted for.
- Full qualification: see
  [DV360-IMAGE-AD-ASSETS-VERIFICATION-2026-09-27.json](DV360-IMAGE-AD-ASSETS-VERIFICATION-2026-09-27.json).

Remaining rows: 887 (one DV360 row moves to the media workflow; DV360 blocked writes 45 → 44).
Live acceptance is unverified; it needs the updated deployment, a Drive image and a DV360
advertiser with Demand Gen enabled.

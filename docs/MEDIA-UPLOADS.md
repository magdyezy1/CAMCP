# Media uploads

The Creative page now starts with a searchable metadata library, editable internal names/tags and verified retained
plan usage. `amcp_media` exposes `library`, `asset` and confirmed revision-protected `save_asset_metadata` actions.
`asset_performance` with `asset_id` lists compatible guided Meta, Google Ads, Snapchat or standard TikTok ad evidence from the same provider/account/login using bounded metadata
pagination. Add `plan_id` and `report_id` to inspect rows for exact verified ad IDs linked by that retained plan.
Google joins preserve complete customer/ad-group/ad resource names; equal numeric ad IDs in different ad groups stay distinct. Snapchat UUIDs and TikTok/Meta numeric IDs stay exact text. Only the qualified ad actions and native snapshot grains listed in the [delivery record](review/DELIVERY-2026-10-03-LINKED-AD-PERFORMANCE.md) are supported; Smart+ and other aliases remain separate.
Results preserve the source report definitions and unknown values; no new provider query occurs. This is linked-ad
performance, not image attribution or proof of the creative used throughout the historical reporting window.
External edits, dynamic creative combinations and unrecorded provider use remain unverified. Follow `next_cursor`
for choices and `next_offset` for matched rows; each page rechecks the asset and plan's current access.
Website uploads have an absolute thirty-minute deadline including derived copies. Fresh provider checks for receipt reuse remain in force. Owners may explicitly retain a separately imported link/Drive original as described below. See the
[connected workflow](PRODUCT-WORKFLOWS.md#creative-preparation-and-durable-uploads) for scope and pagination.

A file reaches AMCP in one of three ways: uploaded on the website (the **Media library** page), a public HTTPS link, or Google Drive (a public share link, or a private file or folder selected in a separate Drive connection; see [workspace operations](WORKSPACE-OPERATIONS.md)). **The AMCP server receives or downloads the file and transfers it; the MCP client/LLM never needs to download it or expose base64 bytes.** Normal native upload actions, `platform_media_upload` and `amcp_media` share the same reviewed uploader.

## Without Google Drive

**Upload on the website.** *Push creatives* on the Media library page takes PNG, JPEG, MP4 and MOV files, several at once; they are sent one after another. The browser sends each in 1 MiB parts, so each part arrives within the server's 45-second request limit even on a slow connection, and a part that fails is sent again on its own. Each part is encrypted into the same staging as reviews. On completion AMCP checks that every part arrived, that the file really is PNG, JPEG, MP4 or MOV (from its bytes, not its name), records its SHA-256, and reads its dimensions and a small preview frame with FFmpeg. The upload is then an **upload source**, `src-…`, kept until thirty minutes after upload starts; completion does not extend it. It belongs to the member who uploaded it; workspace administrators can use every upload of the workspace. Temporary and explicitly retained originals together may hold up to four times the media limit in bytes per workspace (25 files at most) and eight times in all (50 files), apart from the reviews each workspace may stage: a finished upload counts its size and one still arriving counts the whole limit, so four full-sized files still fill a workspace while many small images fit in the same space. Readers cannot upload, and neither can reviewer test accounts.

**A public link.** `amcp_media` accepts `source_url`, and the website accepts a link in place of a file. The link must be HTTPS on the standard port, name a host (not an IP address or a single-label local name) and carry no user name or password. Every address the host resolves to must be public: private, loopback, link-local (cloud metadata), carrier-grade NAT, multicast, documentation and other special-purpose ranges are refused. The connection goes to the address that was checked, so the name cannot be re-pointed between the check and the download. At most three redirects are followed, each checked the same way. No cookie, credential or advertising token is sent. The download is limited to the media limit and must be PNG, JPEG, MP4 or MOV by its bytes. AMCP records the host the file came from, never the full link, which may carry a token. Google Drive links go through `drive_url` instead.

**Retain a separately imported original.** Website computer uploads cannot be retained. Their original bytes, thumbnails, variants and review copies share upload start plus thirty minutes; new reviews cannot extend that deadline. Access is refused exactly at expiry, with an independent fifteen-second cleanup timer and startup cleanup deleting encrypted copies. Legacy retained computer uploads follow the same rule. For a separately imported link/Drive original only, a current workspace owner can choose **Retain this original**, inspect its exact SHA-256 and confirm an encrypted copy kept until removal. Its `lib-…` ID works with prepare/plan/variant/eligibility inputs under the unchanged original-file count/byte ceiling. Retention never uploads to a provider or changes existing plans. Provider-hosted assets and historical receipt metadata remain separate; new encrypted backups omit transient media and legacy retained computer uploads. See [batch 191](review/DELIVERY-2026-10-07-APPEARANCE-MEDIA-DETAIL.md) for precise cleanup/backup boundaries.

**From MCP.** `amcp_media list` returns accessible temporary and retained originals under `sources`. For a separately imported link/Drive original, use `retain_source` with `source_id`, `confirmed:true` and the selected `expected_sha256`; retry returns the same verified library copy. `remove_source` requires those same owner-confirmed fields for permanent removal of a library original. `prepare`, `plan`, `variant` and `inspect_eligibility` take exactly one file: `source_id`, `source_url`, `drive_url` or `variant_id`. Native upload actions and `platform_media_upload` take a public HTTPS link in `url` just as they take a Drive link; an upload is used through `amcp_media` with its `source_id`.

## Fit to each platform

With `fit_to_platform: true`, `prepare` fits the file before freezing it for review, as the owner decided on 2026-09-28:

- Media larger than **1080 pixels on its short side or 1920 on its long side** is scaled down to fit, keeping its shape: 4500 × 4500 becomes 1080 × 1080, 4500 × 8000 becomes 1080 × 1920, 3840 × 2160 video becomes 1920 × 1080. Nothing is cropped, padded or enlarged. This is AMCP's delivery size, not a limit any platform states.
- An image still above the platform's image limit (table below) is re-encoded: a PNG stays PNG when it fits, otherwise becomes JPEG unless it has transparency (then AMCP refuses and says so); a JPEG is saved at FFmpeg quality 2, then 5, then 9, until it fits.
- A MOV video for X or LinkedIn, which take only MP4, becomes MP4. Streams that are already H.264 and AAC are copied without re-encoding.
- A JPEG's EXIF orientation is applied to the pixels, since the output carries no metadata. FFmpeg 5.1 (the production image) and later versions treat EXIF orientation differently, so AMCP reads it itself and applies it once.

Media that already fits is uploaded byte for byte. Otherwise `request.transform` in the review states `from` and `to` (dimensions, bytes, type), each step, and those steps in words for the platform. Fitting is bounded like variants: one image or video stream, at most 40 megapixels and 180 seconds, two conversions at once. Without `fit_to_platform`, a refusal that fitting would solve (an image over the limit, MOV for X or LinkedIn) says so.

## Push to several accounts

`amcp_media plan` takes an upload's `source_id`, `fit_to_platform` and up to 20 `destinations` (`platform`, `account_id`, optional `connection_id`, `owner_urn`, `dv360_target`). Without staging anything or calling a platform, it returns for each destination whether access allows it and the exact file it would receive: SHA-256, size, type, dimensions and every change. Platforms with the same limits share one conversion. Each ready destination is then prepared with `expected_sha256` set to its planned SHA-256 (`prepare` refuses with `MEDIA_CHANGED` if the file differs) and executed as its own review.

The website's *Push creatives* follows exactly this for several files: bring them in (uploaded, from a link, or from Google Drive), choose accounts (every account of a platform with one box, on as many platforms as needed), see what each account receives of each file and why, confirm once, then AMCP prepares and pushes one upload at a time and shows each result. Accounts are named by their own name and ID, as the last sync of their login read them. One push reviews at most 200 uploads (files times accounts). One staged review at a time keeps a push within the workspace's two-review staging limit.

## Normal native flow

Call `amcp_write`:

```json
{
  "action": "prepare",
  "gateway": "meta_native_action",
  "connection_id": "YOUR_CONNECTION_ID",
  "arguments": {
    "action": "meta_image_upload",
    "account_id": "YOUR_ACCOUNT_ID",
    "payload": {
      "url": "https://drive.google.com/file/d/YOUR_DRIVE_FILE_ID/view",
      "name": "September image"
    }
  }
}
```

Preparation downloads on the server, checks format/size, encrypts the exact bytes, reads account configuration and returns a five-minute review with SHA-256 and `next_call`. Review the file details before following that call:

```json
{
  "action": "execute",
  "review_id": "COPY_FROM_PREPARE",
  "idempotency_key": "COPY_FROM_PREPARE",
  "confirmed": true
}
```

Use `amcp_write` or `amcp_media` to execute. Meta images return `image_hash` / `meta_image_hash`; use that value in `object_story_spec.link_data.image_hash` in `meta_creative_create`. Use the returned creative ID in `meta_ad_create`. Both are reviewed contracts; new ads still require `status: "PAUSED"`. A Page ID with advertising permission and a destination URL are required for website link creatives. AMCP does not invent them.

Native upload calls with `dry_run:false` prepare a review and return the execution `next_call`; they never upload immediately. With `dry_run:true` or omitted, a native URL call returns a preview without downloading or calling a provider. Native source aliases in `payload` are `url`, `drive_url`, `image_url`, `video_url`, `file_url` and `source`. Conflicting aliases and unconsumed fields are rejected. Existing account-bound Snapchat `media_id` uploads reuse that allocation.

## Shared workflow

Call `amcp_native_action`:

```json
{
  "operation": "platform_media_upload",
  "arguments": {
    "action": "UPLOAD_FROM_URL",
    "platform": "snapchat",
    "account_id": "YOUR_ACCOUNT_ID",
    "url": "https://drive.google.com/file/d/YOUR_DRIVE_FILE_ID/view",
    "media_type": "image",
    "dry_run": false
  }
}
```

This returns the same review and execution `next_call`. `UPLOAD_FROM_URL_VIA_SESSION` and `QUEUE_GOOGLE_DRIVE_IMPORT` use this flow too. The latter accepts `google_drive_file_id` and optional `google_drive_resource_key`. Optional `inspect_google_drive_media` with `link` returns file metadata without file bytes. Inspection is not required before upload.

`FINALIZE_UPLOAD_SESSION` accepts the returned `upload_session_id`, matching `idempotency_key`, `confirmed:true` and `dry_run:false`; it executes the frozen review. Client-local file, browser-signed upload and external job-queue workflows are not implemented here.

Prepare one selected account per review. Names: `meta`, `tiktok`, `snapchat`, `google_ads`, `linkedin`, `x_ads`, `dv360`; shared workflows also accept `google`, `x`, `twitter`. A single `target_platforms` entry is accepted. Repeat the same link for other targets, without a client download. Use outer `amcp_write.connection_id` to select a login.

`amcp_media prepare` takes `platform`, `account_id`, one file (`source_id`, `source_url`, `drive_url` or `variant_id`), optional `connection_id`, `name` and `fit_to_platform`. Completed uploads appear in `amcp_media list` and `list_media_assets` with their platform identifiers, connection ID and `source`: `amcp_upload` (uploaded on the website), `link_import` (a public link) or `server_drive_import` (Google Drive, directly or through a variant).

## Files and processing

| Platform | Import limits | Identifiers and processing |
| --- | --- | --- |
| Meta | PNG/JPEG ≤30 MiB; MP4/MOV within the configured limit (default 128 MiB) | `image_hash` / `video_id`; videos may process |
| TikTok | PNG/JPEG ≤5 MiB; MP4/MOV within the configured limit (default 128 MiB) | `image_id` / `video_id`, native upload receipt |
| Snapchat | PNG/JPEG ≤5 MiB; MP4/MOV within the configured limit (default 128 MiB) | `media_id`; creative uses `top_snap_media_id`; native processing status |
| Google Ads | PNG/JPEG ≤5 MiB; MP4/MOV within the configured limit (default 128 MiB) | Image asset resource name; videos create UNLISTED uploads on the account's Google-managed YouTube channel |
| LinkedIn | PNG/JPEG ≤20 MiB; MP4 within the configured limit (default 128 MiB) | `linkedin_media_urn`, `image` / `video`; video needs an explicitly bound organization/person owner, not a sponsoredAccount URN; processing may continue |
| X | PNG/JPEG ≤5 MiB; MP4 within the configured limit (default 128 MiB) | `media_id`, `x_media_key`, library ID when attached |
| DV360 | PNG/JPEG ≤10 MiB; MP4/MOV within the configured limit (default 128 MiB) | `dv360_media_id` and native `asset`; availability handoff remains unqualified and is not marked ready |

Providers additionally enforce dimensions, duration, codecs, permissions and app approvals. Without `fit_to_platform`, AMCP uploads the exact bytes; with it, the review states every change. Upload success does not establish ad approval. Binary upload APIs for other catalog providers are not implemented; measurement services and Apple Ads do not use this advertising-media flow.

Call `amcp_media {"action":"status","review_id":"..."}` for processing reads and follow its continuation:

- X: once processing succeeds, `prepare_library` reviews attaching the already uploaded video to the account library. Execute the new review; no re-download/re-upload occurs. This does not post a tweet.
- Google Ads: after PROCESSED, status returns `youtube_video_id` and an exact `amcp_write prepare` call for a YouTube video asset. This separate asset mutation is reviewed. Unlisted upload visibility is stated in the upload review.
- LinkedIn: default owner is the selected sponsored account. Organization/person owners require `owner_urn` and an exact administrator resource binding for `/rest/organizations/{id}` or `/rest/people/{id}`, plus provider permissions. AMCP does not replace the requested owner. Image PUT uses OAuth; video PUT uses the signed URL without OAuth.

## Permissions and failures

Deployment writes must be enabled; the connector must be operator/admin and the selected connection must grant account writes. This single grant covers campaigns, ad sets, ads, creatives and media equally. `WRITE_ACCOUNT_FORBIDDEN` identifies the chosen connection/account and whether another login has a write grant. Choose that connection explicitly or update the grant in Connections. New connections default to reviewed writes when enabled; existing reader grants are preserved.

Public Drive imports require a downloadable share link. Private files use drive_connection_id and an explicit file selection through Drive OAuth. A Drive login may also select folders: the website lists the downloadable PNG, JPEG, MP4 and MOV files directly inside a selected folder (Drive `files.list` with `'<folder>' in parents`, at most 500), and imports one only after Drive's own metadata names that folder among the file's parents. Subfolders are not opened (select them to use their files). Google Docs exports and permission/quota/confirmation HTML remain unsupported. Advertising credentials/cookies are never sent to Drive; redirects are restricted to approved download hosts. Any other link goes through `source_url` and its public-address rules (see *Without Google Drive*).

Frozen bytes prevent later Drive edits from changing the reviewed upload. Temporary staging permits two pending reviews or variants per tenant and eight application-wide, each within the configured limit (default 128 MiB); uploads waiting to be pushed have their own space: four times the media limit in bytes per tenant (25 files) and eight times application-wide (50 files). Expired files are removed on the next capacity reservation; submitted uploads delete bytes immediately on success/failure. `amcp_media cancel` discards an unsubmitted review. Receipts and audits remain.

Uploads are never automatically retried. Known allocation IDs and `retry_safe:false` survive partial failure. Lost responses leave durable uncertain claims; inspect provider state before deciding to retry. Resumable Google session state is retained encrypted and restricted to its HTTPS resumable-upload origin. LinkedIn URLs are restricted to its HTTPS upload host/path. Multi-step uploads cannot roll back atomically across providers.

## Sources and verification

Contracts: [Meta creative fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreative.py), [Snapchat media](https://developers.snap.com/marketing-api/Ads-API/media) and [creatives](https://developers.snap.com/marketing-api/Ads-API/creatives), [TikTok SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/FileApi.md), [Google images](https://developers.google.com/google-ads/api/samples/upload-image-asset) and [video uploads](https://developers.google.com/google-ads/api/docs/assets/upload-videos), [LinkedIn images](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api) and [videos](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api), [X media](https://docs.x.com/x-ads-api/creatives), [DV360 uploads](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.assets/upload).

Synthetic tests cover native/shared entry points, server transfer, encryption, review/grant controls, byte preservation, processing continuations, scope registration and Meta image → creative → paused-ad chaining. They do not prove live provider acceptance. No live advertising-account media or ads were created during development.

Upload execution commits its durable receipt before checking provider availability. Pending or failed availability checks return the completed upload with `ready:false` and recovery details; they do not reopen its mutation claim. An explicit status request on terminal processing failure returns `MEDIA_PROCESSING_FAILED`, retains the ID and records failure in workspace assets. Later status/reuse verifies the exact media and account/owner. Ready responses stop polling; Google returns the reviewed AssetService continuation and X the library-attachment continuation where needed. LinkedIn signed download URLs are omitted. These are synthetic-tested behaviors, not new live uploads. Never repeat an upload automatically or prepare an ad from failed/unverified media. [LinkedIn status](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api), [Snap status](https://developers.snap.com/marketing-api/Ads-API/media).

## Durable transfer and eligibility

AMCP_MAX_MEDIA_MB controls the staging bound (32–512 MiB, default 128); a value outside that range is rejected, the 128 MiB default applies, and the reason is written to stderr and reported by `amcp_workspace health` under `configuration_problems` rather than stopping the server; lower provider image/format limits still apply. Files are encrypted in 4 MiB SQLite chunks with a checked manifest. Transfers use bounded memory buffers. Google video uploads use resumable chunks and authoritative offset queries; unknown finalization is never blindly repeated.

Use amcp_media inspect_eligibility with a file (`source_id`, `source_url` or `drive_url`) and square/portrait/vertical/landscape preset to inspect geometry and codec before upload. FFmpeg/ffprobe are required. These are AMCP preset checks, not a certificate of platform acceptance. A preset on prepare requires the frozen source to pass these checks.

execute_async queues the confirmed frozen review; job_status exposes durable progress. Reviews still expire if execution does not begin in time. Cancellation prevents unsubmitted work; a provider request already sent can finish. Reuse performs a fresh account-scoped availability check; unsupported lookup paths require a fresh reviewed upload. No LLM file download is necessary.

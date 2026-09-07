# Media from Google Drive

Give AMCP a public Google Drive file link. **The AMCP server downloads and transfers the file; the MCP client/LLM never needs to download it or expose base64 bytes.** Normal native upload actions, `platform_media_upload` and `amcp_media` share the same reviewed uploader.

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

Call `whathead_native_action`:

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

`amcp_media prepare` remains available with `platform`, `account_id`, `drive_url`, optional `connection_id` and `name`. Completed uploads appear in `list_media_assets` with `source:"uploaded"`, their platform identifiers and connection ID.

## Files and processing

| Platform | Import limits | Identifiers and processing |
| --- | --- | --- |
| Meta | PNG/JPEG ≤30 MiB; MP4/MOV ≤32 MiB | `image_hash` / `video_id`; videos may process |
| TikTok | PNG/JPEG ≤5 MiB; MP4/MOV ≤32 MiB | `image_id` / `video_id`, native upload receipt |
| Snapchat | PNG/JPEG ≤5 MiB; MP4/MOV ≤32 MiB | `media_id`; creative uses `top_snap_media_id`; native processing status |
| Google Ads | PNG/JPEG ≤5 MiB; MP4/MOV ≤32 MiB | Image asset resource name; videos create UNLISTED uploads on the account's Google-managed YouTube channel |
| LinkedIn | PNG/JPEG ≤20 MiB; MP4 ≤32 MiB | `linkedin_media_urn`, `image` / `video`; account media library, processing may continue |
| X | PNG/JPEG ≤5 MiB; MP4 ≤32 MiB | `media_id`, `x_media_key`, library ID when attached |
| DV360 | PNG/JPEG ≤10 MiB; MP4/MOV ≤32 MiB | `dv360_media_id` and native `asset` for creative creation |

Providers additionally enforce dimensions, duration, codecs, permissions and app approvals. AMCP preserves bytes without resizing/transcoding. Upload success does not establish ad approval. Binary upload APIs for other catalog providers are not implemented; measurement services and Apple Ads do not use this advertising-media flow.

Call `amcp_media {"action":"status","review_id":"..."}` for processing reads and follow its continuation:

- X: once processing succeeds, `prepare_library` reviews attaching the already uploaded video to the account library. Execute the new review; no re-download/re-upload occurs. This does not post a tweet.
- Google Ads: after PROCESSED, status returns `youtube_video_id` and an exact `amcp_write prepare` call for a YouTube video asset. This separate asset mutation is reviewed. Unlisted upload visibility is stated in the upload review.
- LinkedIn: default owner is the selected sponsored account. Organization/person owners require `owner_urn` and an exact administrator resource binding for `/rest/organizations/{id}` or `/rest/people/{id}`, plus provider permissions. AMCP does not replace the requested owner. Image PUT uses OAuth; video PUT uses the signed URL without OAuth.

## Permissions and failures

Deployment writes must be enabled; the connector must be operator/admin and the selected connection must grant account writes. This single grant covers campaigns, ad sets, ads, creatives and media equally. `WRITE_ACCOUNT_FORBIDDEN` identifies the chosen connection/account and whether another login has a write grant. Choose that connection explicitly or update the grant in Connections. New connections default to reviewed writes when enabled; existing reader grants are preserved.

Drive files must be downloadable by anyone with the link. Private files, folders, Google Docs exports and permission/quota/confirmation HTML return an actionable error. Advertising credentials/cookies are never sent to Drive; redirects are restricted to approved download hosts. Arbitrary source URLs are rejected.

Frozen bytes prevent later Drive edits from changing the reviewed upload. Temporary staging permits two pending files per tenant and eight application-wide, each ≤32 MiB. Expired files are removed on the next capacity reservation; submitted uploads delete bytes immediately on success/failure. `amcp_media cancel` discards an unsubmitted review. Receipts and audits remain.

Uploads are never automatically retried. Known allocation IDs and `retry_safe:false` survive partial failure. Lost responses leave durable uncertain claims; inspect provider state before deciding to retry. Google session URLs remain in memory and are restricted to its HTTPS resumable-upload origin. LinkedIn URLs are restricted to its HTTPS upload host/path. Multi-step uploads cannot roll back atomically across providers.

## Sources and verification

Contracts: [Meta creative fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreative.py), [Snapchat media](https://developers.snap.com/marketing-api/Ads-API/media) and [creatives](https://developers.snap.com/marketing-api/Ads-API/creatives), [TikTok SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/FileApi.md), [Google images](https://developers.google.com/google-ads/api/samples/upload-image-asset) and [video uploads](https://developers.google.com/google-ads/api/docs/assets/upload-videos), [LinkedIn images](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api) and [videos](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api), [X media](https://docs.x.com/x-ads-api/creatives), [DV360 uploads](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.assets/upload).

Synthetic tests cover native/shared entry points, server transfer, encryption, review/grant controls, byte preservation, processing continuations, scope registration and Meta image → creative → paused-ad chaining. They do not prove live provider acceptance. No live advertising-account media or ads were created during development.

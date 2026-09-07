# Media from Google Drive

Use `amcp_media` with a selected account and an operator connector. The provider login must have the relevant upload permissions. The file must be downloadable by anyone with its Google Drive link; private files, folders and Google Docs exports are not supported. AMCP never forwards advertising credentials to Drive.

## Prepare and execute

```json
{
  "action": "prepare",
  "platform": "snapchat",
  "account_id": "YOUR_ACCOUNT_ID",
  "drive_url": "https://drive.google.com/file/d/YOUR_DRIVE_FILE_ID/view",
  "name": "September creative"
}
```

The platform names are `meta`, `tiktok`, `snapchat`, `google_ads`, `linkedin` and `x_ads`. Set `connection_id` when selecting a particular login. Preparation downloads the file, checks its format and size, encrypts it in temporary storage, reads account configuration, and returns its SHA-256, file details and five-minute review. Inspect those details before execution:

```json
{
  "action": "execute",
  "review_id": "COPY_FROM_PREPARE",
  "idempotency_key": "COPY_FROM_PREPARE",
  "confirmed": true
}
```

Execution uploads the exact prepared bytes. A later Drive file change cannot replace them. It does not create or publish an ad, campaign or post. Use the returned platform identifier in your creative payload. Successful repeated execute calls return the stored receipt without uploading again.

`{"action":"cancel","review_id":"..."}` discards an unsubmitted review. Staging is bounded to two pending files per tenant and eight across the application, each at most 32 MiB. Files expire after five minutes; expired encrypted records are removed when the next preparation reserves capacity. Completed and failed uploads delete their staged bytes immediately. Reviews and redacted audit receipts remain in the database.

## Formats and identifiers

| Platform | Files | Returned identifier | Processing |
| --- | --- | --- | --- |
| Meta | PNG/JPEG up to 30 MiB; MP4/MOV up to 32 MiB | Image hash or video ID | Videos may still process |
| TikTok | PNG/JPEG up to 5 MiB; MP4/MOV up to 32 MiB | `image_id` or `video_id` | Native upload response retained as an upload receipt |
| Snapchat | PNG/JPEG up to 5 MiB; MP4/MOV up to 32 MiB | Media ID, registered to the selected AMCP account scope | Reports the native `media_status` |
| Google Ads | PNG/JPEG up to 5 MiB | `customers/.../assets/...` | Image asset created |
| LinkedIn | PNG/JPEG up to 20 MiB; MP4 up to 32 MiB | Image/video URN | Uploaded to the selected sponsored account library; may still process |
| X | PNG/JPEG up to 5 MiB; MP4 up to 32 MiB | Media ID/key and, when attached, library ID | Video processing can require a separate library review |

These are importer limits. Providers also enforce dimensions, duration, encoding, account permissions and creative-specific requirements. A successful upload does not establish ad approval. Google Ads videos use YouTube video IDs; this importer does not upload videos to YouTube. Drive permission, quota or download-confirmation HTML pages return an explicit error instead of being treated as media.

For processing updates, call `{"action":"status","review_id":"..."}`. It performs reads only. If an X video is still processing after upload, wait for its processing state to succeed, then call `{"action":"prepare_library","review_id":"ORIGINAL_UPLOAD_REVIEW_ID"}`. This produces a new account-state review for attaching the already-uploaded media to the selected account library. Execute that new review normally. It reuses the original upload ID and does not download or upload the file again.

## Failure handling

No upload step is automatically retried. If a provider allocates media and a later step fails, the error and audit contain `media_id` and `retry_safe:false`. A lost response leaves a durable uncertain submission claim. Inspect the allocated media in the provider before deciding how to recover; do not automatically create a replacement review. Multi-step uploads cannot be rolled back across providers.

Account and connector revocation are checked before egress, including after credential refresh. Provider responses cannot choose arbitrary binary destinations: LinkedIn signed upload URLs are restricted to its HTTPS upload host/path, while other uploads use fixed vendor origins. The review gate on normal native tools remains unchanged.

## Contract sources and verification

The adapters follow the [Snapchat media contract](https://developers.snap.com/marketing-api/Ads-API/media), [TikTok upload SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/FileApi.md), [Google image asset contract](https://developers.google.com/google-ads/api/samples/upload-image-asset), [LinkedIn images](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api) and [videos](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api), and [X media library flow](https://docs.x.com/x-ads-api/creatives). Meta uses the captured v25 adimages/advideos routes and native base64/multipart bodies.

Automated tests exercise native request/response contracts, frozen bytes, encryption, state changes, expired reviews, tenant/actor/account boundaries, unsafe URLs, streaming limits, partial failures, asynchronous X processing and duplicate submissions with synthetic responses. These checks do not establish live provider acceptance; no advertising-account media was uploaded during development.

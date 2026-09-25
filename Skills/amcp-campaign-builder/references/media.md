# Server media import

The LLM does not download media. Pass a Google Drive file link to `amcp_media` with `action: prepare`, platform, account ID and the documented media fields. Use `DESCRIBE_ACTION` or `amcp_tool_help` for the exact native alias. Native media actions and `platform_media_upload` route into the same reviewed media flow.

For private files, connect Google Drive separately, select the file and supply drive_connection_id. Public files must expose the actual bytes without a login; a folder, document editor page, HTML warning, or unsupported file is not an image/video. AMCP resolves the link, restricts redirect hosts, applies byte/type limits and stages the exact encrypted bytes for the review. Clients receive identifiers and metadata, not the whole binary.

Execute the returned review through `amcp_write` or `amcp_media` using its original idempotency key and confirmation. Inspect returned `next_call`, `processing`, or continuation fields. Use the provider's native result: Meta image hash/video ID, TikTok image/video ID, Snapchat media ID, Google asset resource name, LinkedIn URN, X media ID or DV360 asset metadata. Reuse the ID in the creative; do not import the same file again merely to attach it.

Current import adapters cover Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360. The default maximum staged file size is 128 MiB; deployments may set AMCP_MAX_MEDIA_MB from 32 to 512. Lower platform image limits, memory admission, supported types and provider constraints still apply. Read runtime limits before choosing a large file. Microsoft Advertising and Reddit media imports are not covered. Large/resumable formats outside a qualified adapter need an explicit capability extension, not a client-side download workaround.

For explicit format variants and receipt reuse, see [workspace operations](workspace.md).

Upload completion and account-library readiness are distinct. After execute, AMCP durably retains the successful upload and attempts one exact availability read. Follow `handoff_status`, `status_source`, `ready` and `next_call`. An unreadable or processing asset remains unusable even if upload returned an ID; `handoff_status: inconclusive` does not permit another upload. An unsupported availability read (currently DV360) remains unverified. For X, registration omits media_category but upload INIT/image requests retain their category; preserve the entire media_key. The exact account-library read must return TRANSCODE_COMPLETED. A fresh successful read may make execute return ready immediately. Availability under another login is not implied by a receipt.

LinkedIn video uploads require `owner_urn` identifying a person or organization; sponsoredAccount is not an accepted video owner. `LINKEDIN_VIDEO_OWNER_REQUIRED` names the missing prerequisite. Supply the exact administrator owner binding and use the same organization as the DSC author for AMCP's qualified post workflow. Exact status reads require the returned owner; absent ownership is not evidence. Signed download URLs and unrelated media metadata are omitted from status results.

LinkedIn checks the current login, organization binding, account grant and selected
private Drive file before every part and finalization. A withdrawal or expired
upload URL stops subsequent requests. The server retains ordered part receipts
and signed instructions encrypted; the client receives allocation and byte
progress only. Inspect the original review after an interruption. A retained
LinkedIn part receipt does not enable automatic resume or authorize a new upload.
Use the explicit recovery contract below to continue a fully acknowledged prefix.
An accepted finalization keeps its completed receipt even if access changes during
the response; obtain current authorized read-back before using the media.

Remote URL transfer cannot be universal: several advertising APIs require byte upload, initialization, chunk transfer or finalization. AMCP performs those steps server-side. Sending a mutable sharing URL straight to the provider would also let content change after review; the frozen reviewed bytes preserve the user's approval target.

Processing status verifies the exact uploaded media identity and owner/account when applicable. Ready Meta/LinkedIn/Snapchat responses stop suggesting polls. Google returns the reviewed AssetService continuation; X returns the reviewed library-attachment continuation. An explicit status call returns MEDIA_PROCESSING_FAILED for terminal rejection. The automatic post-upload check instead returns the completed receipt with processing_failed and a verification error, preserving the original successful mutation. Both record failure in workspace assets with retry_safe:false. Do not repeat the upload or prepare an ad from a failed asset. These behaviors have synthetic fixture evidence, not new live uploads. [LinkedIn media status](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api), [Snap media](https://developers.snap.com/marketing-api/Ads-API/media).

### Recovery, admission and work journals (contract revision 2026-09-25)

`amcp_media` with `action: list` also returns paginated `recovery_reviews` for the current actor and currently authorized account/login. The website Media library shows these unfinished uploads. Inspect the original frozen file hash, identity, expiry and journal before confirming execution or continuation. Source URLs and private upload capabilities are excluded from this recovery projection. A completed upload appears in the receipt library; an uncertain expired upload remains a diagnostic record without a retry button.

Use `amcp_media` with `action: recovery` and the existing `review_id` to inspect allocated IDs, confirmed bytes/parts, journal phase and `resume_available`. This is a read. Never expose a signed upload session or source token in a prompt. If and only if `resume_available` is true, the user may confirm `action: resume` with the same review ID and idempotency key. Both qualified paths remain within the original five-minute review, require unchanged encrypted bytes/current grants and refuse any prior finalization attempt:

- Google video queries the authoritative upload offset before transferring more bytes.
- LinkedIn video retains a versioned encrypted session, original login/owner/account,
  signed-URL expiry and ordered ETags. It reads the exact media and requires
  `WAITING_UPLOAD`, then sends only parts with no prior submission. If all parts
  have receipts, it finalizes once without uploading them again. A pending PUT,
  missing ETag, replaced login, expired URL or legacy receipt without an intent
  marker cannot resume. Missing metadata is not evidence of a safe retry.

`RECOVERY_NOT_SAFE` names a safe diagnostic reason; reconcile the retained resource.
A lost finalization is uncertain and cannot be retried as a new upload. A completed
receipt replays without egress. Other platforms retain their own status limitations.
This is an AMCP recovery protocol built on the [LinkedIn Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-05);
it does not assert that LinkedIn makes repeated PUTs or finalization idempotent.

`MEDIA_MEMORY_BUSY` means the shared byte reservation is occupied. Wait for the reported retry interval, then inspect recovery for any submitted review. Do not make a new mutation key. Media reservations and execution locks renew every 15 seconds with a 45-second lease, so a dead process releases capacity within the original review when enough review time remains. Each transfer boundary checks ownership; lost leases and backward clock movement stop further work after retaining any accepted receipt. `MEDIA_ADMISSION_LOST` and `MEDIA_UPLOAD_LEASE_LOST` require receipt/journal inspection. Downloading to encrypted chunks and retaining one bounded upload buffer still uses memory; the current default admits one maximum-size operation across workers. `PROVIDER_COORDINATION_BUSY` means bounded request coordination is full; wait for inactive entries to expire. It does not justify concurrency bursts, switching account identities or bypassing controls.

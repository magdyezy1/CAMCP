# Server media import

The LLM does not download media. Pass a Google Drive file link to `amcp_media` with `action: prepare`, platform, account ID and the documented media fields. Use `DESCRIBE_ACTION` or `whathead_tool_help` for the exact native alias. Native media actions and `platform_media_upload` route into the same reviewed media flow.

For private files, connect Google Drive separately, select the file and supply drive_connection_id. Public files must expose the actual bytes without a login; a folder, document editor page, HTML warning, or unsupported file is not an image/video. AMCP resolves the link, restricts redirect hosts, applies byte/type limits and stages the exact encrypted bytes for the review. Clients receive identifiers and metadata, not the whole binary.

Execute the returned review through `amcp_write` or `amcp_media` using its original idempotency key and confirmation. Inspect returned `next_call`, `processing`, or continuation fields. Use the provider's native result: Meta image hash/video ID, TikTok image/video ID, Snapchat media ID, Google asset resource name, LinkedIn URN, X media ID or DV360 asset metadata. Reuse the ID in the creative; do not import the same file again merely to attach it.

Current import adapters cover Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360. Maximum staged file size is 32 MiB; supported types and provider limits still apply. Microsoft Advertising and Reddit media imports are not covered. Large/resumable formats outside a qualified adapter need an explicit capability extension, not a client-side download workaround.

For explicit format variants and receipt reuse, see [workspace operations](workspace.md).

Remote URL transfer cannot be universal: several advertising APIs require byte upload, initialization, chunk transfer or finalization. AMCP performs those steps server-side. Sending a mutable sharing URL straight to the provider would also let content change after review; the frozen reviewed bytes preserve the user's approval target.

Processing status now verifies the exact uploaded media identity (and returned account/owner when applicable). Ready Meta/LinkedIn/Snapchat responses stop suggesting status polls. Google returns the reviewed AssetService continuation; X returns the reviewed library-attachment continuation. A terminal provider processing failure returns MEDIA_PROCESSING_FAILED with the retained media ID and retry_safe:false, and records the failure in workspace assets. Do not repeat the upload automatically or prepare an ad from a failed asset. These behaviors are covered by synthetic provider responses, not new live uploads. [LinkedIn media status](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api), [Snap media](https://developers.snap.com/marketing-api/Ads-API/media).

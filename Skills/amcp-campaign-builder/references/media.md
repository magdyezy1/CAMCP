# Server media import

The LLM does not download media. Pass a public Google Drive file link or public HTTPS media URL to `amcp_media` with `action: prepare`, platform, account ID and the documented media fields. Use `DESCRIBE_ACTION` or `whathead_tool_help` for the exact native alias. Native media actions and `platform_media_upload` route into the same reviewed media flow.

Drive must expose the actual file without a login; a folder, document editor page, HTML warning, or unsupported file is not an image/video. AMCP resolves the link, checks redirects/DNS, applies byte/type limits and stages the exact encrypted bytes for the review. Clients receive identifiers and metadata, not the whole binary.

Execute the returned review through `amcp_write` or `amcp_media` using its original idempotency key and confirmation. Inspect returned `next_call`, `processing`, or continuation fields. Use the provider's native result: Meta image hash/video ID, TikTok image/video ID, Snapchat media ID, Google asset resource name, LinkedIn URN, X media ID or DV360 asset metadata. Reuse the ID in the creative; do not import the same file again merely to attach it.

Current import adapters cover Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360. Maximum staged file size is 32 MiB; supported types and provider limits still apply. Microsoft Advertising and Reddit media imports are not covered. Large/resumable formats outside a qualified adapter need an explicit capability extension, not a client-side download workaround.

Remote URL transfer cannot be universal: several advertising APIs require byte upload, initialization, chunk transfer or finalization. AMCP performs those steps server-side. Sending a mutable sharing URL straight to the provider would also let content change after review; the frozen reviewed bytes preserve the user's approval target.

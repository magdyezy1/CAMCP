# TikTok and Snapchat

TikTok: campaign → ad group → ad. Use `tiktok_native_action`; advertiser IDs remain strings. New serving entities require `operation_status: DISABLE`. Discover authorized identities, Spark/non-Spark eligibility, placement constraints and objective-specific conversion settings. TikTok's Business API app/token flow differs from its consumer OAuth APIs; do not invent a refresh endpoint from another TikTok product.

Snapchat: campaign → ad squad → ad; uploaded media feeds a creative, then the ad references that creative. Use `snapchat_native_action`, with `ad_account_id` or `account_id`. Native collections wrap objects, for example `campaigns: [...]` or `creatives: [...]`. New campaigns/ad squads/ads require `PAUSED`; creative objects themselves do not require a fabricated status field.

For `POST /v1/campaigns/{id}/adsquads`, the review reads that exact campaign at preparation and execution. Delivery-status array ordering is not a concurrent configuration edit. AMCP ignores delivery telemetry and normalizes scalar array order while preserving budget, targeting and schedule differences. A newly created campaign can immediately be used as the child write's parent.

Snapchat creative updates use the discovered `snapchat_creative_update` action and native JSON Patch under the account. AMCP reviews the exact creative GET before executing the patch. Do not convert JSON Patch into a PUT collection payload.

Use [the media guide](media.md) for Drive imports. Poll asynchronous video processing before using the resulting asset in a creative. Read account currency and native amount semantics before converting budgets; never treat every platform's integer budget as Meta cents.

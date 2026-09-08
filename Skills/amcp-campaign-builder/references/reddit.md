# Reddit

Use `reddit_native_action` and discover its current delegated operation schema. The historical named `reddit_*_ops` tools are crosswalk entries, not automatically exposed MCP tools.

Hierarchy: account → campaign → ad group → ad. Use real profile, post, community, interest and location IDs. The supplied manual explicitly lacked verified vendor enum documentation; do not promote its guesses into validator constants. A local preview cannot prove that a guessed objective string is accepted by Reddit.

Reviewed ads use an existing authorized post_id; creating/publishing a post or a structured-post job is a separate, currently unqualified AMCP workflow. Do not invent a post ID. Deactivation uses the documented configured_status on an existing entity.

AMCP qualifies classic campaign/ad-group/ad creates and PATCH updates through amcp_write. New serving entities require configured_status: PAUSED; the connection needs adsread and adsedit. Ad-group creation requires conversion_pixel_id; CBO campaigns also require it. Ads require existing ad_group_id and post_id. CREATE_SAVED_AUDIENCE and UPDATE_SAVED_AUDIENCE are independent actions under reddit_account_ops for REDDIT_AUDIENCE targeting. Returned created IDs are immediately usable as parents. Updates cannot move a resource to another parent. Request configured_status: DELETED for reviewed deactivation, or status: DELETED for a saved audience. Reddit Drive/media import, Reddit Max, post publishing and customer-list ingestion remain unqualified. Return an actionable capability gap rather than trying an unrelated native route to escape review. Do not claim cross-platform campaign transfer is complete until each platform's structure, identity, currency and media constraints have been independently resolved.

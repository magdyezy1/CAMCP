# Reddit

Use `reddit_native_action` and discover its current delegated operation schema. The historical named `reddit_*_ops` tools are crosswalk entries, not automatically exposed MCP tools.

Hierarchy: account → campaign → ad group → ad. Use real profile, post, community, interest and location IDs. The supplied manual explicitly lacked verified vendor enum documentation; do not promote its guesses into validator constants. A local preview cannot prove that a guessed objective string is accepted by Reddit.

Reviewed ads use an existing authorized post_id; creating/publishing a post or a structured-post job is a separate, currently unqualified AMCP workflow. Do not invent a post ID. Deactivation uses the documented configured_status on an existing entity.

AMCP qualifies classic campaign/ad-group/ad creates and PATCH updates through amcp_write. New serving entities require configured_status: PAUSED; the connection needs adsread and adsedit. Ad-group creation requires conversion_pixel_id; CBO campaigns also require it. Ads require existing ad_group_id and post_id. CREATE_SAVED_AUDIENCE and UPDATE_SAVED_AUDIENCE are independent actions under reddit_account_ops for REDDIT_AUDIENCE targeting. Returned created IDs are immediately usable as parents. Updates cannot move a resource to another parent. Request configured_status: DELETED for reviewed deactivation, or status: DELETED for a saved audience. Reddit Drive/media import, Reddit Max, post publishing and customer-list ingestion remain unqualified. Return an actionable capability gap rather than trying an unrelated native route to escape review. Do not claim cross-platform campaign transfer is complete until each platform's structure, identity, currency and media constraints have been independently resolved.

## Current post metadata and lead-form contracts

`reddit_post_ops` actions `UPDATE_POST` and `UPDATE_STRUCTURED_POST` now use
reviewed writes. Supply the exact `t3_` post ID and only
`payload: {"data":{"allow_comments":false}}` (or explicit `true`). These methods
cannot edit a headline, destination or media. Discover the post through the
selected account's profile first. A cached ID is insufficient: preparation and
execution refresh the complete account profile list and bind the post's `t2_`
author to exactly one current profile. Changes to the selected post or binding
invalidate review; unrelated profile changes and provider timestamps do not.

Comments affect the post wherever it is used. Owner activation restrictions apply
to this potentially serving content, in addition to the account write grant,
`adsread`/`adsedit`, descriptive User-Agent, deployment write permission and normal
review/confirmation requirements. Read-back verifies the exact requested flag and
post author. An ignored update or uncertain response is not permission to retry.

`reddit_leadgen_ops` action `CREATE_LEAD_GEN_FORM` has a time-limited reviewed
contract. Reddit's [announced withdrawal](https://ads-api.reddit.com/docs/v3/history)
ends onsite form creation on **September 21, 2026**, and existing ads using these
forms will be paused on **September 30, 2026**. Prefer an external form with the
appropriate Pixel or Conversions API setup. AMCP conservatively refuses new form
creation from 00:00 UTC on September 21, including a review crossing the deadline
during state reads. The provider announcement does not specify a timezone.
Historical form reads and completed idempotency receipts remain available.

Before that cutoff, provide explicit `name`, HTTPS `privacy_link`, `prompt`, and
ordered `questions`. Every question needs a unique native type and a boolean
`required`; at least one must be required. Never invent consent/privacy wording
or add contact fields beyond the user's intended form. Returned IDs are scoped
only after the receipt confirms the selected account and exact requested form.
This creates a form definition, not an ad or a collection of lead records.

`PROVIDER_ACTION_UNSUPPORTED` at the deadline is an external product withdrawal,
not a missing user confirmation. Do not retry another legacy route to bypass it.
Creation of legacy posts and structured post jobs remains a separate outstanding
contract, including asynchronous result and media-transformation verification.

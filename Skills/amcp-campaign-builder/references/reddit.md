# Reddit

Use `reddit_native_action` and discover its current delegated operation schema. The historical named `reddit_*_ops` tools are crosswalk entries, not automatically exposed MCP tools.

Hierarchy: account → campaign → ad group → ad. Use real profile, post, community, interest and location IDs. The supplied manual explicitly lacked verified vendor enum documentation; do not promote its guesses into validator constants. A local preview cannot prove that a guessed objective string is accepted by Reddit.

Reviewed ads use an existing authorized post_id. Create and verify a post through the reviewed workflows below before referencing its returned ID; never invent one. Deactivation uses the documented configured_status on an existing entity.

AMCP qualifies classic campaign/ad-group/ad creates and PATCH updates through amcp_write. New serving entities require configured_status: PAUSED; the connection needs adsread and adsedit. Ad-group creation requires conversion_pixel_id; CBO campaigns also require it. The review reads the ad account's pixel list: a pixel the account does not list is refused with `REDDIT_PIXEL_NOT_IN_ACCOUNT` before anything is sent, so ask the user which pixel of `details.account_pixel_ids` to use (in a saved plan, amend the step with `amcp_campaign recover_step`) and never guess one. The review's `creative_impact.conversion_pixel` shows the pixel's name and last event; a `never_fired` or `stale` pixel is reviewable with a warning, which you relay to the user before execution. Ads require existing ad_group_id and post_id. CREATE_SAVED_AUDIENCE and UPDATE_SAVED_AUDIENCE are independent actions under reddit_account_ops for REDDIT_AUDIENCE targeting. Returned campaign, group and audience IDs are immediately usable as parents; post IDs require read-back first. Updates cannot move a resource to another parent. Request configured_status: DELETED for reviewed deactivation, or status: DELETED for a saved audience. Reddit private Drive import, Reddit Max and customer-list ingestion remain unqualified. Return an actionable capability gap rather than trying an unrelated native route to escape review. Do not claim cross-platform campaign transfer is complete until each platform's structure, identity, currency and media constraints have been independently resolved.

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

## Create a post and use it in a paused ad

Prefer `reddit_post_ops` action `CREATE_STRUCTURED_POST_JOB`, with the exact
`params.profile_id` from the selected account's profile discovery. The numeric
profile ID differs from its `t2_` Reddit author ID. Supply explicit
`payload.data.allow_comments` and `payload.data.creative`. Native formats are
TEXT, IMAGE, VIDEO, CAROUSEL and account-bound PROMOTED_POST. Every create uses
`amcp_write prepare` → review the frozen payload and effects → `execute` with the
original review/idempotency key. Posts have no paused state; content publication
must be intended by the user even though the later ad is paused.

TEXT requires headline, body and `text_format: PLAIN_TEXT` or valid serialized
`RICH_TEXT_JSON`. IMAGE needs an image asset and URL destination. VIDEO also needs
a thumbnail. Media assets use `{media:{type:"URL",url:"https://…"}}` with optional
documented name/crop/gifify fields. CAROUSEL keeps card order, including images,
destinations and captions. Use **2–7 cards**, the current setup guide's narrower
range; OpenAPI advertises 1–40, which does not establish eligibility outside that
range. Headlines have an AMCP review limit of 2,000 characters and bodies 40,000.
Display domains must match the destination host. Choose actual native CTA labels,
such as `Learn More`. Reminder events require `type: REMINDER` and UTC start_time.
Preserve explicit UGC enrollment: `user_generated_content.enroll_status: OPT_OUT`
or OPT_IN; never choose opt-in on the user's behalf.

Reddit downloads public media URLs directly and returns Reddit-hosted references.
Do not ask the user or LLM to download files merely to relay them. AMCP does not
fetch these source URLs, freeze their bytes, or measure size/dimensions/duration
in this native path. Use stable, provider-accessible content through completion.
Private Drive links require a separate server-side authorization/transfer bridge,
which is not yet qualified for Reddit; a sharing page is not a media URL. Never
paste OAuth tokens into a URL. Provider processing failure must remain visible.

`execute` returns a job receipt, not a usable post. Call `amcp_campaign verify`
with the original review ID. QUEUED/PROCESSING remains pending; CLIENT_ERROR or
SERVER_ERROR is terminal for that job. Read-only polling is resumable and bounded
in the worker; after its limit, continue the same verify call manually. Never
repeat the POST after a timeout or uncertain response. A correction needs a new
explicit review after reconciliation of the original receipt.

Verification checks the resolved post's author, exact requested configuration and
provider-hosted media references. It does not certify identical bytes/appearance,
approval or delivery. Only then is `verified_resources[0].id` available as a
connection/account-scoped `post_id`. Campaign plans can use
`{"$ref":"post#/verified_resources/0/id"}` in a dependent step's payload after
declaring `depends_on:["post"]`. `CREATE_AD` remains under `reddit_campaign_ops`;
provide the selected ad_group_id, verified post_id, name, PAUSED status and correct
click_url. Preparation rechecks the post author's current account membership.

`CREATE_POST` is the provider's legacy synchronous alternative. It supports TEXT,
IMAGE, VIDEO and CAROUSEL with the native legacy fields, including body/content
and thumbnail_url. It also requires review and post read-back before ID reuse.
Do not switch to legacy creation to escape a pending or uncertain job.

Community promotion is consequential: Reddit freezes voting and comments on both
the original and promoted copy. Use an already scoped original community post
owned by the selected profile, retain its exact headline and set allow_comments
false. AMCP snapshots its current content, checks the canonical community URL,
enforces owner activation policy and verifies the original's comment flag after
creation. Original voting state is not independently exposed by this read
contract. Reddit still decides SFW/public-community eligibility and ad approval;
profile posts cannot be promoted through this API.

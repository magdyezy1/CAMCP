# Google Ads: choose the channel's actual hierarchy

## Campaign call-interaction bid modifiers

The v23 `CampaignBidModifierService.MutateCampaignBidModifiers` RPC and the
`UPDATE_CAMPAIGN_BID_MODIFIER` / `REMOVE_CAMPAIGN_BID_MODIFIER` aliases support
reviewed changes to **existing** Search campaign `CALLS` modifiers. Discover the
exact `campaign_bid_modifier.resource_name` and current configuration first;
never guess the criterion ID. Supply that selected-customer resource with
`update: {resourceName, bidModifier}` and `updateMask: "bid_modifier"`, or
`remove: resourceName`. The multiplier is 0.1–10: **1.2 is +20%**. Device opt-out
zero is invalid for calls. Creation still lacks a qualified native identity
contract and remains blocked; do not supply the output-only `campaign` field
or fabricate a resource name to work around this boundary.

AMCP freezes all call modifiers for the selected campaigns, campaign configuration,
budget configuration and client-owned portfolio targets/limits. It checks parent
consistency across dependency reads and verifies complete native read-back. Limits
are 25 changes, 25 pages per query, 80 requests, 4 MiB per page, 8 MiB total and a
60-second state-read deadline. A partial or failed page cannot prove absence.
Manager-owned portfolio strategies require a separate authority contract.
Removal restores default bidding and can increase bids, so changes retain spend
acknowledgement and the owner's activation/deletion policies. Smart Bidding can
ignore manual adjustments; configuration verification does not prove serving,
call-asset eligibility, auction effects or performance. No budget is changed.
Retain the original review/key after an uncertain response and inspect read-back.

Official references checked 2026-09-20: [v23 resource](https://developers.google.com/google-ads/api/reference/rpc/v23/CampaignBidModifier),
[complete configuration fields](https://developers.google.com/google-ads/api/fields/v23/campaign_bid_modifier),
[portfolio fields](https://developers.google.com/google-ads/api/fields/v23/bidding_strategy),
and [interaction ranges and bidding eligibility](https://support.google.com/google-ads/answer/2732132?hl=en).

## Ad-group bid modifiers

Use `google_ads_v23_ad_group_bid_modifier_mutate_ad_group_bid_modifiers` or its
`CREATE_AD_GROUP_BID_MODIFIER`, `UPDATE_AD_GROUP_BID_MODIFIER` and
`REMOVE_AD_GROUP_BID_MODIFIER` aliases. A creation specifies the discovered
`adGroup`, one `device` or hotel criterion and an explicit `bidModifier`.
Supported hotel criteria are date selection, advance booking window, length of
stay, check-in weekday and check-in date range. Hotel criteria require a Hotel
campaign. Numeric ranges require explicit ordered boundaries; dates use valid
`YYYY-MM-DD` strings. The provider still enforces product and bidding eligibility.

A modifier is a multiplier: `1.2` means +20%, `0.8` means -20%. Use values from
0.1 to 10; zero is a device opt-out only. Do not infer a modifier from performance
without user-approved business reasoning. Updates use the exact discovered
composite resource name and `updateMask: "bid_modifier"`; criterion and parent
are immutable. An existing explicit modifier requires an update. Removal can
restore a campaign-level/default bid and increase cost; it is not a bid of zero.

Inspect → prepare → review → execute with `spend_change_confirmed:true` → verify.
AMCP freezes the selected customer's timezone/currency, parent configurations,
budget amounts and complete modifier collections for the affected groups.
The selected connection must retain the Ads OAuth scope and account write grant.
Owner activation policy covers every modifier change; deletion policy also
covers removal. The review does not convert multipliers into monetary ceilings
or forecast billed spend. Shared portfolio strategy internals and live auction
effects are not certified by this snapshot.

Read-back verifies exact criteria and multipliers. For removal it checks that
the local override is absent, including a native inherited `CAMPAIGN` source.
Unknown sources, partial pages or error-bearing receipts remain unverified.
After a lost/partial response retain the original claim; never retry the write
automatically. A verified setting does not prove a Smart Bidding strategy uses it.

Local bounds: 25 operations, 1000 modifiers across the selected groups, 1100
total state rows, 25 pages per query, 80 requests, 4 MiB per response, 8 MiB total
and 60 seconds per state snapshot. A batch that would exceed verification
capacity is refused. Campaign-level bid-modifier creation remains unqualified:
the v23 resource marks `campaign` output-only and the create operation says no
resource name is expected; the correct parent-binding request needs additional
provider evidence. Do not send a guessed campaign field or temporary identity.

References checked 2026-09-19: [v23 resource](https://developers.google.com/google-ads/api/reference/rpc/v23/AdGroupBidModifier),
[selectable fields](https://developers.google.com/google-ads/api/fields/v23/ad_group_bid_modifier),
[bidding workflow](https://developers.google.com/google-ads/api/docs/campaigns/bidding/manage-bid-modifiers).

Use `google_ads_native_action`; `google_ads_v23_google_ads_search` accepts `payload.query` for GAQL. Read the campaign's `advertising_channel_type`, currency, timezone and budget before choosing a write family. Send string resource names (`customers/<id>/...`); updates require an explicit field mask.

The v23 campaign fields are `start_date_time` / `end_date_time` (or their camelCase wire names), formatted `YYYY-MM-DD HH:mm:ss` in the customer timezone. Date-only business recipes produce `00:00:00` at the start and `23:59:59` on the inclusive end date. Do not use removed `start_date`/`end_date` fields in native v23 requests. New recipes use the current fields; an old unsubmitted saved plan containing removed fields needs correction and a new review. Never edit a submitted/uncertain request or its idempotency key. `INVALID_VENDOR_BODY` identifies fields/types/enums incompatible with the pinned official Discovery schema. `VENDOR_SCHEMA_UNAVAILABLE` means the maintainer must repair or regenerate schema evidence; do not bypass validation. Schema evidence does not establish business eligibility or project access. [v23 Campaign fields](https://developers.google.com/google-ads/api/reference/rpc/v23/Campaign).

- Search: campaign → ad group → responsive search ad / keyword criterion.
- Performance Max: campaign → asset group → asset links and signals. Do not construct an ad group or positive keyword target.
- Demand Gen: campaign → ad group → Demand Gen ad. Do not invent a `DEMAND_GEN_*` ad-group type or treat it as Search keyword targeting.

The supplied guide's blanket statement that PMax has no keyword path is too broad: Google supports **negative campaign keyword criteria** for PMax. Account-level negative criteria are another distinct scope. PMax campaign criteria also support locations and other documented exclusions. Use the current native criterion contract, and distinguish provider support from whether AMCP has a reviewed write adapter for it. [Google's PMax criteria guide](https://developers.google.com/google-ads/api/performance-max/create-campaign-criteria).

Native budget/bid amounts use micros of the account currency. AdCustomizer resource identities can be immutable while specific values/operations differ by resource; inspect the current schema instead of automatically deleting and recreating every customizer described as an update. Recommendation auto-apply subscriptions are permission to let Google make later changes and require that specific user intent.

Use `amcp_media` for remote image/video import and pass the returned asset resource name to the appropriate field/link. A YouTube upload ID alone is not the completed Google Ads asset. Follow the returned continuation and processing status. An existing YouTube video may be registered by ID without uploading it again.

AMCP reviewed execution covers the qualified campaign/ad-group/ad/budget/asset/asset-group contracts plus campaignCriteria, adGroupCriteria, sharedSets, sharedCriteria and campaignSharedSets mutations. Positive Search keywords belong to an ad group and start PAUSED; negative campaign keywords use negative:true. Existing user lists/audiences can be targeted where the criterion supports them; creating arbitrary audiences/customer lists is separate. Shared exclusion-list members must match their enabled parent list type. Keep parent~criterion composite resource names intact. Use native decimal-string micros for bids and explicit field masks for mutable fields; criterion identity/parent/negative changes require remove/create. All targeting executions require spend_change_confirmed. Other catalog routes can compile locally but must not be described as reviewed-write support merely because their RPC exists. A GAQL 403 is an account/app permission problem; it is not repaired by changing field names at random.

## Link existing assets to their intended scope

Reviewed `campaignAssets:mutate`, `adGroupAssets:mutate`, `customerAssets:mutate` and
`assetGroupAssets:mutate` support create, status update and remove. Both RPC actions and
their explicit legacy aliases use the same contract. For example, use
`google_ads_v23_campaign_asset_mutate_campaign_assets` with a create containing
`campaign`, `asset` and `fieldType`. Reuse the existing asset resource names; an uploaded
or created asset is not attached until its association has succeeded.

For a pack of six sitelinks, four callouts and one structured snippet, discover the eleven
existing assets in the selected customer, read their text and URLs, and inspect one batch
of eleven `create` operations with the appropriate `SITELINK`, `CALLOUT` or
`STRUCTURED_SNIPPET` role. Each campaign link names the exact campaign. Do not infer the
scope from an asset's name. A batch can contain 1–25 operations; larger packs need separate
reviews. Check all eleven association receipts and use `amcp_campaign verify` with the
original review ID. Provider approval, serving and impression delivery remain separate.

Omitting create `status` is treated as enabling the association for spending-policy checks.
Choose `PAUSED` if a paused association is intended; do not choose it merely to evade an
owner's restriction. Updates permit only `status`, with `updateMask: "status"`. Keep the
symbolic field type in composite IDs such as
`customers/123/campaignAssets/456~789~SITELINK`. Legacy identity components also require
`field_type: "SITELINK"`, not an enum number.

`ASSET_LINK_EXISTS` means that exact parent/asset/role is already attached. Inspect its
status instead of recreating it. `ASSET_TYPE_MISMATCH` requires choosing the correct asset
type; `INVALID_ASSET_PARENT` requires an existing enabled or paused parent;
`INVALID_ASSET_LINK` identifies an invalid role, identity or mutable field. Asset text,
URLs, selected parent configuration and existing links are snapshotted. Pagination or
missing prerequisite assets blocks preparation. Changed asset text or a concurrently
created association blocks execution with `STATE_CHANGED`. Delivery credentials on lead
forms are not retrieved or exposed by this link workflow.

Asset association execution requires `spend_change_confirmed: true`, including an omitted
create status: the link changes which creative may serve under the parent.

## Configuration and labels

Reviewed v23 configuration contracts cover labels and campaign/ad-group/ad/criterion label
associations; customizer attributes and customer/campaign/ad-group/criterion values; ad
parameters; campaign groups; conversion custom variables; remarketing actions; asset-group
signals; and customer negative criteria. Use the exact native RPC payload and inspect it.
Only declared mutable fields accept update masks. Customizer attribute names/types are
immutable, so the historical UPDATE_CUSTOMIZER_ATTRIBUTE alias remains unsupported.
Conversion custom variables and remarketing actions have no native remove operation.

Discover existing parent and reference resource names in the selected customer. Composite
IDs must include every component in provider order. Ad parameters require an existing
positive keyword criterion and parameterIndex 1 or 2. Customizer values must match their
attribute type; supply numeric, currency or percentage formatting from the business brief.
Select exactly one audience/search-theme signal or one customer exclusion type. Never
invent an audience, shared list, price or conversion tag to satisfy a required input.

`CONFIGURATION_EXISTS` means reuse or inspect the existing association. Preparation freezes
the configuration-bearing results and reference resources; query cost and request telemetry
are excluded. Real name, targeting, budget, label or text changes still conflict. Customizers,
ad parameters, signals and exclusions can change existing ads and require spend confirmation.
After execution, verify the exact resource or deletion. Configuration read-back establishes
neither serving nor conversion collection; do not retry a lost mutation under a new key.

## Asset sets and feed associations

Reviewed v23 asset-set contracts cover `assetSets:mutate` and create/remove on
`assetSetAssets:mutate`, `campaignAssetSets:mutate`, `adGroupAssetSets:mutate` and
`customerAssetSets:mutate`. Both RPC and legacy actions use the same contracts.
Create the feed, attach its existing assets, then link the feed to its intended scope.
Asset-set links have provider-owned status; they do not accept a caller PAUSED status.
They require spend confirmation and respect the owner's activation/deletion restrictions.

Page feeds and the eight dynamic advertiser feed types support creation, name updates,
membership and campaign links. A static location group requires its exact LOCATION_SYNC
parent; every location attached manually must already belong to that sync parent.
Ad-group links accept location sets/groups. Customer links accept LOCATION_SYNC and
bind the selected customer through the composite resource name. Google does not permit
selecting `customer_asset_set.customer` in GAQL; AMCP does not issue that invalid query.
Merchant Center feed settings and Business Profile dynamic-group filters support explicit
qualified update masks. Full-object replacements verify cleared fields too. Business
Profile listing IDs use Google's signed int64 representation, which can be negative;
do not turn these into positive IDs or unsafe JavaScript numbers.

`ASSET_SET_VARIANT_UNQUALIFIED` means that the exact creation variant lacks a complete
read-back or credential workflow. LOCATION_SYNC creation needs a separate Business
Profile authorization flow; chain/map filters are not fully selectable in the pinned
GAQL contract. HOTEL_PROPERTY and TRAVEL_FEED creation also remain unqualified. Do not
paste OAuth tokens into a payload, select another type to evade the refusal, or call a
raw mutation. Existing qualified sets can still be used for supported operations.

Preparation captures feed configuration, all current enabled membership, and asset
content. Reads are paginated and bounded (100 related sets, 1,000 resources per query,
100 pages per query, 300 requests, 16 MiB read/8 MiB retained state). It rechecks set
configuration and membership after reading content. A failed, truncated, foreign or
changing read refuses preparation. Labels and membership are compared as sets; ordered
fields keep their order. Real URL/content/member changes invalidate the review.
External Merchant Center inventory and future location synchronization are not frozen by
an AMCP review. Read-back verifies the submitted configuration/link, not feed processing,
provider approval, destination quality or ad delivery. Keep the original idempotency key
after a lost response and reconcile before preparing any correction.

### Saved Keyword Planner workspaces

The five v23 `keywordPlans`, `keywordPlanCampaigns`, `keywordPlanAdGroups`,
`keywordPlanAdGroupKeywords` and `keywordPlanCampaignKeywords` mutate routes now
have reviewed create/update/remove contracts. Use their `google_ads_v23_*_mutate_*`
actions through `amcp_write`, with exact selected-customer resource names. Create
and verify each parent before using its returned identity for a child. Temporary
negative IDs or a campaign-build recipe do not substitute for that binding.

These resources save research; they do not create serving campaigns. CPC bids are
hypothetical native micros in the selected account's currency. Campaign bids are
required; groups inherit from campaigns and positive keywords inherit from groups
unless an explicit override is set. Set an optional override to `null` with
`updateMask: "cpcBidMicros"` to clear it. Negative keywords cannot have a CPC
override, and campaign-level keywords must have `negative: true`. Negativity is
immutable. Names, keyword text/match type, native parent bindings and documented
planning configuration use explicit masks; IDs remain immutable.

Discover country/language constants; never invent them. A plan permits one
campaign, up to 20 campaign geo targets, and one campaign language. Geo targets
are native objects such as `{"geoTargetConstant":"geoTargetConstants/2682"}`.
Use `[]` with the appropriate mask to clear geo/language membership. Whole
`forecastPeriod` replacement must choose exactly one documented relative interval
or inclusive custom date range no longer than a year. `null` clears the period.
Relative intervals follow Google's account locale, and future-date eligibility
is checked when forecasting. Editing an old saved plan does not refresh its dates
or make its forecast current. Forecasting is a separate read with its own quota
and access requirements.

Preparation reads the complete affected saved plan hierarchy twice, including
inherited settings and descendants of a parent selected for deletion. Parent moves
freeze both plans. Real changes anywhere in that reviewed hierarchy conflict;
geo ordering and per-query telemetry do not. Unknown configuration is retained.
Pagination is bounded at 100 pages/query, 300 requests, 15,000 resources, 32 MiB
of responses and 16 MiB retained state. An oversized, incomplete, failed or changing
plan is refused explicitly. Provider quotas remain authoritative.

Read-back verifies the exact mutated resource, including object replacement and
cleared optional fields. Parent removal verifies that parent's absence; it does
not independently certify all provider-side descendant cleanup. It does not claim
forecast quality, demand, account access or actual ad delivery. Planning edits do
not require ad-spend confirmation, but still require review, write grants,
deployment permission and any applicable owner deletion policy. Never retry an
uncertain mutation as a fresh creation: inspect its retained receipt and current
resources before reviewing a correction.

### Draft generation and construction recommendations

`GENERATE_TEXT_ASSETS`, `GENERATE_IMAGE_ASSETS`, `GENERATE_RECOMMENDATIONS` and
their v23 RPC actions now execute as scoped draft-generation requests. They make
no advertising configuration changes. Use an Ads connection with the full
`https://www.googleapis.com/auth/adwords` scope and the exact customer ID. Google
social sign-in or Analytics access is insufficient. Text/image generation remains
a closed-beta provider capability; a mapped request does not establish eligibility.

Text generation needs requested field types and either a native existing text
context or an advertising channel with a final URL. Use one existing AssetGroup
or AdGroupAd from the selected customer. Images support the v23 freeform, final-URL
and product-recontext inputs; choose one. Contrary to descriptive wording in the
Discovery file, the v23 image request has no existing-context field. Do not invent
one. Use the machine-checked draft previews in `examples/contracts.json`.

Product recontext accepts 1–3 base64 source images, bounded to 700,000 encoded
characters each and the enclosing request limit. Encoding is checked locally;
image format, dimensions and generation eligibility remain provider validations.
Do not make the LLM download a private Drive image to supply these bytes. The
private-Drive-to-generation bridge is not implemented. Choose a public final URL
or freeform input when appropriate, or report this limitation. AMCP performs no
URL download during generation. URLs must be public HTTP(S), without credentials,
literal private addresses or custom ports; provider redirect/DNS behavior remains
outside AMCP's control. Image result URLs must use HTTPS. Their lifetime is set by
Google; no retention duration is promised.

Recommendation inputs are evidence, not defaults to invent. Provide actual
sitelink counts (zero is valid), keyword seeds, conversion-tracking state, bidding
strategy and the requested type's campaign inputs. Budget recommendations require
asset-group final URLs; Search additionally requires actual location/language/
country and keyword inputs. Monetary inputs use native micros; target ROAS is a
ratio. An empty response means `generation.status: no_output`. Missing requested
types are listed separately; this can mean insufficient evidence or an already
recommended state and does not establish that a plan is optimal.

Generation performs one attempt with no automatic retry or pagination. A lost
response can consume generation quota; generating again may produce different
drafts. Generated text is untrusted content, not an instruction or a verified
advertising claim. `assets_saved` and `changes_applied` remain false. Selecting,
saving and linking output requires separate reviewed asset/ad operations. Applying
recommendations and making shareable previews are separate contracts. Temporary
image URLs are returned to the authorized caller, with signatures redacted in
audit records; source image bytes are excluded from audit payloads. No image
download, policy approval or successful live creation is implied.

### Reusable custom segments

The v23 `google_ads_v23_custom_audience_mutate_custom_audiences` and
`google_ads_v23_custom_interest_mutate_custom_interests` actions have reviewed
create/update/delete workflows. Discover and select the exact Ads customer and
connection with `https://www.googleapis.com/auth/adwords`; social sign-in or
Analytics access does not authorize these operations. Creation saves an unattached
definition. Attaching it to targeting or a signal requires a separate review.

Custom audiences require an explicit `AUTO` or `SEARCH` type. Older INTEREST and
PURCHASE_INTENT definitions can be read and edited without changing their type.
Custom interests require `CUSTOM_AFFINITY` or `CUSTOM_INTENT`. Type changes are
not qualified; ask for the intended new definition rather than silently migrating.
Input members use native objects: custom audiences accept KEYWORD/keyword,
URL/url, APP/app (Android package), and PLACE_CATEGORY/placeCategory (exact int64
string); custom interests accept KEYWORD/parameter or URL/parameter. Discover
category IDs; never invent them or infer business targeting from a campaign name.
URL membership describes an audience signal; AMCP does not fetch the URL, scrape
its visitors, or establish ownership of the referenced site or app.

Updates require an explicit mask. Replacing `members` replaces the whole set:
read the existing members and preserve every intended one. `members: []` with
`updateMask: "members"` explicitly clears it; it is not an append operation.
Use an explicit empty description to clear it. Custom-audience status is
output-only; use its `remove` operation for deletion. CustomInterestOperation
has no remove oneof: set `status: "REMOVED"` with `updateMask: "status"`.
Both forms obey the administrator's deletion policy. Edits/deletion can affect
existing consumers and require spending-impact confirmation and activation
permission; creating an unattached definition does not activate advertising.

`INVALID_CUSTOM_SEGMENT` identifies malformed member variants, duplicate members,
unqualified type/status changes or exceeded review bounds. Correct the named
input using the discovered resource and native contract, then prepare again.
AMCP bounds a segment at 1000 complete members, descriptions at 1024 characters,
and apps at 512 characters. Keyword validation limits input to 10 words/80
character units, counting CJK/full-width characters twice. URL members require
HTTP(S), no embedded credentials and at most 2048 characters. These local
validation bounds do not establish native eligibility or available account quota.

Review snapshots and read-back normalize member order and documented empty
ProtoJSON defaults only; real membership edits and unknown configuration remain
protected. An incomplete, missing, foreign, duplicated or oversized state refuses
preparation. Read-back verifies exact saved configuration and native identity,
not reach, approval, ad serving or measurement performance. A lost response or
partial mutation keeps the original review claim across restarts; never submit
another create to recover. Inspect the receipt and current resources first.

References checked 2026-09-19: [v23 custom audiences](https://developers.google.com/google-ads/api/fields/v23/custom_audience),
[v23 custom interests](https://developers.google.com/google-ads/api/fields/v23/custom_interest)
and [custom audience type update restriction](https://ads-developers.googleblog.com/2023/08/change-to-updates-of-google-ads-custom.html).
Native request fields and operation oneofs also use the pinned v23 Discovery
schema. Provider acceptance and legacy custom-interest account eligibility have
not been verified live.

## Bidding seasonality adjustments and data exclusions

`google_ads_v23_bidding_seasonality_adjustment_mutate_bidding_seasonality_adjustments`
and `google_ads_v23_bidding_data_exclusion_mutate_bidding_data_exclusions` support
reviewed native create/update/remove operations. Choose the exact client customer
and Ads connection with the adwords scope. The pinned v23 resources cannot be used
in manager customers, even though the Google Ads website supports manager-level
workflows. Manager fan-out is a different workflow; do not switch the account
silently or infer write grants from manager visibility.

Ask for the expected conversion-rate change or known tracking outage, its dates,
campaign/device scope and business reason. Discover account timezone, existing
events and actual campaign/bidding configuration before preparing. Do not invent
a sale uplift, outage or conversion-delay window. A data exclusion affects the
click data used for Smart Bidding; it does not erase or repair reporting. A planned
future outage is an explicit user decision, not an inferred routine optimization.

Use account-local `yyyy-MM-dd HH:mm:ss` values: inclusive start, exclusive end,
more than zero and at most 14 elapsed days. Ambiguous/nonexistent DST boundaries
are refused; select an unambiguous account-local time. New seasonality events and
changed seasonality start dates must start in the future. A completed event may
still be renamed or removed. Native eligibility and edit-time restrictions remain
provider decisions. `conversionRateModifier` is a multiplier: 1.5 means +50%,
0.8 means -20%, and 1 means no adjustment. It does not set a budget or guarantee
spend, CPA or ROAS. Never add an opposite adjustment when a promotion ends.

`CAMPAIGN` requires 1–2000 exact selected-customer campaign resource names. This
contract qualifies Search/Display/Shopping Smart Bidding and Performance Max;
Search/Display/Shopping seasonality requires a CPA or ROAS target. App beta and
cross-customer portfolio strategies need separate qualification. `CHANNEL`
requires SEARCH, DISPLAY or SHOPPING in `advertisingChannelTypes`; it also applies
to future matching campaigns. The review lists current campaigns only. `CUSTOMER`
is a legacy read-only scope. Omitted or empty `devices` means all devices.

Create named events, with an explicit multiplier for seasonality. Updates use an
exact mask and explicit values. Arrays replace complete membership. Changing from
campaign scope to channel scope must also set `campaigns: []`; the inverse must
clear `advertisingChannelTypes`. `devices: []` restores all devices; an empty
description clears it. Status and numeric event IDs are output-only. Remove uses
the exact discovered native resource. Removing data exclusions can disrupt bid
learning; never remove one automatically to undo a tracking outage.

All event operations require spending-impact confirmation and obey activation
and deletion policies. Reviews include both event collections, selected-customer
timezone/currency, affected old and new campaign scopes, native budgets and local
portfolio targets/limits. Existing event history is frozen as a whole to establish
creation identity and exclusion capacity. An unrelated event edit can therefore
require a fresh review. Known set ordering and query telemetry do not conflict;
configuration edits and unknown ordered fields do. No live bid effect is inferred
from successful configuration verification.

`INVALID_BIDDING_EVENT` means an invalid field/mask, date, scope, multiplier,
unqualified campaign, conflicting name or exceeded input/history bound. Correct
the named input or narrow the work, then prepare again. `BIDDING_EVENT_STATE_UNVERIFIED`
means identity, completeness, consistency, timezone or a dependency could not be
established. Reconnect or resolve the native read issue; never supply fabricated
before-state or bypass review. Bounds: 25 atomic operations, 1000 historical
events per kind, 2000 current campaigns, 25 pages per read, 128 reads, 10000 total
rows, 4 MiB per response, 8 MiB total and 60 seconds. Google limits active data
exclusions to 500; creation must leave room for complete read-back too.

Retain the original review/idempotency key after a lost or partial response.
Verify exact stored configuration or complete collection absence. Field disagreement
requires investigation and a new corrective review, never a blind retry. Verification
does not establish auction behavior, learning convergence, future membership,
tracking repair, account eligibility or provider approval.

Sources checked 2026-09-19: [v23 seasonality fields](https://developers.google.com/google-ads/api/fields/v23/bidding_seasonality_adjustment),
[v23 exclusion fields](https://developers.google.com/google-ads/api/fields/v23/bidding_data_exclusion),
[API seasonality guide](https://developers.google.com/google-ads/api/docs/campaigns/bidding/seasonality-adjustments),
[API exclusions guide](https://developers.google.com/google-ads/api/docs/campaigns/bidding/data-exclusions),
[seasonality eligibility](https://support.google.com/google-ads/answer/10369906),
[exclusion effects and planned outages](https://support.google.com/google-ads/answer/10370710)
and [portfolio configuration fields](https://developers.google.com/google-ads/api/fields/v23/bidding_strategy).
Field/reference fixtures and isolated lifecycle tests are synthetic; these actions
have not been verified against a live Ads account.


## Conversion goals and campaign inheritance

The four v23 conversion-goal RPCs and the existing
`UPDATE_CAMPAIGN_CONVERSION_GOAL` / `UPDATE_CONVERSION_GOAL_CAMPAIGN_CONFIG`
aliases have reviewed contracts. Google creates standard customer/campaign goals
and campaign configs automatically: update them, never invent a create or remove.
Custom goals support create, rename, complete conversion-action replacement and
remove. Inspect the selected action before preparing its exact native body.

Ask the user which conversion actions and campaigns should optimize for which
business outcomes. Discover their actual IDs, ownership, status and definitions.
Do not choose a goal from its name, assume secondary actions are excluded, or
infer that a working tag records the right business event. This contract requires
a client account that is its own conversion customer. Manager-shared tracking and
App selective optimization need separate contracts and must stop here.

Changing a customer goal propagates to campaigns using CUSTOMER defaults.
Changing campaign biddability or attaching a custom goal switches to CAMPAIGN
configuration. Attaching a custom goal also includes secondary actions and leaves
standard goals active. Disable unwanted standard goals through separately reviewed
changes. Resetting goalConfigLevel to CUSTOMER restores inherited biddability; any
retained custom-goal reference is inactive. Explicitly clearing customConversionGoal
uses an empty string and its exact mask. Do not promise that clearing also resets
the configuration level.

Use 1–25 atomic operations. These four native request types have no partialFailure
field, even false. Standard/config updates require masks covering exactly the
explicit fields; immutable IDs/category/origin/campaign are not update fields.
Custom creation requires a unique name and 1–100 distinct enabled local conversion
actions. Membership updates replace the complete set. Delete only after separately
detaching from all current campaign-level configurations. Unattached creation has
no serving effect; subsequent edits/attachments/removals require spending approval
and obey owner activation/deletion policies.

A durable two-step plan may create a custom goal and then reference its verified
receipt using `{$ref:"goal#/data/results/0/resourceName"}` in the dependent config
step. Each step gets its own frozen review and approval. IDs from unverified or
uncertain results must not be used. Inspect both the requested changes and the
inheritance effects before executing.

Reviews bind the complete current non-App goal graph, conversion definitions,
campaigns, budgets and local portfolios. They follow bounded pages and exclude
response cost telemetry. They support at most 2,000 campaigns/actions/custom goals
and 10,000 campaign goals, with additional total request/row/byte/deadline limits.
`INVALID_CONVERSION_GOAL` names an invalid or unqualified input or prerequisite.
`CONVERSION_GOAL_STATE_UNVERIFIED` means the complete scoped state could not be
established; resolve the stated cause and prepare again. Never use a partial read
as an empty account. A changed hash requires reviewing actual changed fields.

Read-back verifies saved configuration and inheritance, not tracking accuracy,
historical conversion counts or bidding performance. Keep the original review and
idempotency key after lost responses; reconcile before any corrective mutation.
Local fixtures exercise these rules. No live acceptance is claimed.

Sources checked 2026-09-20: [conversion-goal overview](https://developers.google.com/google-ads/api/docs/conversions/goals/overview),
[customer defaults](https://developers.google.com/google-ads/api/docs/conversions/goals/customer-goals),
[campaign goals](https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals),
[v23 customer fields](https://developers.google.com/google-ads/api/fields/v23/customer_conversion_goal),
[campaign fields](https://developers.google.com/google-ads/api/fields/v23/campaign_conversion_goal),
[config fields](https://developers.google.com/google-ads/api/fields/v23/conversion_goal_campaign_config),
[custom fields](https://developers.google.com/google-ads/api/fields/v23/custom_conversion_goal),
and pinned official v23 Discovery request models. The public field pages were
updated 2026-09-10; the evidence fixture records extraction provenance.

## Google Ads recommendation dismissal

Use `google_ads_v23_recommendation_dismiss_recommendation` or the existing
`DISMISS_RECOMMENDATION` alias with the explicitly selected connection/customer
and native `payload.operations: [{resourceName: "customers/{id}/recommendations/{id}"}]`.
Copy complete discovered recommendation names, including opaque IDs; never turn
them into numeric IDs. Ask the user which recommendations they intend to dismiss.
A provider recommendation or optimization score is not authority to apply it.

The contract supports 1-100 distinct operations with `partialFailure` omitted or
false. Google requires every operation in an atomic request to have the same
recommendation type; AMCP verifies that from current native reads. Prepare separate
reviews for different types. Already-dismissed or expired IDs are not recreated
or silently replaced. No `validateOnly`, response-content override or arbitrary
parameters are part of the native dismissal request.

Prepare freezes the exact client customer, recommendation IDs/types, dismissed
state and campaign/ad-group/budget associations. Complete pages are read twice,
with 25 pages per query, 100 requests per discovery, 100 recommendation rows per
collection, 2 MiB per response, 8 MiB total and a 60-second monotonic deadline.
Duplicates, missing targets, foreign parents, incomplete counts and changing
snapshots stop the review. Campaign association order, request IDs, query cost
and estimated performance do not cause false conflicts. A changed target or
state still reports STATE_CHANGED with its exact JSON field paths. The state
projection is for dismissal only; it does not qualify applying suggested values.

Review the exact IDs, types and affected native parents, then execute with the
original review/key and confirmation. This action does not edit an advertising
budget, activate a campaign or change auto-apply subscriptions. Owner deletion
policy covers dismissal even though its method is POST. Names/opaque IDs that
contain budget or bid words do not require false spend-change acknowledgment.
The selected account's manager routing, current adwords scope and grants are
checked throughout the workflow; another login cannot substitute its access.

A successful native receipt must identify every selected target exactly once.
Read-back must observe `dismissed: true` for those same identities and unchanged
associations. A disappeared recommendation remains inconclusive: recommendations
can expire and receive replacement IDs independently. A successful HTTP response
or absent query result is not proof of dismissal. Lost, partial or foreign
receipts retain the original submission claim; never blindly repeat a mutation.
`amcp_campaign verify` retries only the read. Applying recommendations and managing
subscriptions remain separate, unqualified write families.

`INVALID_RECOMMENDATION_DISMISSAL` identifies malformed requests, mixed types or
already-dismissed prerequisites. `RECOMMENDATION_STATE_UNVERIFIED` identifies
failed, missing, malformed, moving or bounded-out native state. The module and
negative tests use synthetic provider responses; no live dismissal was performed.

Official sources checked 2026-09-20:
[v23 dismissal request and atomic-type limit](https://developers.google.com/google-ads/api/reference/rpc/v23/DismissRecommendationRequest),
[v23 response and partial errors](https://developers.google.com/google-ads/api/reference/rpc/v23/DismissRecommendationResponse)
(both updated 2026-02-23),
[v23 native recommendation fields](https://developers.google.com/google-ads/api/fields/v23/recommendation),
[retrieval, dismissal and recommendation expiry](https://developers.google.com/google-ads/api/docs/recommendations),
and [official dismissal sample](https://developers.google.com/google-ads/api/samples/dismiss-recommendation).
The sample currently uses newer versions; execution remains pinned to the
unchanged v23 Discovery route and request/response fields, which tests check.

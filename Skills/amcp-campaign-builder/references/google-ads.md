# Google Ads: choose the channel's actual hierarchy

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

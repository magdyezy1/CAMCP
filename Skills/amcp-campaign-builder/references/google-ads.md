# Google Ads: choose the channel's actual hierarchy

## API version

AMCP sends Google Ads requests at **v25** (since 2026-09-28) and checks each one against the pinned v25 Discovery
document. Action names keep their captured `google_ads_v23_…` spelling: they are names, not the version sent. The
sections below cite the v23 references they were written against; every contract was rechecked against v25, and
only these changed:

- Shareable previews take a new request and result shape (below).
- Lifecycle goals are gone: `CONFIGURE_*_LIFECYCLE_GOAL`, `LIST_*_LIFECYCLE_GOALS` and the two native lifecycle RPCs
  return `PROVIDER_ACTION_UNSUPPORTED`. New customer acquisition is now a goal type (`goal`, `campaign_goal_config`).
- The campaign-level video brand safety setting is gone: `SET_CAMPAIGN_BRAND_SAFETY` is refused. Set the account's
  setting under Account settings, or exclude content labels per campaign (`SET_CAMPAIGN_CONTENT_LABEL_EXCLUSIONS`).
- The user list customer type `LOYALTY_SIGN_UPS` is gone.

GAQL field facts (selectable, repeated) come from the v23 field reference; the v25 Discovery document confirms each
field AMCP reads still exists with the same cardinality.

`requestError UNKNOWN` is an error newer than the API version AMCP sends; a refused build or mutate applied nothing; the prepare's provider check names the field path.

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

**Demand Gen targeting.** Which level a Demand Gen campaign takes location and language at is its own `demand_gen_campaign_settings.upgraded_targeting`, which can only be set when the campaign is created and defaults to `true`. With it on, which is what a new campaign has, they go on its ad groups (`google_ads_v23_ad_group_criterion_mutate_ad_group_criteria`, one criterion per ad group), and a positive campaign-level `location` or `language` create on that campaign is refused with `INVALID_TARGETING_MUTATION` naming that route (the owner's live execute of it was refused by Google with `requestError: UNKNOWN`). A campaign created with it off, an older one, is the other way round: they go on the campaign, and an ad-group one is refused, naming `google_ads_v23_campaign_criterion_mutate_campaign_criteria`. The review reads the field from the campaign: an explicit `true` is the ad-group level and an explicit `false` the campaign level, and a campaign whose row has no value (Google can omit a field, and an older campaign may come back without it) or a value the review cannot read refuses neither form; the provider check that a Google prepare runs by default answers. Only a campaign that a build itself creates takes Google's default, `true`, when its create leaves the field out. An ad group of any other channel, VIDEO included, takes neither. Google takes no language exclusion at either level, so one is refused saying so; a location exclusion (`negative: true`) is not refused locally at either level of an upgraded campaign or of one whose value the review cannot read, and the provider check answers for it, so read `provider_check` before executing one; on a campaign created without upgraded targeting it goes on the campaign, like a positive one, and the ad-group form is refused there, naming the campaign route.

The supplied guide's blanket statement that PMax has no keyword path is too broad: Google supports **negative campaign keyword criteria** for PMax. Account-level negative criteria are another distinct scope. PMax campaign criteria also support locations and other documented exclusions. Use the current native criterion contract, and distinguish provider support from whether AMCP has a reviewed write adapter for it. [Google's PMax criteria guide](https://developers.google.com/google-ads/api/performance-max/create-campaign-criteria).

Native budget/bid amounts use micros of the account currency. AdCustomizer resource identities can be immutable while specific values/operations differ by resource; inspect the current schema instead of automatically deleting and recreating every customizer described as an update. Recommendation auto-apply subscriptions are permission to let Google make later changes and require that specific user intent.

Use `amcp_media` for remote image/video import and pass the returned asset resource name to the appropriate field/link. A YouTube upload ID alone is not the completed Google Ads asset. Follow the returned continuation and processing status. An existing YouTube video may be registered by ID without uploading it again.

AMCP reviewed execution covers the qualified campaign/ad-group/ad/budget/asset/asset-group contracts plus campaignCriteria, adGroupCriteria, sharedSets, sharedCriteria and campaignSharedSets mutations. Positive Search keywords belong to an ad group. A new keyword, ad group, asset group or ad may start ENABLED under a parent the review reads as PAUSED (nothing serves until that parent is enabled, which is its own reviewed activation), so a paused build needs no second pass per keyword. Under a parent the review reads as PAUSED the create also needs no `spend_change_confirmed` (the owner's decision of 2026-11-19): an ad group, an asset group, an ad, a keyword or a positive campaign criterion created there, and a campaign created PAUSED, since nothing they create can serve until the parent is enabled, which is its own reviewed write and asks. The review reads a request of one-service creates as a whole: one parent that serves, or one operation that is an update or a removal, and the whole request asks, and `amcp_write inspect`, which reads no state, still reports such a create as spend-affecting (read `execute_requirements` from prepare). A new keyword, ad group, asset group or ad may also start ENABLED under a parent the review reads as serving (the owner's decision of 2026-11-15): it then serves as soon as it is created, so it needs `spend_change_confirmed`, and an owner policy with `allow_activation: false` refuses it. A keyword with no status counts as ENABLED. A parent whose status the review could not read still refuses, with `parent_unread: true`: `PARENT_SERVING` for an ad group, asset group or ad, `TARGETING_PARENT_SERVING` for a keyword (read the parent's status, then prepare again). A new campaign always starts PAUSED. A paused build can therefore create everything under its paused campaign ENABLED, and enabling the campaign is the one reviewed activation. A plan of one-service steps (`atomic: false`) therefore runs under its approval alone, with no `spend_change_confirmed` at any step, while an all-or-nothing build still asks once. Negative campaign keywords use negative:true. A list of more than 25 operations (at most 1,000), such as 84 negative keywords, goes in one `amcp_write prepare` or one plan step: AMCP reviews it in parts of 25 and it is approved and executed once (`group: true`); execution stops at the first part that fails. Operations that use temporary IDs are not split. To rebuild a Search campaign, `amcp_campaign clone` with `source: {campaign_id}` reads it (budget, bidding, network settings, location, language and negative keyword criteria, ad groups, keywords, responsive search ads) into a draft plan under a new name, with `changes` applied; the copy starts PAUSED and its children keep their status. By default the copy is one all-or-nothing step (`build`); `atomic: false` keeps one step per resource type. To copy only part of the campaign, add `source.ad_group_ids` (1–1,000 numeric ad group IDs of that campaign) and `source.languages` (language constants it already targets, such as `languageConstants/1000`): only those ad groups, with their keywords and ads, and only those language criteria are copied (an ID or a language the campaign does not have is refused with `CLONE_SOURCE_NOT_FOUND`, and `details.missing` lists it), and `clone.ad_groups` maps each `adgroup_<n>` step, numbered in ID order, to its source ad group. **Customer lifecycle goals.** v25 has no lifecycle goal configuration; new customer acquisition, retention and loyalty retention are goals. `google_ads_v23_goal_mutate_goals` creates or updates a goal with exactly one settings block (`new_customer_acquisition_goal_settings`, `retention_goal_settings` or `loyalty_retention_goal_settings`, each `{value_settings: {value_multiplier, high_lifetime_value_multiplier, additional_value, additional_high_lifetime_value}}`); a customer has one goal of each type, so a second create is refused with `GOOGLE_GOAL_EXISTS` naming the existing one, and goals are never removed. A high lifetime value needs a value and must exceed it, and likewise for multipliers. `google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs` links a campaign to a goal (`campaign` and `goal` are immutable) with the settings block of the goal's type, updates it or removes the link; new customer acquisition with `target_option: TARGET_SPECIFIC` takes no override values. Updates name exactly the fields sent in `update_mask`. The review reads every goal of the customer and, for links, the campaigns and their existing links; every change needs `spend_change_confirmed` (it changes the values bidding optimizes for), removing a link counts as a deletion under an owner policy, and each result is read back. After reading, `GOOGLE_GOAL_NOT_FOUND` means the goal is not this customer's, `GOOGLE_GOAL_TYPE_MISMATCH` that the settings block is not for the goal's type, `GOOGLE_GOAL_CAMPAIGN_NOT_FOUND` that the campaign does not exist or was removed, `GOOGLE_GOAL_CONFIG_EXISTS` that the campaign is already linked to that goal (update the link instead), and `GOOGLE_GOAL_CONFIG_NOT_FOUND` that the link to update or remove does not exist; shapes Google documents as errors are refused with `INVALID_GOOGLE_LIFECYCLE_GOAL` before any read. **All-or-nothing builds.** `google_ads_v23_google_ads_mutate` with `{mutate_operations: [...], partial_failure: false}` is a reviewed write: up to 1,000 creates of campaign budgets, campaigns, campaign criteria, ad groups, ad group criteria and ad group ads (and, for Performance Max, text assets, an asset group, its asset links and signals: see [Performance Max builds](#performance-max-builds)) in one request, which Google applies completely or not at all (GoogleAdsService.Mutate with partialFailure false). A budget, campaign or ad group may carry a temporary `resource_name` (`customers/{id}/campaigns/-2`, each negative number used once) that later operations reference; a temporary name must be created before it is used. Each operation is checked as its own service would check it, existing parents are read, the campaign starts PAUSED and its children may start ENABLED under it, and every created resource is read back with the temporary names replaced by Google's. Updates, removals, other resource types, `partial_failure: true` and `validate_only` are refused with `INVALID_GOOGLE_BUILD`, naming the operation. A build Google refuses outright (HTTP 400, 401, 403, 404, 409, 412 or 422) created nothing, so in a plan it is amended with `recover_step` (the plan's `next_call`) and reviewed again under a new key; its old key is never sent again. A lost response, a timeout or an HTTP 5xx still stops the plan, as for every other write. Other campaign types, and bidding other than manual CPC, maximize conversions, maximize conversion value and maximize clicks, are refused with `CLONE_UNSUPPORTED`. Existing user lists/audiences can be targeted where the criterion supports them; creating arbitrary audiences/customer lists is separate. Shared exclusion-list members must match their enabled parent list type. Keep parent~criterion composite resource names intact. Use native decimal-string micros for bids and explicit field masks for mutable fields; criterion identity/parent/negative changes require remove/create. Targeting executions require spend_change_confirmed, except a negative-only create (every operation creates a campaign or ad-group criterion with negative:true, or a shared criterion in a negative list), which only narrows delivery, or a positive criterion created under a campaign or ad group the review reads as PAUSED. Any removal, update, other positive criterion, new shared list or list attachment still asks; under an owner policy with allow_activation:false, removing an exclusion or detaching a negative list counts as activation and is refused. Other catalog routes can compile locally but must not be described as reviewed-write support merely because their RPC exists. A GAQL 403 is an account/app permission problem; it is not repaired by changing field names at random.

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
type; `INVALID_ASSET_PARENT` requires an existing enabled or paused parent and, for the first custom
links of a retail asset group, a final URL on the group (see the Performance Max paragraph below);
`INVALID_ASSET_LINK` identifies an invalid role, identity or mutable field. Asset text,
URLs, selected parent configuration and existing links are snapshotted. Pagination or
missing prerequisite assets blocks preparation. Changed asset text or a concurrently
created association blocks execution with `STATE_CHANGED`. Delivery credentials on lead
forms are not retrieved or exposed by this link workflow.

Asset association execution requires `spend_change_confirmed: true`, including an omitted
create status: the link changes which creative may serve under the parent.

A Performance Max asset group is judged before anything is sent, so a link review is not spent on a refusal Google gives
at execute. The review reads the group's campaign (its channel, whether brand guidelines are on, whether a Merchant
Center account is linked), the group's final URLs and the group's live advertiser links, and counts the group as the
review would leave it: its links, less the review's removals, plus its creates (Google's automatically created links are
not the advertiser's and are not counted). Below a minimum the review is refused with `PMAX_ASSET_MINIMUMS` and
`{asset_group, counts, outside_range, source}`: `counts` shows each type that has a minimum capped at it (exact when
below it) plus this review's creates, and `outside_range` is exact; a missing marketing image says to upload a 1.91:1
image (1200 x 628 is recommended) and to link it as `MARKETING_IMAGE` in the same review. With brand guidelines on, the
business name and logos are campaign assets: their minimums are 0, and a create of a `BUSINESS_NAME`, `LOGO` or
`LANDSCAPE_LOGO` in the asset group is refused with `INVALID_ASSET_LINK` (Google:
`BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL`), because they link to the campaign with
`google_ads_v23_campaign_asset_mutate_campaign_assets`; removing one is allowed. With brand guidelines off it is the
other way round: a `LOGO` or `LANDSCAPE_LOGO` linked to the campaign itself of a Performance Max campaign is refused at
prepare with `INVALID_ASSET_LINK` (Google: `BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL`), naming the asset group
level. A retail group (a Merchant Center account is linked) that holds no advertiser link afterwards is accepted,
because Google generates the minimum set; a retail group with any link meets every minimum, and its first custom links
need a final URL on the group, or the review is refused with `INVALID_ASSET_PARENT` (set one first with
`google_ads_v23_asset_group_mutate_asset_groups`, an update with `update_mask: final_urls` that is a review of its own,
or create a new group with its final URL and all its links in one build). A review that only changes statuses is not
judged, and no maximum is checked here. A request of more than 25 links to one group is split into parts of 25 under one
approval: each part is an ordinary review, judged on the group as it stands when the parts are prepared. For a group
that already meets its minimums, a link one part adds does not change the review of the next; a group below one, like an
empty retail group, needs its missing assets in one review of at most 25 operations first, and the rest afterwards. An
image whose shape is far from its field type's ratio (`MARKETING_IMAGE` 1.91:1, `SQUARE_MARKETING_IMAGE` and `LOGO` 1:1,
`PORTRAIT_MARKETING_IMAGE` 4:5, `LANDSCAPE_LOGO` 4:1; a 2 percent tolerance, chosen wide because Google does not
document its own) is refused with `INVALID_ASSET_LINK` and `{operation, field, field_type, expected_ratio, width_pixels,
height_pixels}`. `TALL_PORTRAIT_MARKETING_IMAGE` links to an image at the asset group level; Google documents neither a
minimum nor a ratio for it, so none is checked. Every refusal here names its `operation` and `field`, as
`operations[7].create.fieldType`.

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

### Customer labels (removal only)

`google_ads_v23_customer_label_mutate_customer_labels` with `payload: {operations: [{remove:
"customers/{customer_id}/customerLabels/{label_id}"}]}` removes 1–100 labels from the selected
customer account, all or nothing (`partialFailure` omitted or false). The labels usually belong to
a manager: the review reads them with the connection's login customer for the account, and a label
it cannot see is refused with `STATE_NOT_FOUND` (`details.missing`). The labels themselves, and
other accounts carrying them, are unchanged; serving is not affected. Removal counts under owner
deletion policies; verification reads the customer labels again and expects each one gone.
Applying a label to a customer (`create`) stays refused with `WRITE_CONTRACT_UNAVAILABLE`: Google's
v25 reference marks both `CustomerLabel` fields output only and gives a create no resource name,
so the request cannot be stated unambiguously. `INVALID_CUSTOMER_LABEL_REMOVAL` names the payload
problem; `CUSTOMER_LABEL_STATE_UNVERIFIED` means the label read was incomplete or malformed.

## Audience signals

`google_ads_v23_audience_mutate_audiences` creates and updates customer-scoped `Audience`
resources. These are the audiences an asset-group signal (`assetGroupSignals` with
`audience.audience`) points to for Performance Max or Demand Gen. The service has no remove.

- **Create:**
  - `name` is required, unique in the account, and at most 255 characters.
  - `description` is optional.
  - `dimensions` is required: each entry sets exactly one of `age`, `gender`,
    `householdIncome`, `parentalStatus` or `audienceSegments`, and each type appears once.
  - `exclusionDimension.exclusions` may list user lists only.
- **Dimension values:**
  - Ages use `ageRanges` with `minAge` 18/25/35/45/55/65 and an optional larger `maxAge`
    24/34/44/54/64.
  - Genders, income ranges and parental statuses use their v23 enum values;
    `includeUndetermined` is a boolean.
  - Segments are `userList`, `userInterest.userInterestCategory`, `lifeEvent`,
    `detailedDemographic` or `customAudience`. Each is an existing resource name in the
    selected customer (`customers/{id}/userLists/{id}` and so on); discover them first.
- **Update:** mask only `name`, `description`, `dimensions` or `exclusionDimension`. An update
  may change the traffic of asset groups that already use the audience, so execution needs
  `spend_change_confirmed: true`. Creation affects nothing until a signal attaches it.
- **Not qualified:** `scope: ASSET_GROUP` and `assetGroup` (asset-group audiences cannot carry a
  name).
- **Refusals:** unknown fields and enums fail against the pinned Discovery schema
  (`INVALID_VENDOR_BODY`); other rule violations fail with `INVALID_GOOGLE_AUDIENCE`, before
  any request.
- **Verification:** reads `audience.dimensions` and `audience.exclusion_dimension` back as
  whole messages. Both sides are compared with dimensions, ranges, segments and exclusions
  sorted and false defaults dropped, so reordering by Google verifies and a changed value
  stays inconclusive.

## Performance Max retail listing groups

`google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters`
(and the `CREATE_ASSET_GROUP_LISTING_GROUP_FILTER` and `REMOVE_ASSET_GROUP_LISTING_GROUP_FILTER`
aliases) edits the product partition tree of one asset group of a Performance Max retail
campaign. Every such asset group needs a valid tree, or its ads do not serve; a single root
`UNIT_INCLUDED` node includes all products.

- **Operations:** `create` and `remove` only; type, asset group and listing source are
  immutable. Send `operations`, optionally `responseContentType: RESOURCE_NAME_ONLY`; one
  review edits the trees of up to 10 asset groups (a retail launch has several; two reads each
  at prepare and at execute, within the five-minute window), at most 500 operations in all. A
  tree is one chain linked by temporary names and is never split into parts.
- **Create:** `assetGroup`, `type` (`SUBDIVISION`, `UNIT_INCLUDED` or `UNIT_EXCLUDED`),
  `listingSource: SHOPPING` (left out, AMCP adds it, and the review's `request` shows it) and, except for the root, `parentListingGroupFilter` and `caseValue`
  with one of `productBrand`, `productCategory` (with `level`), `productChannel`,
  `productCondition`, `productCustomAttribute` (with `index`), `productItemId` or `productType`
  (with `level`). The "Other" node sets the dimension without a value, for example
  `productBrand: {}`. Name new subdivisions with a temporary
  `resourceName` (`customers/{id}/assetGroupListingGroupFilters/{assetGroupId}~-1`) so their
  children can reference them, and create parents before children.
- **Remove:** existing nodes, leaves first. To replace a tree, remove the old nodes (children
  before parents) and create the new tree in the same review.
- **Checks:** the campaign must be `PERFORMANCE_MAX` with a linked Merchant Center account and
  the asset group enabled or paused. AMCP reads the asset group, its campaign and the complete
  tree, applies the operations in order, and refuses an empty tree. The resulting tree must
  have one root that is not excluded; each subdivision needs at least one product group and
  exactly one "Other" node, all children on one dimension (and level or index) and no repeated
  value; units have no children. A dimension is used once on a path from the root, a product type or product category level
  above `LEVEL1` needs the level before it on its path, and the "Other" node of a level is not subdivided by the same hierarchy
  (`rule`: `ancestor_dimension`, `level_order`, `other_refined`): Google refuses these at execute, and AMCP at prepare. Webpage
  listing groups are not edited.
- **Safety:** execution needs `spend_change_confirmed: true`. Removals count as deletions under
  the owner's deletion policy. An enabled asset group of an enabled campaign serves at once and
  counts as serving under an activation-forbidding policy.
- **Refusals:** schema errors fail with `INVALID_VENDOR_BODY`; rule violations with
  `INVALID_LISTING_GROUP`; a missing node with `STATE_NOT_FOUND`, before any request. Each
  refusal's details name the `field` it is about, the `operation` where one is at fault, `allowed`
  where a closed list exists, and `rule` (the tree rule broken, one of a fixed list), and its remedy
  names the next call. Operations over a route's limit that name each other with temporary names are
  refused with `TEMP_ID_CHAIN_TOO_LONG`, never cut into parts. A
  response without a result for every operation stays a failure and is never resubmitted.
- **Verification:** reads the tree again and compares its shape (each node's dimension path
  and type) with the reviewed result, because Google assigns new IDs to created nodes.
  Reference: [Listing Groups for Retail](https://developers.google.com/google-ads/api/performance-max/listing-groups)
  and the v23 `asset_group_listing_group_filter` fields, checked 2026-09-26.

## Performance Max builds

A non-retail Performance Max asset group and the links to its minimum assets must reach Google in one mutate request, so
a new Performance Max campaign is one all-or-nothing build (`google_ads_v23_google_ads_mutate`, CMP-07): the budget, a
PAUSED `PERFORMANCE_MAX` campaign with `brand_guidelines_enabled: false` (the business name and logos then link to the
asset group), its criteria, text assets with temporary names (`asset_operation` with `text_asset: {text}` only), one
asset group with temporary name, `final_urls` of public HTTPS pages and status ENABLED or PAUSED under the paused
campaign (or under an existing PERFORMANCE_MAX campaign that is ENABLED or PAUSED, named by its
`customers/{id}/campaigns/{id}`), `asset_group_asset_operation` links (field types HEADLINE, LONG_HEADLINE, DESCRIPTION,
BUSINESS_NAME, MARKETING_IMAGE, SQUARE_MARKETING_IMAGE, PORTRAIT_MARKETING_IMAGE, TALL_PORTRAIT_MARKETING_IMAGE, LOGO,
LANDSCAPE_LOGO, YOUTUBE_VIDEO, CALL_TO_ACTION_SELECTION) and optional `asset_group_signal_operation` signals. Images,
logos and videos are existing assets of the account: upload them with `amcp_media` first and link their resource names.
Before any request the build must link, per asset group, 3–15 headlines (30 characters), 1–5 long headlines (90), 2–5
descriptions (90, at least one of them a short description of at most 60), one business name (25), 1–20 landscape and
1–20 square marketing images (20 images in all; a tall portrait image has no minimum and is not counted, because Google
documents neither) and 1–5 logos (with landscape logos, 5 in all); `PMAX_ASSET_MINIMUMS` names each field type outside
its range, the text that is too long, or an asset group without a short description. The review reads every linked
existing asset; `PMAX_ASSET_TYPE_MISMATCH` means one is not the image, video or text its field type needs. An asset
group under an existing PERFORMANCE_MAX campaign is judged with the campaign the review reads: with brand guidelines on,
the business name and logos are campaign assets, so their minimums drop to 0 and the group must link none of
`BUSINESS_NAME`, `LOGO` and `LANDSCAPE_LOGO` (a maximum of 0: Google links them to the campaign); a retail campaign (a
Merchant Center account is linked) accepts a group with no asset, because Google generates the minimum set, but a group
with any link must meet every minimum; any other campaign needs every minimum, as above. A campaign that is not
PERFORMANCE_MAX, ENABLED or PAUSED is refused with `INVALID_GOOGLE_BUILD` naming its channel. A new brand-guideline
campaign, links to an existing asset group and image creation are refused with `INVALID_GOOGLE_BUILD`: change an
existing asset group through its own asset-link or signal review. Every created resource is read back; the asset group
read also returns Google's `primary_status` and `ad_strength`, and `amcp_reporting serving_diagnostics` shows them with
their reasons. Image ratios, policy and duplicate-text rules stay with Google, whose refusal leaves nothing behind.
Activation of a new campaign is its own reviewed status change. An ENABLED asset group under an existing campaign that serves serves as soon as it is created, so it needs `spend_change_confirmed` and the owner's `allow_activation` switch refuses it (Q1); if the review cannot read that campaign's status, the group is refused.

The guided pack `google_performance_max` (`amcp_campaign recipes`; example `google_pmax_business`) compiles such a build
from a brief: budget, location and language criterion IDs, landing page, business name, 3–15 headlines, 1–5 long
headlines, 2–5 descriptions (one of at most 60 characters), the numeric IDs of existing landscape, square and logo image
assets, explicit `conversion_goal_policy: ACCOUNT_DEFAULT` (Maximize Conversions without a target, as the Search
conversion packs) and the EU political advertising declaration. `recipe_eligibility` with `live:true` reads the
account-default goals; the activation plan enables the campaign and is gated on them like the Search conversion packs.

## Product trees in a build

A build (`google_ads_v23_google_ads_mutate`) may create a product tree together with the asset group or ad group it belongs
to, so a retail campaign is built in one all-or-nothing request. Name each node after its new parent with a composite
temporary name:

- **Performance Max:** `asset_group_listing_group_filter_operation` creates named
  `customers/{id}/assetGroupListingGroupFilters/-{g}~-{n}`, `-{g}` being an asset group the build creates earlier; the
  campaign is `PERFORMANCE_MAX` with a Merchant Center account.
- **Standard Shopping:** `ad_group_criterion_operation` creates that carry `listing_group`, named
  `customers/{id}/adGroupCriteria/-{ag}~-{n}`, `-{ag}` being an ad group the build creates earlier with
  `type: SHOPPING_PRODUCT_ADS` under a `SHOPPING` campaign with `shopping_setting.merchant_id` (the campaign's own create, or
  the existing campaign AMCP reads). Keywords and every other criterion keep the old rule: no temporary name.

Each `-{n}` is a number no other temporary name of the build uses; a node's `parent_listing_group_filter` (or
`listing_group.parent_ad_group_criterion`) names an earlier node of its own tree, and every subdivision is named so that its
children can. The build holds the whole tree of each new asset group or ad group. AMCP checks it as the one-service review
does, with the same rules and codes (`INVALID_LISTING_GROUP` or `INVALID_SHOPPING_LISTING_GROUP`, whose details carry the
`rule`, the `operation` and the `field` in the build's own spelling), without state, reads back each tree with one read of the
whole tree compared by shape (no read per node), and shows `trees: [{asset_group or ad_group, nodes, final_tree}]` in the
impact. A unit's `cpc_bid_micros` meets the owner's bid cap as a keyword's does. A tree of an asset group or ad group that
exists is edited with its own review, never in a build (`INVALID_GOOGLE_BUILD` names the review). Google documents the
composite name only with an existing ID; a temporary parent inside the name is unverified until a live check, and if Google
refuses it, create the asset group or ad group in the build and add its tree with the one-service review on its ID.

Operations that name each other with temporary names are one chain: they are never split into parts. Over a route's limit
(25 for other writes, 500 for a product tree review, 1,000 for a build; AMCP's bounds, Google takes up to 10,000 mutate
operations per request) the refusal is `TEMP_ID_CHAIN_TOO_LONG`, which names a build and a plan whose later steps name
earlier results with `$ref` as the ways forward. A tree review over 500 is told to send a smaller edit instead, each review
leaving a complete tree: a build refuses the tree of an asset group or ad group that exists, and a plan cannot cut a tree into
steps.

## Standard Shopping product trees

`google_ads_v23_ad_group_criterion_mutate_ad_group_criteria` is a tree review when at least one operation creates a
`listing_group`: it edits the product tree of one `SHOPPING_PRODUCT_ADS` ad group of a `SHOPPING` campaign with a Merchant
Center account (the ad group enabled or paused). Google requires the whole tree in one request: one root; every subdivision
partitioned along one dimension with an "Other" node and at least one product group; units as leaves.

- **Operations:** up to 500 `create` and `remove`, one ad group per review. A create has `resource_name`
  (`customers/{id}/adGroupCriteria/{adGroupId}~-{n}`, required for a subdivision), `ad_group`, `listing_group`
  `{type: SUBDIVISION or UNIT, case_value, parent_ad_group_criterion}`, `negative` (a unit that excludes its products),
  `cpc_bid_micros` (on units only) and `status`, which is ENABLED or left out: Google does not keep a listing group's status, so a
  create that sends another one is refused at prepare (`rule: status_value`); pause the ad group to stop its products. The
  dimensions are `productBrand`, `productCategory`,
  `productChannel`, `productChannelExclusivity`, `productCondition`, `productCustomAttribute`, `productItemId` and
  `productType`. A keyword or another criterion beside the tree is refused: send it in its own review.
- **Replace a branch** in one review: remove the old nodes leaves first, then create the new ones, parents first. A request
  that only removes nodes, and a bid update of an existing unit (`update` with `cpc_bid_micros`), stay with the targeting
  review. A replacement (remove plus create) is not under the duplicate guard, as no tree edit that removes nodes is: it names
  existing node IDs, so a second copy is refused by them (`STATE_NOT_FOUND`); a tree of creates only keeps the guard.
- **Checks and safety:** AMCP reads the ad group with its campaign and the whole tree, leaving out any criterion that reads
  REMOVED (whether Google keeps a removed node as a REMOVED row is UNVERIFIED until the live check LV-15; a paged or foreign tree is
  refused), applies the operations in order and checks the tree they leave. Beyond the
  completeness rules, a dimension is used once on a path from the root, a product type or product category level above `LEVEL1`
  needs the level before it on its path, the "Other" node of a level is not subdivided by the same hierarchy, and a negative unit
  takes no bid (`rule`: `ancestor_dimension`, `level_order`, `other_refined`, `bid_on_excluded_unit`): Google refuses each of
  these at execute, and AMCP at prepare. Every tree change needs `spend_change_confirmed: true`; removals count as deletions and
  a change under an enabled ad group of an enabled campaign as an activation, under the owner's policies; a unit's bid meets
  the owner's bid cap. Not checked: the depth of a tree, and a positive unit without a bid under Manual CPC; Google refuses
  those at execute, atomically.
- **Verification:** the tree is read again and compared by shape: each node's dimension path and type, a unit's bid and exclusion,
  and a unit that Google lists with a status other than ENABLED. A subdivision's status and bid are not compared, because Google
  lists every subdivision PAUSED and a new subdivision may keep the bid of the unit whose ID it took.

A Shopping campaign create with `shopping_setting.enable_local: false` is refused at prepare (`INVALID_MUTATION`, details
`operation` and `field`), in a build too: Google refuses it when the campaign is created (`OPERATION_NOT_PERMITTED_FOR_CONTEXT`).
Leave `enable_local` out, or set it to `true`. The rule is applied to Shopping campaigns only.

A campaign `language` criterion on a Shopping campaign is refused at prepare as well (`INVALID_TARGETING_MUTATION`, details `operation`
and `field`), in a build and on `google_ads_v23_campaign_criterion_mutate_campaign_criteria` alike: Google refuses it
(`OPERATION_NOT_PERMITTED_FOR_CONTEXT`) and applies nothing. A build refuses it without a request when it creates the campaign, and
after reading the campaign's channel when the campaign exists. Leave the language out of a Shopping campaign; a Search campaign takes
its language criterion as before.

## Performance Max brand guidelines

`google_ads_v23_campaign_enable_p_max_brand_guidelines` (or the `ENABLE_PMAX_BRAND_GUIDELINES`
alias) enables brand guidelines on 1–10 existing Performance Max campaigns. Brand guidelines link
the business name and logos to the campaign instead of its asset groups and set the brand colors
and font of automatically generated assets. **They cannot be turned off again.** Campaigns with
travel goals do not support them, and Google has migrated many campaigns automatically since
2025, so check the campaign first.

Each operation has `campaign` and the required `autoPopulateBrandAssets`:

- `true`: Google chooses top-performing brand assets; send no `brandAssets`.
- `false`: send `brandAssets` with `businessNameAsset` (a text asset of 1–25 characters),
  `logoAsset` (square images, at least 128 x 128) and optional `landscapeLogoAsset` (4:1 images,
  at least 512 x 128); one to five logos in total, each asset once.
- Optional `mainColor` and `accentColor` together (hex such as `#00aa55`), `fontFamily` (Open
  Sans, Roboto, Roboto Slab, Montserrat, Poppins, Lato, Oswald or Playfair Display) and
  `finalUriDomain` (a domain without scheme or path).

AMCP reads the customer, each campaign (Performance Max, not removed, no travel goals, brand
guidelines not yet enabled: otherwise `CONFIGURATION_EXISTS`) and each asset (type, text length and
image size). Execution needs `spend_change_confirmed`: enabled campaigns serve with the new brand
assets at once. A result with an `enablementError` is a failure and is not resubmitted.
Verification reads each campaign again: brand guidelines enabled, the colors and font sent, and
enabled campaign links of every asset sent (or at least one business name and logo that Google
chose). `finalUriDomain` is sent but not read back. `INVALID_BRAND_GUIDELINES` names the field to
correct; `BRAND_GUIDELINES_STATE_UNVERIFIED` means the reads were incomplete.

Reference: [EnablePMaxBrandGuidelines](https://developers.google.com/google-ads/api/reference/rpc/v23/CampaignService/EnablePMaxBrandGuidelines)
and [Asset requirements](https://developers.google.com/google-ads/api/performance-max/asset-requirements),
checked 2026-09-27.

## Rule-based remarketing lists

`google_ads_v23_user_list_mutate_user_lists` (and aliases such as `CREATE_USER_LIST`) creates
and updates rule-based `UserList` resources: people whose Google tag hits match rules on
`url__`, `ref_url__` or custom tag parameters. A list collects visitors from creation on; it
is targeted only once a campaign or ad group criterion or an audience signal uses it.

- **Create:** `name` (unique in the account), optional `description`, `membershipStatus: OPEN`
  and `ruleBasedUserList.flexibleRuleUserList` with `inclusiveRuleOperator` (`AND` or `OR`),
  1-10 `inclusiveOperands` and up to 10 `exclusiveOperands` (people matching any exclusion are
  left out). Each operand has `lookbackWindowDays` (1-540) and a `rule` of 1-10
  `ruleItemGroups`, each of 1-10 `ruleItems` joined by AND; groups are joined by OR
  (`OR_OF_ANDS`, the only type flexible rules support). The 10-item bounds are AMCP's.
- **Rule items:** a `name` plus exactly one of `stringRuleItem` (CONTAINS, EQUALS, STARTS_WITH,
  ENDS_WITH and their NOT_ forms), `numberRuleItem` (EQUALS, NOT_EQUALS, GREATER_THAN,
  GREATER_THAN_OR_EQUAL, LESS_THAN, LESS_THAN_OR_EQUAL) or `dateRuleItem` (EQUALS, NOT_EQUALS,
  BEFORE, AFTER with `value` YYYY-MM-DD or `offsetInDays`, never both, because `value`
  overrides the offset). URL values cannot contain quotes, parentheses, tabs or newlines.
- `prepopulationStatus: REQUESTED` adds matching visitors from the last 30 days (Display
  Network only).
- **Update:** mask `name`, `description` or `membershipStatus` of an editable rule-based list.
  Closing a list (`CLOSED`) stops it collecting and it can no longer be targeted, so
  execution needs `spend_change_confirmed: true`.
- **Not qualified:** lookalike, logical and basic lists (Customer Match lists take people
  through the Data Manager API, below); `membershipLifeSpan`
  (ignored for rule-based lists, so it would do nothing); list removal; read-only (shared or
  external) lists.
- **Refusals:** wrong JSON types and unknown enums fail against the pinned Discovery schema
  (`INVALID_VENDOR_BODY`); other rule violations fail with `INVALID_GOOGLE_USER_LIST`, before
  any request.
- **Verification:** reads the list back, including the operands as whole messages. Both sides
  are compared with operands, groups and items as sets, 64-bit numbers as strings, the
  `OR_OF_ANDS` default filled and any prepopulation outcome counted as the request, so Google's
  own ordering verifies and a changed rule stays inconclusive.

## User list customer types

`google_ads_v23_user_list_customer_type_mutate_user_list_customer_types` attaches customer types
to user lists or removes them. A customer type says what a list holds (for example purchasers,
qualified leads or loyalty members); campaigns with a customer acquisition goal use these lists
to tell new customers from existing ones, which can change their bids. Types have no update:
attach and remove.

- 1–100 operations in one request, each `{create: {userList, customerTypeCategory}}` or
  `{remove: "customers/<customer>/userListCustomerTypes/<user list ID>~<category>"}`, each list
  and category once; lists of the selected customer only. `partialFailure` and `validateOnly`
  stay false.
- Categories: `ALL_CUSTOMERS`, `PURCHASERS`, `HIGH_VALUE_CUSTOMERS`, `DISENGAGED_CUSTOMERS`,
  `QUALIFIED_LEADS`, `CONVERTED_LEADS`, `PAID_SUBSCRIBERS`, `CART_ABANDONERS` and
  `LOYALTY_TIER_1_MEMBERS` to `LOYALTY_TIER_7_MEMBERS` (v25 dropped `LOYALTY_SIGN_UPS`).
- Google refuses conflicting types on one list: purchasers with converted leads, qualified leads
  or cart abandoners; qualified with converted leads; disengaged customers with converted leads,
  qualified leads or cart abandoners; and two different loyalty tiers. AMCP checks the types the
  list will have after the request, so a request can move a list from one tier to another.
- AMCP reads the customer (conversion tracking must be enabled and managed by this account, or by
  this manager), each list (CRM-based or rule-based to attach a type; a revoked share is refused)
  and the current types of each list. An existing type is `CONFIGURATION_EXISTS`; removing a type
  the list does not have is refused. Lists that the API cannot name (data-model and GCN lists read as
  `UNKNOWN`) are refused too.
- No spending confirmation is needed: budgets and list members do not change. A result that does
  not name every requested type is a failure and is not resubmitted.
- Verification reads the types of every list again and compares them with the types after the
  request. `INVALID_GOOGLE_CUSTOMER_TYPE` names the operation to correct;
  `CUSTOMER_TYPE_STATE_UNVERIFIED` means the reads were incomplete.

Reference: [UserListCustomerTypeService](https://developers.google.com/google-ads/api/reference/rpc/v23/UserListCustomerTypeService)
and the `UserListCustomerTypeError` values of the pinned Discovery document, checked 2026-09-27.

## Customer Match and offline conversions (Data Manager API)

The owner opened these on 2026-09-30. They go through Google's Data Manager API, not the Google
Ads API, and carry personal data, so they follow the personal-data rules in the workspace guide:
the owner's switch for the customer, `people` beside the request, confirmations for adding
people, and the owner executing each upload.

Before the first upload, the owner does four things outside AMCP. AMCP does none of them:

1. Enable the Data Manager API in the Google Cloud project of the OAuth client.
2. Add the `https://www.googleapis.com/auth/datamanager` scope to the project's data access.
   Google treats it as sensitive, so the app needs Google's OAuth verification.
3. Make sure Google's Customer Match terms are accepted for the Google Ads account. Each
   uploader confirms this with every upload.
4. Reconnect Google in AMCP, so the new permission is granted. Without it these writes fail
   with `INSUFFICIENT_SCOPE`.

- `DATA_MANAGER_INGEST_AUDIENCE_MEMBERS` with `payload: {user_list_id, consent}` and `people` adds
  up to 10,000 people to a Customer Match list. `DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS` with
  `payload: {user_list_id}` removes them. It takes no consent or confirmations, and an operator
  may run it.
- `consent` is `{ad_user_data, ad_personalization}`, each GRANTED or DENIED, taken from the
  consent the people gave. AMCP never assumes it (`PERSONAL_DATA_CONFIRMATION_REQUIRED`).
- **Google's terms.** Google's request carries a terms field, and Google requires it for every
  upload. AMCP sends it as accepted only because the uploader confirmed the terms
  (`platform_terms_confirmed`, needed for every upload). AMCP never sets it on its own.
- **Formatting.** Emails are lower-cased with all whitespace removed. For gmail.com and
  googlemail.com, the dots and any `+` suffix before the @ are also removed. Phones are E.164
  with the plus sign. Values already hashed must be 64-character hex.
- **Which list.** AMCP reads the list first through the Google Ads API. It must be a Customer
  Match list of the selected customer (CRM_BASED, contact information), not read-only, and
  open for additions. The customer must be a client account, not a manager
  (`STATE_TARGET_MISMATCH`, `INVALID_GOOGLE_DATA_MANAGER`).
- `DATA_MANAGER_INGEST_EVENTS` with `payload: {conversion_action_id, consent}` and `people` sends up
  to 2,000 offline click conversions. Each row is an object with the person's `EMAIL` and/or `PHONE`
  (as in `schema`) and the event:
  - `event_time`: Unix seconds, when the conversion happened.
  - At most one of `gclid`, `gbraid` or `wbraid`. A row needs a person or a click ID.
  - `value` with `currency` (ISO 4217); either needs the other.
  - `transaction_id`: optional, sent as it is, so it may not hold an e-mail address.
  - `event_source`: optional; one of WEB, IN_STORE, PHONE, MESSAGE or OTHER.
- **Conversion rules.** The conversion action must be an enabled UPLOAD_CLICKS action of the
  selected customer. An event older than 90 days, or in the future, stops the whole upload. The
  review shows the events in aggregate only, and says a conversion cannot be recalled once
  Google has received it.
- **Rehearsal.** `amcp_write inspect` of `DATA_MANAGER_INGEST_EVENTS` with `people` also returns
  `offline_upload_rehearsal`: a local dry run that applies the 90-day and future-time limits, builds
  the exact request and its `validateOnly: true` form, and reports only their hashes and counts.
  Nothing is sent, no review is created and it can never be executed. Sending Google's
  validate-only request would still transmit hashed people, so AMCP does not: under the owner's
  decision P4 such a rehearsal is reviewed like an execution, and no reviewed rehearsal path exists.
- **Verification** reads the request status. `pending` means Google is still processing, so
  verify again later. `verified` means Google reports success for every record sent. The
  result carries Google's error counts and, for lists, its match-rate range. It never reads
  the people back.

Call conversions stay blocked: Google needs the caller ID unhashed.

Reference: Google's Data Manager API reference (audienceMembers.ingest and remove, events.ingest,
requestStatus.retrieve, Destination), the formatting and consent guides, and the Google Ads
Customer Match guides, read 2026-09-30.

## Campaign drafts

A campaign draft copies a normal campaign into a draft campaign that cannot serve ads. Stage changes
there with the usual reviewed campaign, ad group and criterion requests, then promote the draft to
apply every staged change to the base campaign.

- `google_ads_v23_campaign_draft_mutate_campaign_drafts` (or `CREATE_CAMPAIGN_DRAFT`,
  `UPDATE_CAMPAIGN_DRAFT`, `REMOVE_CAMPAIGN_DRAFT`, each limited to its own operation) takes 1–10
  operations: `{create: {baseCampaign, name}}`, `{update: {resourceName, name}, updateMask: "name"}`
  or `{remove: "customers/<customer>/campaignDrafts/<base campaign ID>~<draft ID>"}`. Names have
  1–255 characters without NUL, line feed or carriage return, unique among the drafts of the
  campaign.
- `google_ads_v23_campaign_draft_promote_campaign_draft` (or `PROMOTE_CAMPAIGN_DRAFT`) with
  `path_params: {campaign_draft: "customers/<customer>/campaignDrafts/<base campaign ID>~<draft ID>"}`
  and an empty payload promotes a proposed draft.

AMCP reads the customer, each base campaign (not removed, and a normal BASE campaign, not a draft or
experiment) and every draft of those campaigns. A name already used is `CONFIGURATION_EXISTS`;
removed, promoting, promoted or failed drafts are not renamed or removed; a draft with a serving
experiment is not removed or promoted; only a PROPOSED draft is promoted. Creating, renaming and
removing drafts serve nothing, so they need no spending confirmation. Promotion needs
`spend_change_confirmed`, counts as activation under owner policies and runs asynchronously:
verification reads the draft until it is PROMOTED, stays open while it is PROMOTING and fails on
PROMOTE_FAILED (Google lists the reasons with ListCampaignDraftAsyncErrors).
`INVALID_GOOGLE_CAMPAIGN_DRAFT` names the operation to correct; `CAMPAIGN_DRAFT_STATE_UNVERIFIED`
means the reads were incomplete.

Reference: [Campaign drafts](https://developers.google.com/google-ads/api/docs/experiments/campaign-drafts)
and the pinned v23 `CampaignDraftService` document, checked 2026-09-27.

## Experiments

A system-managed experiment tests changes to a campaign against the campaign itself. It is set up in
two requests, serves nothing until it is scheduled, and finishes by being ended, promoted or
graduated.

- `google_ads_v23_experiment_mutate_experiments` (or `CREATE_EXPERIMENT`, `UPDATE_EXPERIMENT`,
  `REMOVE_EXPERIMENT`, each limited to its own operation) takes 1–10 operations. Create with
  `{name, type, suffix, status: "SETUP"}` and optional `description`, `startDate`, `endDate`
  (YYYY-MM-DD) and `syncEnabled`; `type` is `SEARCH_CUSTOM`, `DISPLAY_CUSTOM`, `YOUTUBE_CUSTOM` or
  `HOTEL_CUSTOM`, sync exists for search and display only, and Google appends the `suffix` to the
  names of the treatment campaigns. Updates name `name`, `description`, `suffix`, `startDate` or
  `endDate` in `updateMask`; removal takes `customers/<customer>/experiments/<ID>`.
- `google_ads_v23_experiment_arm_mutate_experiment_arms` (or `CREATE_EXPERIMENT_ARM`,
  `UPDATE_EXPERIMENT_ARM`, `REMOVE_EXPERIMENT_ARM`) creates all arms of one experiment in one
  request: `{experiment, name, control: true, trafficSplit, campaigns: [base campaign]}` and one or
  more treatment arms `{experiment, name, control: false, trafficSplit}`, splits 1–99 summing to
  100, at most 10 arms. Google creates an in-design campaign for each treatment arm; change it with
  ordinary campaign requests before scheduling. Arm updates name `name` and/or `trafficSplit`.

AMCP reads the customer, every experiment that is not removed (names are unique among them), the
arms of each experiment involved and the control campaign with its budget. Experiments and arms
change only while the experiment is in SETUP; status changes go through schedule, end, promote and
graduate. The control campaign is a normal (BASE) campaign of the experiment's channel (search,
display, video or hotel), not removed, with its own daily budget (not shared) and an EU political
advertising declaration. After arm updates or removals the experiment still has one control arm and
at least one treatment arm with distinct names and splits summing to 100, or no arms. Nothing
serves, so no spending confirmation is needed; removals count as deletions. Verification reads
every experiment and arm written. `INVALID_GOOGLE_EXPERIMENT` names the rule to correct;
`EXPERIMENT_STATE_UNVERIFIED` means the reads were incomplete.

Lifecycle actions name the experiment in `path_params`: `resource_name` for
`google_ads_v23_experiment_schedule_experiment` and `..._promote_experiment`, `experiment` for
`..._end_experiment` and `..._graduate_experiment` (or `SCHEDULE_EXPERIMENT`, `END_EXPERIMENT`,
`PROMOTE_EXPERIMENT`, `GRADUATE_EXPERIMENT`).

- Schedule an experiment in SETUP whose arms are complete and whose treatment arms have in-design
  campaigns. It needs `spend_change_confirmed` and counts as activation; it runs asynchronously
  (INITIATED, then ENABLED) and verification waits for ENABLED.
- End a running (ENABLED) experiment that has not ended: its end date becomes today in the customer
  time zone and its experiment campaigns stop serving. No confirmation is needed.
- Promote an ENABLED or HALTED experiment that is not already promoted: the treatment changes are
  applied to the base campaign asynchronously. It needs `spend_change_confirmed`, and verification
  waits for `promote_status` COMPLETED (or COMPLETED_WITH_WARNING).
- Graduate an ENABLED or HALTED experiment with `payload: {campaignBudgetMappings:
  [{experimentCampaign, campaignBudget}]}`: the campaign of a treatment arm keeps serving on its own
  with a new enabled daily budget that is neither shared nor used by another campaign (create it
  first). It needs `spend_change_confirmed`; verification reads GRADUATED and the budget on the
  campaign.

Failures of scheduling and promotion are listed by ListExperimentAsyncErrors; until the expected
state is read, verification is not verified and can be run again.

Reference: [System-managed experiments](https://developers.google.com/google-ads/api/docs/experiments/system-managed)
and the pinned v23 `ExperimentService` and `ExperimentArmService` document, checked 2026-09-27.

## Account settings

`google_ads_v23_customer_mutate_customer` takes `{operation: {update: {resourceName:
"customers/<customer>", ...}, updateMask}}` for the selected customer. The mask names
`autoTaggingEnabled`, `trackingUrlTemplate`, `finalUrlSuffix`, `descriptiveName`,
`videoBrandSafetySuitability` or `callReportingSetting` (whole, or `callReportingSetting.
callReportingEnabled`, `.callConversionReportingEnabled`, `.callConversionAction`); the time zone
and currency are immutable. A tracking template includes `{lpurl}` (or another landing-page tag)
and starts with `http(s)://` or a ValueTrack parameter; a final URL suffix is `key=value` pairs
joined by `&`; `""` clears either. `videoBrandSafetySuitability` is `LIMITED_INVENTORY`,
`STANDARD_INVENTORY` or `EXPANDED_INVENTORY`.

AMCP reads the customer's settings and, for `callConversionAction`, that conversion action (it must
be enabled). An unchanged request is refused. Any suitability change needs `spend_change_confirmed`;
a broader one counts as activation under owner policies. Turning auto-tagging off loses the gclid
for Google Analytics and offline conversion imports; the review says so. Verification reads the
settings again. `INVALID_GOOGLE_CUSTOMER_SETTING` names the field to correct;
`CUSTOMER_SETTING_STATE_UNVERIFIED` means the reads were incomplete.

## Automatically created assets

Google may create assets, such as headlines, for an ad or a campaign. Remove them with
`google_ads_v23_ad_group_ad_remove_automatically_created_assets` (`path_params: {ad_group_ad:
"customers/<customer>/adGroupAds/<ad group>~<ad>"}`, `payload: {assetsWithFieldType: [{asset,
assetFieldType}]}`) or
`google_ads_v23_automatically_created_asset_removal_remove_campaign_automatically_created_asset`
(`payload: {operations: [{campaign, asset, fieldType}], partialFailure: false}`), 1–50 each.

AMCP reads the ad or campaign and its automatically created asset links; an asset the advertiser
added, or one not linked, is `STATE_NOT_FOUND` (remove those with ordinary asset link requests).
Removals count as deletions under owner policies. A partial failure is a failure that is never
resubmitted. Verification reads the links again and expects the removed ones gone.
`INVALID_GOOGLE_AUTO_ASSET_REMOVAL` names the entry to correct; `AUTO_ASSET_STATE_UNVERIFIED` means
the reads were incomplete.

## YouTube video uploads

For videos uploaded through the API: `google_ads_v23_you_tube_video_upload_update_you_tube_video_upload`
(or `UPDATE_YOUTUBE_VIDEO_UPLOAD`) with `payload: {youTubeVideoUpload: {resourceName, videoPrivacy},
updateMask: "videoPrivacy"}` makes a brand channel video `PUBLIC` or `UNLISTED` (Google-managed
channel videos stay unlisted; titles and descriptions cannot change), and
`google_ads_v23_you_tube_video_upload_remove_you_tube_video_upload` (or
`REMOVE_YOUTUBE_VIDEO_UPLOAD`) with `payload: {resourceNames: [...]}` (1–20) deletes the videos.

AMCP reads each upload (state, channel, privacy) and the account's video assets that point at the
videos; the review names them, because their ads stop showing a deleted video. Privacy changes need
an uploaded video. Removal counts as a deletion. Verification reads the uploads again: the privacy,
or that the videos are gone. `INVALID_GOOGLE_YOUTUBE_UPLOAD` names the field to correct;
`YOUTUBE_UPLOAD_STATE_UNVERIFIED` means the reads were incomplete.

Reference: the pinned v23 `CustomerService`, `AdGroupAdService`,
`AutomaticallyCreatedAssetRemovalService` and `YouTubeVideoUploadService` document, checked
2026-09-27.

## Auto-apply recommendation subscriptions

`google_ads_v23_recommendation_subscription_mutate_recommendation_subscription` (or
`SUBSCRIBE_RECOMMENDATION` for creation, `UNSUBSCRIBE_RECOMMENDATION` to pause,
`UPDATE_RECOMMENDATION_SUBSCRIPTION`) takes 1–10 operations: `{create: {type, status}}` or
`{update: {resourceName: "customers/<customer>/recommendationSubscriptions/<TYPE>", status},
updateMask: "status"}`, with `status` ENABLED or PAUSED. The type (such as CAMPAIGN_BUDGET or
KEYWORD) cannot change and a subscription is paused rather than removed.

AMCP reads every subscription of the customer: a type already subscribed is `CONFIGURATION_EXISTS`
(update it instead), an unknown one `STATE_NOT_FOUND`, an unchanged status is refused. While a
subscription is ENABLED, Google applies its recommendations automatically, so enabling one needs
`spend_change_confirmed` and counts as activation under owner policies. Verification reads each
status again. `INVALID_GOOGLE_RECOMMENDATION_SUBSCRIPTION` names the operation to correct;
`SUBSCRIPTION_STATE_UNVERIFIED` means the read was incomplete.

## Smart campaign settings

`google_ads_v23_smart_campaign_setting_mutate_smart_campaign_settings` takes 1–10 operations
`{update: {resourceName: "customers/<customer>/smartCampaignSettings/<campaign>", ...}, updateMask}`
naming `phoneNumber` (or `phoneNumber.phoneNumber`, `phoneNumber.countryCode`), `finalUrl` or
`adOptimizedBusinessProfileSetting` (one landing page, not both), `advertisingLanguageCode`, and
`businessName` or `businessProfileLocation` (`locations/<id>`, not both).

AMCP reads each setting with its campaign, which must be a Smart campaign that is not removed; an
unchanged setting is refused. The change reaches the ads at once, so the review shows every field
from and to. Verification reads the settings again. `INVALID_GOOGLE_SMART_CAMPAIGN_SETTING` names
the field to correct; `SMART_CAMPAIGN_STATE_UNVERIFIED` means the read was incomplete.

Reference: the pinned v23 `RecommendationSubscriptionService` and `SmartCampaignSettingService`
document, checked 2026-09-27.

## Conversion value rules

`google_ads_v23_conversion_value_rule_mutate_conversion_value_rules` creates, updates and removes
`ConversionValueRule` resources; `google_ads_v23_conversion_value_rule_set_mutate_conversion_value_rule_sets`
does the same for `ConversionValueRuleSet`. A rule changes reported conversion values, and so
value-based bidding, only while a set includes it; a set applies the first rule, in list order,
whose conditions match.

- **Rules:** `action` with `operation` ADD (a positive value) or MULTIPLY (0.5 to 10), and at most
  two of `audienceCondition` (user lists or user interests of the selected customer),
  `deviceCondition` (MOBILE, DESKTOP, TABLET) and `geoLocationCondition` (`geoTargetConstants`
  with `geoMatchType` ANY or LOCATION_OF_PRESENCE, optional exclusions with their match type).
  A rule without conditions is the default for impressions no other rule matches. `status` is
  ENABLED or PAUSED.
- **Rule sets:** `conversionValueRules` in evaluation order, `dimensions` (one or two of
  AUDIENCE, DEVICE, GEO_LOCATION; the first is the primary dimension) and `attachmentType`
  CUSTOMER or CAMPAIGN with the `campaign`. The review reads every included rule: each must
  exist, not be removed and use only conditions of the set's dimensions. Updates may change the
  rules and dimensions; a dimension change restates the rules so they are checked again.
- **Confirmation:** creating a rule changes nothing until a set includes it. Editing or removing a
  rule, and any rule set change, needs `spend_change_confirmed: true`.
- **Not qualified:** SET actions (allowlist-only or store-visit sets), itinerary conditions
  (allowlist-only), `conversionActionCategories` (store visits and sales) and NO_CONDITION sets.
- **Refusals:** wrong JSON types and unknown enums fail against the pinned Discovery schema
  (`INVALID_VENDOR_BODY`); other rule violations fail with `INVALID_GOOGLE_VALUE_RULE`, before any
  request. Google itself refuses a rule that is already in another active set.
- **Verification:** reads each rule or set back. Rule conditions compare as sets; a set's rule
  order and dimension order compare as sent, because they decide which rule applies.

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
The Ads Help page describes advance scheduling, while the API guide and v23 field
reference describe a past start with a past or future end. Local acceptance of a
future start does not resolve this documentation mismatch or prove API eligibility.
Do not promise advance scheduling through the API without qualified provider evidence.

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

## Applying keyword and campaign budget recommendations

`google_ads_v23_recommendation_apply_recommendation` (or `APPLY_RECOMMENDATION`) with
`payload: {operations: [{resourceName, keyword | campaignBudget}]}` applies 1–20 recommendations of
one type (Google requires one type when `partialFailure` is false, which it must be):

- A `KEYWORD` recommendation adds its keyword; `keyword: {matchType, adGroup, cpcBidMicros}` chooses
  another match type (EXACT, PHRASE or BROAD), ad group or CPC bid.
- A `CAMPAIGN_BUDGET` recommendation sets the budget to the recommended amount, or to
  `campaignBudget: {newBudgetAmountMicros}`.

Other recommendation types change bidding strategies, assets or campaign types and stay outside this
contract; dismiss them or change the resource through its own review. AMCP reads each recommendation
(current, not dismissed, of the customer), its campaign budget or ad group, and the keywords of the
ad group: a keyword already there with that match type is `CONFIGURATION_EXISTS`, and a budget that
already has the amount is refused. Every application needs `spend_change_confirmed`; added keywords
count as activation under owner policies, and budget amounts follow owner budget limits. A reply
that does not name each recommendation is a failure never resubmitted. Verification reads the
budgets or the ad group keywords again. `INVALID_GOOGLE_RECOMMENDATION_APPLY` names the field to
correct.

Reference: the pinned v23 `RecommendationService.ApplyRecommendation` document, checked 2026-09-27.

## Client-account user access and invitations

Six actions now share the administrator-only user-access contract:
`CREATE_CUSTOMER_USER_ACCESS_INVITATION`, `REMOVE_CUSTOMER_USER_ACCESS_INVITATION`,
`UPDATE_CUSTOMER_USER_ACCESS`, `REMOVE_CUSTOMER_USER_ACCESS`, and the two RPCs
`google_ads_v23_customer_user_access_invitation_mutate_customer_user_access_invitation`
and `google_ads_v23_customer_user_access_mutate_customer_user_access`.
Select the exact Google Ads login and client account. Ask for the recipient and
intended role; never infer permission changes from an advertising campaign brief.
Discover native user/invitation resource names before changing or removing them.

The native body contains one `operation`, with one create, update or remove.
It has no `operations` array, `partialFailure`, `validateOnly` or response override.
Invitation create takes `emailAddress` and `accessRole`. Existing user update takes
`resourceName`, `accessRole` and the exact `updateMask: "accessRole"`. Removal takes
the full native resource string. Roles are ADMIN, STANDARD, READ_ONLY and EMAIL_ONLY;
Google enforces eligibility. User email is output-only; invitations are immutable.
The machine-checked examples show both RPC and friendly legacy payload forms.

A current AMCP administrator, selected-account write grant and adwords scope are
required. `ADMIN_REQUIRED` also refuses reviewer test accounts for these external
permission changes. The local administrator role does not establish Google admin
authority. Domain restrictions, provider approval, scope and native role are
separate prerequisites. Google sign-in, Analytics and Sheets scopes do not grant
Google Ads administration. Owner activation controls cover new/increased access;
owner deletion controls cover removal/demotion. No advertising budget changes.

Prepare reads the customer, complete direct memberships and all invitations twice.
Snapshots compare native identities, roles, email, invitation state and pending
multi-party authorization, excluding request telemetry and creation timestamps.
The limits are 1000 members and 1000 invitations, 25 pages per collection,
104 requests, 2 MiB per response, 8 MiB total and a 60-second monotonic deadline.
Paging, unknown responses, duplicates, partial counts and changing state fail closed.
Member/invitation ordering does not cause a conflict; real changes return
STATE_CHANGED with exact fields before submission. Current grants, actor and
scopes are checked around each read and at execution.

This contract covers client customers, not manager-wide access affecting
descendants. Removing or demoting the last direct administrator is blocked until
a separate contract verifies owner-manager recovery. Existing recipient/pending
invitation, no-op role change, nonpending revocation and another pending native
authorization review require inspection instead of resubmission. These are explicit
AMCP limits, not claims that every variant is forbidden by Google.

Inspect the exact recipient, previous/new role and effect; execute the frozen
review with its original key only after user authorization. An invitation sends
an email, not accepted account access. Read-back proves a newly observed PENDING
invitation; `access_granted` remains false. Google allows acceptance by a different
Google account email. A disappeared invitation or newly seen member cannot prove
acceptance. Never grant AMCP ownership from this receipt.

Native receipts can include `multiPartyAuthReview`. With an exact target resource,
AMCP retains it and reads back actual configuration. A still-pending change remains
inconclusive. A receipt with only a review ID and no target is retained as uncertain;
that variant and approval/rejection of native reviews need a separate contract.
Neither a receipt nor an HTTP 200 establishes that permission was applied.
Preserve the original review, idempotency claim and receipt after any uncertainty.
Retry `amcp_campaign verify` reads, never the mutation under a new key.

`INVALID_GOOGLE_ACCESS` explains a malformed/unqualified request or prerequisite.
`GOOGLE_ACCESS_STATE_UNVERIFIED` means a complete stable scoped baseline could not
be established. Resolve the named issue and prepare again only if nothing was
submitted; after submission reconcile the original result first. Removing the
acting Google user may also remove the ability to read back; do not mistake failed
verification for permission to retry the removal.

Official evidence checked 2026-09-20:
[v23 user fields](https://developers.google.com/google-ads/api/fields/v23/customer_user_access),
[v23 invitation fields](https://developers.google.com/google-ads/api/fields/v23/customer_user_access_invitation),
[native user service](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/customer_user_access_service.proto),
[native invitation service](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/customer_user_access_invitation_service.proto),
and [invitation sample](https://developers.google.com/google-ads/api/samples/invite-user-with-access-role).
Runtime contracts are pinned to the v25 Discovery document and nine source-hashed
official v25 protos in `google-user-access-v25.json` (rechecked 2026-09-28), reproduced
by `tools/google-access-evidence.mjs`. Local lifecycle, negative and restart tests
use synthetic accounts. No live invitation or permission change was performed.

## Client-owned portfolio bidding strategies

`CREATE_BIDDING_STRATEGY`, `UPDATE_BIDDING_STRATEGY`, `REMOVE_BIDDING_STRATEGY` and
`google_ads_v23_bidding_strategy_mutate_bidding_strategies` share one reviewed
contract. Select the exact client account and connection with the adwords scope
and an administrator account write grant. Social sign-in and Analytics scopes
do not authorize this workflow. Manager-owned/cross-customer portfolios and
aligned campaign budgets need separate authority/alignment contracts.

Ask for the business objective and explicit target/limits when missing. Discover
existing portfolios, account currency and campaign associations before selecting
a strategy. Do not infer a CPA, ROAS, tolerance or CPC ceiling from its name.
Create an unattached strategy, verify its returned native resource, then separately
review campaign assignment. A saved portfolio is not an activated campaign.

The six schemes are target CPA, target ROAS, maximize conversions, maximize
conversion value, target impression share and target spend (maximize clicks).
Choose one scheme; its type is immutable. Creating a different scheme and moving
campaigns is a separate sequence of reviewed changes. Enhanced CPC and the
deprecated `targetSpend.targetSpendMicros` field are not enabled. Native names
must be unique, trimmed and 1–255 UTF-8 bytes; a character count is insufficient.

Use exact decimal-string account-currency micros for CPA/CPC fields. For example,
`targetCpaMicros: "15000000"` means 15 currency units per acquisition, not a daily
budget. `targetRoas: 3` means a 300% ratio; native target ROAS accepts 0.01–1000.
Impression share uses 1–1,000,000 micros (`500000` is 50%) and needs a native
location and positive CPC ceiling. ROAS tolerance uses percent-millis (`10000`
is 10%); AMCP bounds it to 0–100% without claiming provider entitlement. Provider
eligibility and currency-specific minimum billable units still apply.

The native payload has 1–25 atomic `operations`, each with exactly one create,
update or remove. Updates require the full resource name and an exact leaf mask,
such as `targetCpa.cpcBidFloorMicros`. Supply every masked leaf and mask every
supplied leaf. Whole-scheme masks, wildcards, output fields and implicit clearing
are refused. Use explicit zero only for optional limits/targets; required CPA,
ROAS and impression-share targets cannot be cleared. Snake and camel spellings
map to the same native request, but cannot be supplied together.

Preparation and execution each read the complete affected portfolios, current
campaign membership, budgets and other campaigns sharing those budgets twice.
Native campaign counts must agree with discovered membership. Only names from
unrelated portfolios enter a name-changing review; their targets and query
telemetry do not. Identity maps make collection order irrelevant. No GAQL query
sorts by `resource_name`, which is not sortable in these v23 resources.
Meaningful target, status, budget or membership changes return `STATE_CHANGED`
with changed fields. `PORTFOLIO_STATE_UNVERIFIED` means a complete consistent
baseline could not be established; resolve that issue before preparing again.

Target/limit changes require `spend_change_confirmed: true` and obey the owner's
activation policy, including for currently paused campaigns. Rename-only changes
and unattached creation do not pretend to change spend. CPA/CPC values are not
compared with budget caps or charged to cumulative budget increases. Removal
obeys deletion policy and requires zero total campaign associations; even a
historical association remains a conservative AMCP limit pending qualification.

Inspect the frozen request and affected resources, execute using the original
review/key, and call `amcp_campaign` with `action: "verify"` and that review ID.
The receipt must contain the correct fresh/existing native resource for every
operation. Read-back checks saved configuration or complete active-collection
absence. It does not establish auction effects, target achievement or provider
approval. Partial, malformed or lost receipts retain their original claim. Never
submit a new key to recover an uncertain write; inspect the retained result first.

Local bounds: 1000 strategies, 25 pages per collection, 128 requests, 20,000 rows
across consistency reads, 4 MiB per response, 8 MiB total and a 60-second monotonic
deadline. Revoked grants, disconnect and login changes during reads stop progress.

Official evidence checked 2026-09-24: [v23 strategy fields](https://developers.google.com/google-ads/api/fields/v23/bidding_strategy),
[native mutation service](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/bidding_strategy_service.proto),
[native bidding fields](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/common/bidding.proto),
[immutable type and association errors](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/errors/bidding_strategy_error.proto),
and [current scheme contexts](https://developers.google.com/google-ads/api/docs/campaigns/bidding/strategy-types).
Seven public source hashes and extracted fields/enums are pinned in
`tests/fixtures/google-portfolio-v25.json` (the v25 protos, rechecked 2026-09-28: only the route version changed);
`tools/google-portfolio-evidence.mjs` regenerates it from explicitly supplied public source files. The machine-checked inspection
examples and synthetic lifecycle tests establish local behavior, not live acceptance.

## Shareable previews

`GENERATE_SHAREABLE_PREVIEWS` and
`google_ads_v23_shareable_preview_generate_shareable_previews` use a reviewed
v25 contract. These calls create shareable links, so use `amcp_write inspect`,
`prepare`, and confirmed `execute`. They require the selected Ads connection,
adwords scope, operator role, account write grant and enabled deployment writes.
They do not publish, activate or edit ads and do not require spend confirmation.
`amcp_ad_previews` with `platform: google_ads` names this call for you.

Supply 1–25 distinct previews in an operation, each naming its type:
`{"operation":{"shareablePreviews":[…]}}`. For a Performance Max asset group use
`{"assetGroup":"customers/123/assetGroups/7","previewType":"UI_PREVIEW"}`.
For an existing eligible YouTube video/audio ad use
`{"adGroupAd":"customers/123/adGroupAds/5~9","previewType":"YOUTUBE_LIVE_PREVIEW"}`.
The IDs here are synthetic examples; discover current IDs in the selected account.
Never substitute Search or Display ads: Google answers `UNSUPPORTED_AD_TYPE` for the
whole request. The v23 shape (`shareablePreviews` at the top, `assetGroupIdentifier`)
is refused, and the error's `version_change` shows the v25 one.

Ask before sharing the resulting link with another person. A preview link is a
private capability, not proof of provider approval. AMCP retains validated links
encrypted for at most 24 hours and hides them from ordinary receipts/audit.
`previews.results` contains the validated link(s), target, status and provider
expiration when supplied. An expiration with a zone is given in UTC as
`expiration_date_time`, with `expiration_known: true`. One with no zone names
no instant: `expiration_known` is false, `expiration_date_time` is null, and
`expiration_text` holds Google's text with `expiration_zone: "not_given"`. Show
it as "time zone not given"; it never marks the preview expired. Open previews
in a separate tab; Google forbids iframe embedding. AMCP does not fetch the
link or claim the creative rendered.
The accepted URL hosts are ads.google.com and, for YouTube mode, youtube.com,
www.youtube.com and tv.youtube.com. Unexpected hosts need contract review.

Preparation checks current source/parent identity, channel, status, names and
destination URLs twice. Provider telemetry and row ordering are excluded from
the state hash. The rendering can include inherited assets, feeds or later source
changes: this is a review to generate a preview, not a frozen-content approval.
For campaign/creative edits, prepare those operations separately.

Google answers for the whole request: one result per preview (`result.previews`,
each naming its asset group or ad and holding a UI or YouTube result), or an
error. A response that does not match the reviewed previews one to one is not a
success. Keep the original review/key. Repeating `execute` returns its saved
outcome and retained links without another generation. A lost provider response
stays uncertain; never manufacture a new key to retry it. Expired/unavailable
links are explicit and require a new user-authorized generation. `amcp_campaign
verify` checks the original receipt and current sources, without generating or
fetching another preview. Source disagreement is inconclusive, not permission to
repeat the operation.

Official evidence checked 2026-09-28:
[the v25 service](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/services/shareable_preview_service.proto)
and [the v25 request and result](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/actions/generate_shareable_previews.proto).
`tests/fixtures/google-preview-v25.json` and `tools/google-preview-evidence.mjs`
pin and check protocol fields, route, scope and oneofs. Local tests use synthetic
data; live format acceptance, link expiry/lifetime and rendering remain unverified.

## Conversion definitions

Use `google_ads_v23_conversion_action_mutate_conversion_actions` or its
`CREATE_CONVERSION_ACTION`, `UPDATE_CONVERSION_ACTION` and
`REMOVE_CONVERSION_ACTION` aliases through `amcp_write inspect → prepare →
execute`, then `amcp_campaign verify`. These actions configure definitions;
they do not upload conversion events or install tracking.

Supported manual types are `WEBPAGE`, `CLICK_TO_CALL`, `AD_CALL`, `WEBSITE_CALL`,
`UPLOAD_CLICKS` and `UPLOAD_CALLS`. Select a client using its own conversion
customer. Current App campaigns, manager-shared tracking and imported GA4/app/
system definitions need their separate dependency contracts. System and
former-manager observations may appear in discovery without granting ownership.

Creation requires explicit name, type, ENABLED status, category, primary versus
secondary choice, counting type, attribution model, windows and all three
`valueSettings` fields. `defaultValue: 12.5` means 12.5 units of
`defaultCurrencyCode`, never 12,500,000 micros. `alwaysUseDefaultValue` decides
whether event-provided values are overridden. Ask for these business decisions;
do not infer them from the campaign name. Data-driven attribution eligibility
remains a provider check.

A synthetic WEBPAGE example is maintained in `examples/contracts.json`.
Real names must be unique, including retained removed definitions. Local name
limit: 100 UTF-8 bytes. Input click windows are qualified at 1–30 days, or 1–60
for AD_CALL/WEBSITE_CALL; view windows are 1–30 days. Call-duration types require
an explicit 0–10000 second threshold and `alwaysUseDefaultValue: true`, and cannot
receive a view-through window. These are AMCP's qualified bounds; they do not
claim every provider/type-specific range is implemented.

For updates, supply only changed mutable fields plus the exact `resourceName`,
and a mask covering their leaves. For example, `valueSettings.defaultValue`
changes the value while preserving currency and override behavior. Snake-case
field names/masks also compile to native ProtoJSON. Type, app ID, owner,
`includeInConversionsMetric`, output snippets, wildcard masks, null clearing,
whole-object replacement and partial-failure execution are not qualified.

Preparation freezes the current definition history, goal graph, campaign
configuration, budgets and local portfolios. Query cost and collection order
do not alter the hash. Missing existing automatic goals, failed pages and
inconsistent reads stop preparation (`CONVERSION_ACTION_STATE_UNVERIFIED` or
`CONVERSION_GOAL_STATE_UNVERIFIED`). Fix the actual discovery/input problem;
never skip preflight or remove the comparison.

A primary action can affect existing campaigns immediately. Secondary actions
can still affect bidding when selected in custom goals. New category/origin
combinations cause Google to create standard goals; verification checks these
effects and preservation of existing goals. Business-setting changes and
creation require spend confirmation and obey activation policy. Rename-only
changes do not. Conversion value is not a campaign budget. Removal also obeys
deletion policy and requires prior detachment from every enabled custom goal.
A category update requires its destination goals to exist and be reviewed first.

Keep the original review/key after an unknown, partial or inconclusive result.
Do not repeat a mutation with a new key. Read-back establishes the saved
definition and goal effects, not event collection or historical recalculation.
Website actions still need authorized tag installation and testing. Call actions
may need call assets and forwarding-number setup. Offline click conversions are
sent through the Data Manager API (see "Customer Match and offline conversions"),
not the Google Ads upload services: the June 2026 offline-click upload restrictions
are not removed by creating an UPLOAD_CLICKS definition.

Native protocol evidence is pinned in `tests/fixtures/google-conversion-actions-v25.json`
(the v25 protos, rechecked 2026-09-28: v25 adds conversion types and a category, removes none), and the GAQL field
table (checked 2026-09-25 at v23) in `tests/fixtures/google-conversion-fields-v23.json`. Regenerate them with
`tools/google-conversion-evidence.mjs --source-dir <public-source-directory>` and
`tools/google-conversion-field-evidence.mjs <reference-text> <date>`. Neither uses credentials.

Sources: [v23 mutation service](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/services/conversion_action_service.proto),
[native definition fields](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v23/resources/conversion_action.proto),
[selectable v23 fields](https://developers.google.com/google-ads/api/fields/v23/conversion_action),
[definition validation](https://developers.google.com/google-ads/api/docs/conversions/getting-started),
[automatic customer goals](https://developers.google.com/google-ads/api/docs/conversions/goals/customer-goals),
[campaign goal defaults](https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals),
and [tracking types and offline restrictions](https://developers.google.com/google-ads/api/docs/conversions/categories).
Local synthetic tests are not live acceptance, upload authorization or tracking evidence.

## Customizer attribute availability

`UPDATE_CUSTOMIZER_ATTRIBUTE` is a historical alias with no Google Ads update
operation (v23 or v25). Inspect returns `PROVIDER_ACTION_UNSUPPORTED` with its official source;
additional confirmation cannot enable it. The native operation union supports
create and remove, even though its service comment and `update_mask` mention
updates. Existing `CREATE_CUSTOMIZER_ATTRIBUTE`, `REMOVE_CUSTOMIZER_ATTRIBUTE`
and the corresponding native RPC remain reviewed writes.

For a changed name/type, create a new attribute, then separately inspect and
review replacement associations and affected ads. Do not automatically delete
the old attribute or promise an atomic migration. Existing association values
have their own contracts. See the [v25 service definition](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/services/customizer_attribute_service.proto), checked 2026-09-28.

## Google Search recorded-value workflows

Discover `google_search_conversion_value` and `google_search_target_roas` through `amcp_campaign recipes`.
Use `recipe_context`, then supply the Search brief with explicit `conversion_goal_policy:"ACCOUNT_DEFAULT"`
and `conversion_value_policy:"ACCOUNT_RECORDED_VALUES"`. For the target workflow also supply decimal-text
`target_roas:"3.5"`: 3.5 means 350%, with an inclusive range 0.01–1000 and at most six fractional places.
The compiler preserves canonical declaration text and sends the native double; the ratio is not money/micros
or a guaranteed return. No target, goals or value configuration are inferred or edited.

Use `preview_recipe` for local intent, `recipe_eligibility live:true` for the existing bounded current
own-conversion-customer goals/primary actions, and `create_from_recipe` to save an unapproved paused draft.
Recorded values, history and provider/account eligibility need separate verification. Each of the six native
steps uses `prepare_next` and the returned original review ID in `execute_next`; dependent work waits for
exact read-back. Recovery is `amcp_campaign {action:"verify",review_id}`, never a new accepted mutation/key.
Activation is separate. An approved profile may supply explicit ratio text while form value/goal choices remain
deliberate. Shared/manager tracking and delivered values are not established by configuration inspection.

## Current primary-action value defaults

For either recorded-value Search recipe, `amcp_campaign recipe_eligibility` with `live:true` also inspects
the same matching primary actions' current `value_settings`: `default_value`, `default_currency_code`
and `always_use_default_value`. These native optional fields are selected on both complete collection passes.
Explicit zero/false remain known; omitted/null fields are unknown. The original conversion currency is retained
without converting it to billing currency. Full matching collections and unknown primary flags control
`conversion_value_configuration` readiness, including rows beyond the twenty displayed actions.

The website's Current conversion value settings table shows the original fields and override behavior.
Configured defaults do not prove received values, history, provider/account eligibility or actual return.
Shared/manager conversion customers stay unknown. This check saves nothing, edits no settings and reads no
event/person records. Readers may inspect it while native write blockers remain active. Reinspect current
settings and independently verify delivery before separate activation. Local and conversion-count checks retain
their original contracts.

## Last reported primary conversion activity

For the value recipes (`google_search_conversion_value` and `google_search_target_roas`), use the original live
recipe eligibility check to inspect the selected native last conversion date and last tag-detection time. The server
performs complete repeated own-client conversion-action
reads and joins exact IDs to enabled explicit primary actions matching biddable account-default goals. Current
authority/brief checks and original collection limits remain. Missing/null/empty/absent rows stay unknown;
the full-collection counters include undisplayed actions. Times retain the native account timezone. A detected
tag need not be an attributable conversion; dates do not establish delivered values, recent volume, consent,
deduplication, history requirements or bidding eligibility. No event-level data, events or mutations are used.
Save remains an unapproved paused draft; native review and activation are separate.

## Exact original-image links

Qualified Google image receipts expose complete bounded asset_usage through amcp_media. Select 1–1000 links;
the server refuses partial collections or native continuations and brackets two matching ad-asset-view reads
with exact original IMAGE/customer identity. Current account/adwords/source authority is required but no
upload write grant. App/Demand Gen/Responsive Search are the selected native view scope; other formats, video,
historical assignment, serving and reuse eligibility remain unknown. Explicit false links are removed, missing
flags/types unresolved. No provider mutation or persistent snapshot is created.

## Performance Max image asset-group associations

Original Google IMAGE receipt inspection exposes explicit reference_view performance_max through amcp_media
asset_usage. It retains exact original account/SHA/source authority and complete bracketed collections, under
the existing bound. Native group/campaign/image identity and PERFORMANCE_MAX mode must agree. Known enabled
and paused image links are current configurations; removed links are counted separately and missing roles or
statuses remain unknown. No ad identity, serving, policy approval, historical assignment or reuse eligibility
is inferred. Campaign-level brand-guideline logos and other associations remain outside this selected view.
The default ad_images query and Meta reference pages retain their previous scope.

### Original Performance Max campaign logo references

Choose `reference_view:"performance_max_brand"` on `amcp_media {action:"asset_usage",asset_id,limit:50}` for the
original IMAGE receipt's bounded current campaign-logo view. Literal enabled brand guidelines and exact
Performance Max campaign/image identity are required. LOGO/LANDSCAPE_LOGO link configuration, removed and
unknown links remain distinct. Campaign links are not ads or asset groups. The default ad view and explicit
asset-group view remain independent. Google handoffs retain the original asset, chosen view and bounded
limit; the website waits for an explicit read and clears view choices when another asset is opened. No
write grant, serving/performance/history or all-format absence is established. See [qualification](../../../docs/records/DELIVERY-2026-10-04-GOOGLE-PMAX-CAMPAIGN-LOGOS.md).

## Change history: what changed before a performance shift

Ask Google's own change log before guessing why results moved:
`amcp_workspace {action:"change_history", gateway:"google_ads_native_action", account_id, connection_id?,
requirements:{date_from, date_to, limit?, resource_types?}}`. Dates are account-local days, at most 30, starting no
earlier than 29 days before today (Google keeps change events for 30 days); `limit` is 1–10,000 (default 1,000) and
`resource_types` names 1–20 native types such as `CAMPAIGN` or `AD_GROUP_AD`. One fixed `change_event` projection
returns rows newest first with native resource type, operation, `client_type` (the tool used), changed field paths
and the resource, campaign, ad group or asset names, plus per-day, type, operation and tool counts. Who made a
change (`user_email`) is personal data and is never requested; old and new values are not requested either, so
read the current resource when the value matters. `limit_reached` means older changes in the window may exist:
read fewer days. A change near a shift is a lead to investigate with the user, not proof that it caused the shift.
Nothing is saved. The website shows the same read with a bilingual timeline under Live portfolio.

## Organic and paid search overlap

`amcp_workspace {action:"search_overlap", gateway:"google_ads_native_action", account_id, connection_id?,
requirements:{site_url, gsc_connection_id?, date_from, date_to, row_limit?, max_rows?, include_pages?}}` reads
Search Console queries (`dataState: final`, web search) for the exact property (`sc-domain:example.com` or a URL
prefix ending in `/`) and the customer's `search_term_view` for the same closed dates (at most 90, before today),
then joins them on normalized text (NFKC, lower case, collapsed spaces). Every match is
`approximate_normalized_text`: the products match queries differently, Search Console omits anonymized queries,
both report top rows (`top_rows_only`), their days use different time zones and final Search Console data trails
by two to three days (`recent_days_may_be_missing`; end the window earlier for a fair comparison). Rows are `both`,
`paid_only` or `organic_only` with exact paid micros and conversions and impression-weighted organic position.
`include_pages:true` also lists each organic query's top three landing pages (by-page metrics rank pages; they do
not add up to the query totals). `review_hint` marks rows worth discussing (`organic_strong_with_paid_spend`,
`paid_only_converting`); it is never an instruction to change bids, keywords or budgets. Act on a finding only
through the existing reviewed paths: exact negative keywords from a retained guided search-term report
(`amcp_reporting` `capture_preset` `google_search_terms` for the same dates, then `search_exclusion_candidates`,
`preview_search_exclusions` with the row's `search_term_views` as `ids`, and `create_search_exclusion_plan`; only
terms that qualify there can be excluded), new keywords through `amcp_write` with native review. When two Search
Console logins hold the property, choose `gsc_connection_id` and make it the property's default; an ambiguous
default is refused. Nothing is saved.

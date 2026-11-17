---
status: record
tier: engineering
---

# Google Performance Max retail listing groups — 2026-09-26

Base revision: `4b67890` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Performance Max campaigns and asset groups are reviewed writes. For retail campaigns,
Google's guide says every asset group needs a valid product partition tree of listing group
filters, and ads won't serve until it exists. The listing group routes were blocked, so a retail
Performance Max campaign could be built but not made to serve products.

Contract source, read in the rendered reference on 2026-09-26:

- [Listing Groups for Retail](https://developers.google.com/google-ads/api/performance-max/listing-groups)
  (updated 2026-09-23): one tree per asset group; subdivisions and units; each subdivision
  completely partitioned with an "Other" node; the retail dimensions; temporary negative IDs for
  nodes created in the same request; a subdivision is created with its children and "Other" node.
- Google's official Python example `add_performance_max_product_listing_group_tree.py`: temporary
  resource names `customers/{id}/assetGroupListingGroupFilters/{assetGroupId}~-N`, a `SHOPPING`
  listing source, parents before children, and removal in post-order (leaves first).
- The v23 field reference for `asset_group_listing_group_filter`, `asset_group` and `campaign`
  (pinned in `tests/fixtures/google-listing-group-fields-v23.json`): type and asset group are
  immutable; asset groups have `campaign` as an attributed resource.
- The pinned v23 Discovery document: the request has `operations`, `validateOnly` and
  `responseContentType` and no partial failure; a remove must be ordered and must not target a
  parent that still has children.

## Change

New reviewed family `google_listing_groups` (`src/google-listing-groups.ts`) for
`google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters` and the
`CREATE_ASSET_GROUP_LISTING_GROUP_FILTER` and `REMOVE_ASSET_GROUP_LISTING_GROUP_FILTER` aliases.

| Part | Behaviour |
|---|---|
| Request | `create` and `remove` only (type, asset group and listing source are immutable); one asset group; at most 500 operations; `SHOPPING` only; the seven retail dimensions, each with only its value and level or index; temporary negative resource names, required for subdivisions; no root case value; no `validateOnly`, query or header overrides |
| State | The asset group with its campaign (one GAQL query using the attributed campaign), then the complete tree; a paginated or foreign row is refused |
| Checks | Performance Max with a Merchant Center link; asset group enabled or paused; operations applied in order: removed nodes exist and have no remaining children, created nodes do not duplicate, parents exist and are subdivisions. The final tree is not empty and has one root, not excluded. Each subdivision has at least one product group and exactly one "Other" node, one dimension (with level or index), no repeated value; units have no children; no webpage listing groups |
| Safety | `spend_change_confirmed` is required; removals count as deletions under owner policy; an enabled asset group of an enabled campaign counts as serving under an activation-forbidding policy |
| Receipt | One result per operation: removals echo their names, creates return real (positive) IDs in the asset group; otherwise the receipt is a failure and is never resubmitted |
| Verification | The tree is read again and compared by shape (each node's dimension path and type), since created nodes get new IDs |

Review state is a stable projection: the asset group and campaign, and the tree's nodes sorted
by name. Frozen states are normalized again at execution, so the projection accepts its own output.

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`,
`src/reviewed-routes.ts`, `src/types.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (Google contract version 19). Guidance: "Performance Max retail
listing groups" in `Skills/amcp-campaign-builder/references/google-ads.md` and an executable
inspect example.

## Tests

`tests/google-listing-groups.test.ts`, eight tests:

1. An "all products" root is replaced with the guide's example tree (new and used units, and an "Other" subdivision split by brand, with an excluded brand) in one review. The impact shows the resulting shape; execution needs spending confirmation, writes once, verifies by shape and replays.
2. The legacy create and remove aliases add a product group under an existing subdivision and remove another, each verified.
3. Removing a parent before its children, an empty final tree, a subdivision left without a product group, a second "Other" node, mixed dimensions, a repeated value in other case, a second root, a child of a unit, a child before its parent, an absent node, a campaign without a Merchant Center link and a tree with webpage listing groups are refused before any write.
4. Twelve malformed requests (webpage source, update, `validateOnly`, two asset groups, an unnamed subdivision, a positive temporary name, a root case value, a child without a case value, an unknown dimension, another customer, an output-only ID, 501 operations) fail with `INVALID_LISTING_GROUP` or `INVALID_VENDOR_BODY`, without network requests.
5. Owner policies: removals are refused when deletions are forbidden; with activation forbidden, a paused asset group is accepted and an enabled one in an enabled campaign is refused.
6. A receipt missing a result stays a failure, is replayed rather than resubmitted, and is not verified as success.
7. A paginated or foreign tree read is refused, and a tree changed after review stops execution with `STATE_CHANGED`.
8. The query fields are all selectable in the pinned v23 field reference, the asset group read uses the attributed campaign, and all three catalog actions are the new reviewed family.

Red/green: all eight fail against a build of `4b67890` (the route had no reviewed family,
`WRITE_CONTRACT_UNAVAILABLE`, and the module did not exist) and pass with this change. Local
log: `.runtime/google-listing-groups-20260926/red-check.log`.

## Verification

- Targeted: 116 related suites (including every Google suite), 1,433/1,433.
- Guidance coverage: 254 write-path refusals across 134 modules accounted for.
- Full qualification: see
  [GOOGLE-LISTING-GROUPS-VERIFICATION-2026-09-26.json](GOOGLE-LISTING-GROUPS-VERIFICATION-2026-09-26.json).

Remaining rows: 920 (three Google Ads rows moved to the new family; Google Ads blocked writes
99 → 96). Live acceptance is unverified; it needs the updated deployment and a test account with
a paused Performance Max retail campaign linked to Merchant Center.

## Later changes (Round 2.5, M3, package `r25-m3-trees`)

The contract above is the 2026-09-26 one. These parts of it changed; the rest stands.

- **Asset groups per review (G4b).** One review edits the trees of up to ten asset groups (two reads each at prepare and at
  execute, within the five-minute window), still at most 500 operations in all. The state is `[group, tree]` for each
  group, sorted by ID; the impact keeps its keys for one group and adds `groups` for more; the uncertain-write lookup
  settles a review only when every group has the reviewed shape, or every group the shape it had before.
- **`listingSource` (G4a).** Left out, it is `SHOPPING` in the compiled request, which the review shows and the fingerprint
  covers; any other value is still refused.
- **One chain, never split (L2-06, G4c).** Operations that name each other with temporary names, `{assetGroupId}~-N`
  included, are never cut into parts. Over a route's limit (25 for other writes, 500 for a tree review, 1,000 for a build;
  AMCP's bounds, no raise of Google's 25 for independent operations, Q28) the refusal is `TEMP_ID_CHAIN_TOO_LONG`.
- **Trees in a build (L2-09, G5 route A).** A build creates a retail asset group with its tree, the filters named
  `-g~-n`, and a Standard Shopping ad group with its tree, the criteria named `-ag~-n`. The whole tree is checked without
  state by the same tree module and adapters, and read back with one read per tree. Whether Google accepts a temporary
  parent inside the name is unverified until a live check; one switch per form (`temporaryParentForms`,
  `src/google-temp-names.ts`) refuses it and names the two-phase route.
- **Standard Shopping trees (G5 route B).** `src/google-shopping-tree.ts` holds the node adapter and the review of the ad
  group criteria of one `SHOPPING_PRODUCT_ADS` ad group, served by this family as a second request shape (the route is the
  targeting family's in the action ledger, which requires every family to own a route). The shared tree module is
  `src/google-tree.ts`. A request that only removes nodes stays with the targeting family.
- **Details and remedies (L2-07).** Every refusal of these modules carries `field`, the `operation` where one is at fault,
  `allowed` where a closed list exists, and `rule`; `INVALID_LISTING_GROUP`, `INVALID_SHOPPING_LISTING_GROUP` and
  `TEMP_ID_CHAIN_TOO_LONG` have remedies that name the next call (`src/google-remedies.ts`).

Tests: `tests/google-tree.test.ts`, `tests/google-temp-names.test.mjs`, `tests/google-build-trees.test.mjs`,
`tests/google-shopping-tree.test.mjs`, `tests/google-refusal-details.test.mjs`, and the new cases of
`tests/google-listing-groups.test.ts` and `tests/google-write-reconciliation-trees.test.mjs`.

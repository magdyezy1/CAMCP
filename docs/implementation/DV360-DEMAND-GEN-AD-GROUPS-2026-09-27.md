# DV360 Demand Gen ad groups — 2026-09-27

Base revision: `ff9c443` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Demand Gen is the DV360 line item type whose ad groups, ads and ad group targeting the API
now writes. AMCP could create a Demand Gen line item through the entity family, but not the ad
groups below it, so no Demand Gen campaign could be built.

Contract source: the pinned Display & Video 360 API v4 Discovery document (`AdGroup`,
`adGroups.create`, `patch`, `delete`, `DemandGenBiddingStrategy`, `AdGroupInventoryControl`,
`TargetingExpansionConfig`, `ProductFeedData`) and Google's [Serve a Demand Gen ad](https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/overview)
guide (create line item, create ad group, activate resources), read on 2026-09-27. Key facts:

- Ad group writes are supported only for Demand Gen ad groups; the format and line item are
  immutable.
- The line item, the ad group and an ad must all be active to serve. Line items are created as
  drafts; ad groups and ads can be created active, but Google recommends paused.
- The line item sets the bid strategy type. An ad group may set only a value, for target CPA, CPC
  or ROAS, in micros of the advertiser currency (1000000 is one unit, or 100% ROAS).
- Inventory control is required for Demand Gen ad groups.

## Change

New reviewed family `dv360_demand_gen_ad_groups` (`src/dv360-demand-gen-ad-groups.ts`).

| Part | Behaviour |
|---|---|
| Request | Checked against the pinned `AdGroup` model and the Demand Gen rules: format, a numeric line item, display name up to 255 UTF-8 bytes, paused or active, one form of inventory control with at least one inventory, a bid value only, optimized targeting and product feed settings; no output-only fields |
| Patch | `updateMask` names distinct top-level writable fields and the body carries exactly those |
| State | A reader reads the advertiser (currency), the ad group and its line item, which must be a Demand Gen line item of the advertiser |
| Checks | Not archived; a bid value needs a target CPA, CPC or ROAS line item; the ad group must be Demand Gen; a patch must change something |
| Safety | An active status or a bid value needs `spend_change_confirmed`; the DV360 owner rule counts an active status as activation, and deletion is a deletion |
| Receipt | The ad group of the advertiser, in Demand Gen format, under the line item (create) or with the path ID (patch); an empty body for delete |
| Verification | Every setting the request sets, in one normalized form; a deleted ad group must be gone |

Other code: `src/write-review.ts` and `src/write-verification.ts` (the reader joins both read
chains), `src/write-impact.ts`, `src/review-state.ts`, `src/preflight.ts`,
`src/reviewed-routes.ts`, `src/types.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (DV360 contract version 6). Guidance: "Demand Gen ad groups" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect
example.

## Tests

`tests/dv360-demand-gen-ad-groups.test.mjs`, seven tests:

1. A paused ad group with a bid value needs spending confirmation, is created once and verifies, although DV360 returns every inventory flag and output-only bid fields; activation needs confirmation and verifies; a paused ad group without a bid value needs no confirmation.
2. A patch of the name, optimized targeting and product feed verifies, and a deletion verifies that the ad group is gone.
3. Fifteen malformed requests fail with `INVALID_DV360_AD_GROUP` without network requests.
4. Other line item types, archived line items, bid values on a maximize-conversions line item, a non-Demand Gen ad group and an unchanged patch are refused before any write.
5. Owner policies: an active ad group is an activation and a deletion is a deletion.
6. An ad group changed after review stops execution with `STATE_CHANGED`, and an ignored patch or deletion is inconclusive.
7. The model, methods, update mask and permission match the pinned Discovery document.

Red/green against a build of `ff9c443` (with the pinned document present): the six behaviour
tests fail and the pinned-document test passes; all pass with this change. Local log:
`.runtime/dv360-demand-gen-ad-groups-20260927/red-check.log`.

## Verification

- Targeted: 136 related suite files, including every DV360 suite, 1,639/1,639.
- Guidance coverage: 264 write-path refusals across 143 modules accounted for.
- Full qualification: see
  [DV360-DEMAND-GEN-AD-GROUPS-VERIFICATION-2026-09-27.json](DV360-DEMAND-GEN-AD-GROUPS-VERIFICATION-2026-09-27.json).

Remaining rows: 896 (three DV360 rows reviewed; DV360 blocked writes 56 → 53). Demand Gen ads,
ad assets and ad group targeting are the next DV360 steps. Live acceptance is unverified; it
needs the updated deployment and a DV360 advertiser with Demand Gen enabled.

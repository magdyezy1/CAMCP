---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ deletion — 2026-11-21

Package `r25-m4-smartdelete` (Round 2.5, milestone M4), the owner's O3 of 2026-11-20: "add delete function to AMCP".
No provider call, credential or deployment was made; every test fixture is synthetic.

## Contract source

TikTok API for Business v1.3, read on 2026-11-21 by the lead in a browser, read-only:

- "Update the operation statuses of Upgraded Smart+ Campaigns / Ad Groups / Ads":
  - https://business-api.tiktok.com/portal/docs/update-the-operation-statuses-of-upgraded-smart-campaigns/v1.3
  - https://business-api.tiktok.com/portal/docs/update-the-operation-statuses-of-upgraded-smart-ad-groups/v1.3
  - https://business-api.tiktok.com/portal/docs/update-the-operation-statuses-of-upgraded-smart-ads/v1.3
- "Get Upgraded Smart+ Campaigns / Ad Groups / Ads":
  - https://business-api.tiktok.com/portal/docs/get-upgraded-smart-campaigns/v1.3
  - https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ad-groups/v1.3
  - https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ads/v1.3
- The Enumerations appendix: https://business-api.tiktok.com/portal/docs/enumerations-appendix/v1.3

What the pages say, as this contract uses it:

1. **There is no Smart+ delete route.** A deletion is `operation_status: DELETE` on the three status routes, which
   take 1–20 IDs (the [2026-09-26 record](TIKTOK-SMART-PLUS-STATUS-2026-09-26.md)).
2. **The receipt.** Campaign answers list `campaign_list[].status`, ad group answers `adgroup_list[].status`, with
   failures in `error_list`; ad answers return `smart_plus_ad_ids` and one `status`. One value of that status enum is
   `DELETE`.
3. **The children of a deleted parent are not deleted themselves.** Ad groups of a deleted campaign, and ads of a
   deleted campaign or ad group, can no longer change status. Their secondary status is `ADGROUP_STATUS_CAMPAIGN_DELETE`,
   `AD_STATUS_CAMPAIGN_DELETE` or `AD_STATUS_ADGROUP_DELETE`.
4. **How a deleted row reads.** The gets take `filtering.primary_status`. The default, `STATUS_NOT_DELETE`, leaves
   deleted rows out, and `STATUS_ALL` includes them. A row's `operation_status` is `ENABLE` or `DISABLE` (and `FROZEN`
   for a terminated ad). A deleted row's own secondary status is `CAMPAIGN_STATUS_DELETE`, `ADGROUP_STATUS_DELETE` or
   `AD_STATUS_DELETE`. Other values end in `_DELETE` and say something else: the filter aggregates `*_STATUS_NOT_DELETE`,
   and the parent-deleted statuses above.
5. **Page sizes.** Campaign and ad group gets take `page_size` 1–1,000, the ad get 1–100; the ID filters take at most
   100 IDs. Ad rows carry `campaign_id` and `adgroup_id`.

## Contract

The DELETE bodies of the three status routes form the reviewed family `tiktok_smart_plus_deletions`
(`src/tiktok-smart-plus-deletions.ts`). `tiktok_smart_plus_status` keeps every other body.

| Stage | Behaviour |
|---|---|
| Validation | Before any request: the route's ID list (1–20 unique numeric IDs), `advertiser_id` and `operation_status` only, else `INVALID_TIKTOK_SMART_PLUS_DELETION` |
| Reads | The targets by ID; a campaign's ad groups and ads by `campaign_ids`, an ad group's ads by `adgroup_ids`; one page of 100, whose total must match, else `INCOMPLETE_STATE` |
| Checks, at prepare and execute | Every target is returned, none already reads deleted, and every child names a reviewed parent (`STATE_TARGET_MISMATCH`). Every target is paused (`DISABLE`, or `FROZEN` for an ad), else `TIKTOK_SMART_PLUS_DELETE_REQUIRES_PAUSE` with the `DISABLE` prepare as `next_call` |
| Policy | Destructive: `allow_deletion: false`, the owner's destructive tier and website approval apply; no spending confirmation |
| Impact | Each target, the children and the enabled ones, and the effect above (fact 3) |
| Receipt | Every ID with status `DELETE` and no error; anything less is a partial outcome that keeps its claim |
| Verification | One read per target with `STATUS_ALL`: its own `*_STATUS_DELETE` is the deletion; any other listed row is not. A target not listed there is deleted when the default read does not list it either |

Page size 100 everywhere: it is the ad get's maximum, and every Smart+ read in AMCP uses it.

A lost deletion stays uncertain. Reconcile has no read contract for a family with its own verification
(`src/write-reconciliation.ts` `namedTargets`), so it is settled by reading, as the classic DELETE is.

Not qualified: deleting an enabled target in one step, more than one page of children, undo, SKAN postback windows, and
the Smart+ creatives inside an ad.

## Tests

`tests/tiktok-smart-plus-deletions.test.mjs` (16 tests) and the conformance descriptor
`tests/family-descriptors/tiktok-smart-plus-deletions.mjs`. `tests/tiktok-smart-plus-status.test.mjs` pins that the
status family no longer claims a DELETE body.

## Unverified live

The receipt, the read-back shapes and the children's statuses are documented but not seen on a live advertiser. Live
check M4 LV-29 deletes M4's paused DNU objects on the TikTok test account, once deployed.

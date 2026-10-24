---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ campaign edits — 2026-09-26

Base revision: `ec0cddd` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Changing a Smart+ campaign's budget or name is
everyday campaign management; `/smart_plus/campaign/update/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Update an Upgraded Smart+ Campaign](https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-campaign/v1.3):
  `campaign_name`, `budget` (the fixed or initial campaign budget), `po_number`, and the
  allowlist-only `budget_auto_adjust_strategy`.
- [Create an Upgraded Smart+ Campaign](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-campaign/v1.3):
  the budget mode cannot be updated after creation; without campaign budget optimization the
  budget limits the total of the ad group budgets.
- [Get Upgraded Smart+ Campaigns](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-campaigns/v1.3):
  the current name, budget, budget mode and PO number.

## Contract

`tiktok_smart_plus_campaign_update` (and its alias `tiktok_smart_campaign_update`) is the new
reviewed family `tiktok_smart_plus_campaign_edits` (`src/tiktok-smart-plus-campaign-updates.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_CAMPAIGN_UPDATE` unless the request names the campaign and sets at least one of a documented name, a positive two-decimal budget and a PO number. Goal-based budget increase, status and other keys are refused |
| Reads | The campaign, before review and again before execution |
| Checks | The campaign must be returned (`STATE_TARGET_MISMATCH`); a budget edit needs a campaign that has a campaign budget (`BUDGET_MODE_INFINITE` campaigns are refused) |
| Spending | A budget edit is compared with the campaign's current budget under the owner spending policy and needs `spend_change_confirmed`; renames and PO numbers need neither |
| Impact | Before and after for each edited field, the budget mode, and what the budget means for the campaign (shared budget, limit, or initial budget under Goal-based increase) |
| Receipt | Existing TikTok rule for updates: `code: 0` |
| Verification | One campaign read comparing the edited fields |

Not qualified: Goal-based budget increase, and edits of Smart+ ad groups and ads.

## Why Smart+ ads are not next

Smart+ ad creation (`/smart_plus/ad/create/`, about 59 documented fields) depends on work that is
not qualified yet. TikTok no longer supports non-Spark ads on the TikTok placement, so ads there
must be Spark Ads with a TikTok account identity (`TT_USER` or `BC_AUTH_TT`) and either an
existing post (`tiktok_item_id`) or a pushed video. Website conversion Spark Ads on TikTok also
need a dynamic call-to-action portfolio (`call_to_action_id`) built from
`/creative/cta/recommend/`. The ad also carries TikTok-generated asset and automatic enhancement
switches whose defaults depend on allowlist status, which a contract should set explicitly. The
handoff lists these as the next Smart+ dependencies.

Other code: `src/write-review.ts`, `src/write-impact.ts`, `src/spend-policy.ts`,
`src/write-verification.ts`, `src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok
contract version 12), `src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ campaign
edits" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect
example.

## Tests

`tests/tiktok-smart-plus-campaign-updates.test.mjs`, six tests:

1. Both action names inspect as reviewed with no network.
2. 10 invalid requests, including Goal-based budget increase and status, are refused before any request.
3. A rename with a PO number needs no spending confirmation, changes once and verifies; replay makes no second request.
4. With a 50% increase cap, a 60% raise is refused and a 40% raise passes; the raise needs spending confirmation and verifies.
5. A campaign without a campaign budget is refused; a daily-limit campaign and a Goal-based campaign are explained; a missing campaign is refused.
6. A drifted read-back is inconclusive; a TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Changed test: `tests/tiktok-smart-plus-campaigns.test.mjs` asserted that Smart+ campaign updates
stay blocked. It now checks that Smart+ campaign copies (`/smart_plus/campaign/copy/task/create/`),
which are still blocked, inspect as unsupported.

Red/green: all six fail against a build of `ec0cddd` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-campaign-updates-20260926/red-check.log`.

## Verification

- Targeted: 1303/1303 across 95 related suites. The first run failed only the outdated
  campaign-update assertion above.
- Guidance coverage: 245 write-path refusals across 123 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-CAMPAIGN-EDITS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-CAMPAIGN-EDITS-VERIFICATION-2026-09-26.json).

Remaining rows: 946 (the route and its alias). Live acceptance is unverified; it needs the
updated deployment and a test advertiser with an Upgraded Smart+ campaign.

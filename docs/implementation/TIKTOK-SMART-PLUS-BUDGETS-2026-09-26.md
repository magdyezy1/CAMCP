---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ ad group budgets — 2026-09-26

Base revision: `d2d5eec` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Manual TikTok ad group budgets became a
reviewed family earlier today; Upgraded Smart+ ad groups have their own budget route,
`/smart_plus/adgroup/budget/update/`, which was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Update the budgets of Upgraded Smart+ Ad Groups](https://business-api.tiktok.com/portal/docs/update-the-budgets-of-upgraded-smart-ad-groups/v1.3):
  `budget` (up to 20 `{adgroup_id, budget}` entries, effective immediately) or
  `scheduled_budget` (allowlist-only, effective from 00:00 the next day); the response `data`
  is empty.
- [Get Upgraded Smart+ Ad Groups](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ad-groups/v1.3):
  `budget_mode` (`BUDGET_MODE_TOTAL` or `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`), `budget`, and
  `budget_auto_adjust_strategy` (`AUTO_BUDGET_INCREASE` makes `budget` the initial daily budget,
  which TikTok may raise by 20% up to 10 times a day and resets daily).

## Contract

`tiktok_smart_plus_adgroup_budget_update` is the new reviewed family `tiktok_smart_plus_budgets`
(`src/tiktok-smart-plus-budgets.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_BUDGET` unless there is exactly a `budget` list of 1–20 unique numeric ad group IDs with positive amounts of at most two decimals. `scheduled_budget` and other keys are refused |
| Reads | One `/smart_plus/adgroup/get/` for the listed ad groups, before review and again before execution |
| Checks | Each ad group must be returned (`STATE_TARGET_MISMATCH`) and have its own lifetime or dynamic daily budget (`INVALID_TIKTOK_SMART_PLUS_BUDGET` otherwise, as under campaign budget optimization) |
| Spending | Each new amount is compared with its own ad group's current `budget` under the owner spending policy; execution needs `spend_change_confirmed` |
| Impact | `creative_impact` lists each ad group's mode, current and new amount, and explains Goal-based budget increase where it applies |
| Receipt | Existing TikTok rule for updates: `code: 0` |
| Verification | One read per ad group comparing `budget` |

Not qualified: scheduled Smart+ budgets (allowlist-only) and campaign budgets.

Other code: `src/write-review.ts`, `src/write-impact.ts`, `src/spend-policy.ts`,
`src/write-verification.ts`, `src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok
contract version 9), `src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ ad group
budgets" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable
inspect example.

## Tests

`tests/tiktok-smart-plus-budgets.test.mjs`, six tests:

1. The route inspects as reviewed with no network.
2. Scheduled budgets and 10 other invalid requests are refused before any request.
3. Budgets for two ad groups show before and after, need spending confirmation, change once and verify; replay makes no second request.
4. Goal-based increase is explained; an ad group without its own budget and a missing one are refused before any write.
5. With a 50% increase cap, a large raise on one ad group is refused while a decrease plus a 40% raise passes.
6. A drifted read-back is inconclusive; a TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all six fail against a build of `d2d5eec` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-budgets-20260926/red-check.log`.

## Verification

- Targeted: 1285/1285 across 92 related suites.
- Guidance coverage: 242 write-path refusals across 119 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-BUDGETS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-BUDGETS-VERIFICATION-2026-09-26.json).

Remaining rows: 952. Live acceptance is unverified; it needs the updated deployment and an
advertiser with Upgraded Smart+ ad groups.

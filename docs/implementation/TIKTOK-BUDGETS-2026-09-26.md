---
status: record
tier: engineering
---

# TikTok ad group budgets — 2026-09-26

Base revision: `bbd3324` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Everyday TikTok campaign
management changes ad group budgets in bulk; `/adgroup/budget/update/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Update the budgets of manual ad groups](https://business-api.tiktok.com/portal/docs/update-the-budgets-of-ad-groups/v1.3). Either `budget` (lifetime budgets, immediate) or `scheduled_budget` (daily or dynamic daily budgets from 00:00 the next day in the account time zone), each at most 20 `{adgroup_id, …}` entries. The response `data` is empty. Budgets cannot change during the 23:55–00:00 lock.
- [Get ad groups](https://business-api.tiktok.com/portal/docs/get-ad-groups/v1.3). `budget_mode` (`BUDGET_MODE_INFINITE` under campaign budget optimization), `budget` (0 under campaign budget optimization), `scheduled_budget` (next-day value, 0 when unset) and `campaign_automation_type` (`MANUAL`, `SMART_PLUS`, `UPGRADED_SMART_PLUS`).

## Contract

`tiktok_adgroup_budget_update` and its alias `tiktok_adset_budget_update` form the new
reviewed family `tiktok_budgets` (`src/tiktok-budgets.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_BUDGET` unless there is exactly one of `budget` or `scheduled_budget`, 1–20 unique numeric ad group IDs, and positive amounts with at most two decimals, with no other keys |
| Reads | One `/adgroup/get/` for the listed ad groups, before review and again before execution |
| Checks | Each ad group must be returned (`STATE_TARGET_MISMATCH`) and manual, not under campaign budget optimization, and in the matching mode: `BUDGET_MODE_TOTAL` for `budget`, daily or dynamic daily for `scheduled_budget` (`INVALID_TIKTOK_BUDGET`) |
| Spending | Each new amount is compared with its own ad group's current `budget` under the owner spending policy (per-ad-group baselines, so several ad groups never make the baseline ambiguous). Execution needs `spend_change_confirmed` (existing budget rule) |
| Impact | `creative_impact` lists each ad group's mode, current and new amount, and when the change takes effect |
| Receipt | Existing TikTok rule for updates: `code: 0` |
| Verification | One `/adgroup/get/` per ad group, comparing `budget` or `scheduled_budget` with the sent amount |

Not qualified: Smart+ ad group budgets (`/smart_plus/adgroup/budget/update/`), campaign
budgets and scheduled budgets for campaigns.

Other code: `src/reviewed-routes.ts`, `src/write-review.ts`, `src/write-impact.ts`,
`src/spend-policy.ts`, `src/write-verification.ts`, `src/provider-contracts.ts` (TikTok
contract version 5), `src/action-contracts.ts`. Guidance: "TikTok ad group budgets" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect
example. Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (962 rows).

## Tests

`tests/tiktok-budgets.test.mjs`, eight tests:

1. The route inspects as reviewed with no network.
2. 13 invalid requests are refused before any request.
3. Two lifetime budgets: the impact shows before and after; execution without `spend_change_confirmed` is refused; with it there is one POST, two checks verify, and replay makes no second POST.
4. A scheduled daily budget verifies from `scheduled_budget` while today's `budget` stays unchanged.
5. A mismatched mode in each direction, campaign budget optimization, Smart+ and a missing ad group are refused.
6. With a 50% increase cap, doubling one ad group is refused, while a decrease on it plus a 40% raise on another passes.
7. A drifted read-back is inconclusive.
8. A TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all eight fail against a build of `bbd3324` (`WRITE_CONTRACT_UNAVAILABLE`) and
pass with this change. Local log: `.runtime/tiktok-budgets-20260926/red-check.log`.

## Verification

- Targeted: 1119/1119 across 83 related suites.
- Guidance coverage: 237 write-path refusals across 113 modules accounted for.
- Full qualification: see
  [TIKTOK-BUDGETS-VERIFICATION-2026-09-26.json](TIKTOK-BUDGETS-VERIFICATION-2026-09-26.json).

Live acceptance is unverified; it needs the updated deployment and a test advertiser.

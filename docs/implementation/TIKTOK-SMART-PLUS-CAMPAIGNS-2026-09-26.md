---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ campaigns — 2026-09-26

Base revision: `9371d74` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Upgraded Smart+ is TikTok's unified campaign
workflow; AMCP could pause, enable and budget existing Smart+ entities after the two previous
batches, but not create a Smart+ campaign. `/smart_plus/campaign/create/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create an Upgraded Smart+ Campaign](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-campaign/v1.3):
  a required 64-bit `request_id` that makes creation idempotent at TikTok, `operation_status`
  defaulting to `ENABLE`, objectives `APP_PROMOTION`, `WEB_CONVERSIONS` and `LEAD_GENERATION`,
  `sales_destination` required for website conversions, campaign budget optimization on by
  default with dynamic daily or lifetime budgets, `BUDGET_MODE_INFINITE`, `BUDGET_MODE_DAY` and
  `BUDGET_MODE_TOTAL` limits without it, allowlist-only Goal-based budget increase, search,
  promotional, mini series and RTA features, `special_industries` and `po_number`. The response
  returns the created campaign.
- [Get Upgraded Smart+ Campaigns](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-campaigns/v1.3):
  every created field, `operation_status` and `budget_optimize_on`.

## Contract

`tiktok_smart_plus_campaign_create` (and its alias `tiktok_smart_campaign_create`) is the new
reviewed family `tiktok_smart_plus_campaigns` (`src/tiktok-smart-plus-campaigns.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_CAMPAIGN` unless the request has a 64-bit `request_id`, `operation_status: DISABLE`, a website-conversion (`sales_destination: WEBSITE`) or lead-generation objective, a documented name, and a budget mode and amount valid for the campaign budget optimization setting. App, catalog, search, promotional, iOS dedicated, RTA and Goal-based budget increase settings, and other keys, are refused |
| Defaults | `budget_optimize_on` true and the documented default budget mode are applied, so review and verification compare the campaign TikTok creates |
| Reads | The advertiser, before review and again before execution |
| Spending | The campaign budget is a new budget under the owner spending policy (existing generic rules); execution needs `spend_change_confirmed`. A paused create is allowed under a policy that forbids activation |
| Impact | `creative_impact` lists the name, objective, budget settings with the account currency, industries, and what the budget means for the mode |
| Receipt | `code: 0` and a numeric `campaign_id` (the generic TikTok create rule looked for a `smart_plus_id`) |
| Verification | One `/smart_plus/campaign/get/` read comparing name, objective, destination, `DISABLE`, budget settings, industries as a set and PO number |

Not qualified: Smart+ ad groups and ads, campaign edits and copies, and the excluded campaign
types above.

Other code: `src/write-review.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok contract version 10),
`src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ campaigns" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-smart-plus-campaigns.test.mjs`, six tests:

1. The create route inspects as reviewed with no network; campaign updates stay blocked.
2. 26 invalid requests are refused with `INVALID_TIKTOK_SMART_PLUS_CAMPAIGN` before any request.
3. A paused campaign with a shared budget needs spending confirmation, is created once with the exact body and verifies although TikTok reorders industries and adds read-only fields; replay makes no second request.
4. A lead campaign without a campaign budget verifies; an owner budget cap refuses a larger campaign budget, and a paused campaign within the cap passes a policy that forbids activation.
5. Read-backs that are enabled, have another budget or other industries are inconclusive with the exact changed field.
6. A TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all six fail against a build of `9371d74` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-campaigns-20260926/red-check.log`.

## Verification

- Targeted: 1291/1291 across 93 related suites.
- Guidance coverage: 243 write-path refusals across 120 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-CAMPAIGNS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-CAMPAIGNS-VERIFICATION-2026-09-26.json).

Remaining rows: 950 (the route and its alias). Live acceptance is unverified; it needs the
updated deployment and a test advertiser.

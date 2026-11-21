---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ status — 2026-09-26

Base revision: `3967a83` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Upgraded Smart+ is TikTok's unified campaign
workflow, and pausing or enabling its campaigns, ad groups and ads is everyday campaign
management; the three `/smart_plus/*/status/update/` routes were blocked writes.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Upgraded Smart+ API reference](https://business-api.tiktok.com/portal/docs/upgraded-smart+-upgraded-smart+/v1.3)
  and its pages "Update the operation statuses of Upgraded Smart+ Campaigns / Ad Groups / Ads":
  1–20 IDs; `DISABLE`, `ENABLE` or `DELETE`; deleted entities cannot change status; campaign and
  ad group responses list per-ID successes (`campaign_list`, `adgroup_list`) and errors
  (`error_list`); ad responses return `smart_plus_ad_ids` and one `status`; SKAN 4.0
  `postback_window_mode` applies to Dedicated iOS campaigns only.
- "Get Upgraded Smart+ Campaigns / Ad Groups / Ads": ID filters of up to 100, `operation_status`
  (`ENABLE`, `DISABLE`, and `FROZEN` for terminated ads that cannot be enabled).

## Contract

The three status routes (and their `tiktok_smart_*` aliases) form the new reviewed family
`tiktok_smart_plus_status` (`src/tiktok-smart-plus-status.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_STATUS` unless the request has 1–20 unique numeric IDs in the route's ID field and `operation_status` `ENABLE` or `DISABLE`. `DELETE`, `postback_window_mode` and other keys are refused |
| Reads | The entities from the matching `/smart_plus/*/get/`, before review and again before execution |
| Checks | Every ID must be returned (`STATE_TARGET_MISMATCH`); a `FROZEN` ad is never enabled (`INVALID_TIKTOK_SMART_PLUS_STATUS`) |
| Spending | `ENABLE` needs `spend_change_confirmed` and is refused under an owner policy that forbids activation (existing rules); `DISABLE` needs neither |
| Impact | `creative_impact` lists each entity's name, current and requested status |
| Receipt | Every ID reported with the requested status and no errors; anything less is a partial outcome that keeps its claim |
| Verification | One get per entity comparing `operation_status` |

Not qualified: deletion, SKAN postback windows, and Smart+ creation, edits and budgets.

Since 2026-11-21, deletion is qualified as its own family, `tiktok_smart_plus_deletions` ([its record](TIKTOK-SMART-PLUS-DELETION-2026-11-21.md)). This family no longer claims a `DELETE` body, so the refusals of `DELETE` above, and in test 2 below, describe its contract of 2026-09-26.

Other code: `src/write-review.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok contract version 8),
`src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ status" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-smart-plus-status.test.mjs`, seven tests:

1. All three routes inspect as reviewed with no network.
2. Missing, excess, duplicate and non-numeric IDs, `DELETE`, an unknown status, a postback window and the wrong ID field are refused before any request.
3. Pausing two campaigns needs no spending confirmation, sends one request and verifies both; replay makes no second request.
4. Enabling ad groups needs spending confirmation and verifies; an owner policy that forbids activation refuses enabling at review and still allows pausing.
5. A frozen ad is never enabled, a missing campaign is refused, and an ad pause verifies from the ad receipt shape.
6. Campaign and ad receipts that omit an ID are not successes and are never resubmitted; a drifted read-back is inconclusive.
7. A TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all seven fail against a build of `3967a83` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-status-20260926/red-check.log`.

## Verification

- Targeted: 1279/1279 across 91 related suites.
- Guidance coverage: 241 write-path refusals across 118 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-STATUS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-STATUS-VERIFICATION-2026-09-26.json).

Remaining rows: 953 (the three routes and their three aliases). Live acceptance is
unverified; it needs the updated deployment and an advertiser with Upgraded Smart+ entities.

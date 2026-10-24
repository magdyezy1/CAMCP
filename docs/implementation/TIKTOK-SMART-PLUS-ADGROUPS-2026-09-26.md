---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ ad groups — 2026-09-26

Base revision: `3497651` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 handoff row "TikTok Upgraded Smart+ ad groups and ads" recorded with the Smart+
campaign batch. A paused Smart+ campaign needs ad groups before it can deliver;
`/smart_plus/adgroup/create/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create an Upgraded Smart+ Ad Group](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad-group/v1.3)
  (about 118 documented fields): required `request_id`, `operation_status` defaulting to
  `ENABLE`, `WEBSITE` promotion with `CONVERT`, a pixel and event, `OCPM` billing, maximum delivery
  or cost cap bidding, attribution windows set together, targeting modes (`AUTOMATIC` with or
  without audience suggestions, `MANUAL`) each with its own field list, and a note that targeting
  fields which do not match the mode are ignored without an error; ad group budgets ignored under campaign budget optimization, required
  otherwise, dynamic daily only under a campaign daily limit, lifetime budgets needing an end
  time, and `SCHEDULE_FROM_NOW` needing a dynamic daily budget; placements; `custom_conversion_id`
  eligibility.
- [Get Upgraded Smart+ Ad Groups](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ad-groups/v1.3):
  every created field, with `targeting_spec` returned with defaults added.

## Contract

`tiktok_smart_plus_adgroup_create` (and its alias `tiktok_smart_adset_create`) is the new reviewed
family `tiktok_smart_plus_adgroups` (`src/tiktok-smart-plus-adgroups.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_ADGROUP` unless the request is a paused website conversion ad group with the documented required fields, a bidding and billing combination, attribution windows set together, a targeting mode whose own field allowlist covers every targeting field sent (so nothing is silently ignored), 18+ age groups, a schedule, dayparting and placements in documented form. App, lead generation, catalog, search, value-based, deep funnel, zip code, Pangle package and allowlist-only settings are refused |
| Reads | The advertiser, the Smart+ campaign, the pixel, the custom conversion (if any) and referenced custom audiences, before review and again before execution |
| Checks | A website conversion campaign without catalog or search; no ad group budget under campaign budget optimization, a budget otherwise, dynamic daily under a daily limit, `SCHEDULE_FROM_NOW` only with a dynamic daily budget; a pixel that is not unbound (shared pixels are allowed and reported); an eligible custom conversion on the pixel with the same event; owned, available audiences |
| Spending | The ad group budget is a new budget under the owner spending policy (existing generic rules); execution needs `spend_change_confirmed` |
| Receipt | `code: 0` and a numeric `adgroup_id` |
| Verification | One `/smart_plus/adgroup/get/` read comparing every sent field with the targeting mode default applied; targeting lists, actions and placements as sets, price ranges by their endpoints |

Shared code: the targeting field checks, read-back projection and owned-audience check moved from
`src/tiktok-saved-audiences.ts` into `src/tiktok-targeting.ts`, which both families now use; the
saved audience tests pass unchanged.

Not qualified: Smart+ ads, ad group edits, and the refused ad group types and settings above.

Other code: `src/write-review.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok contract version 11),
`src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ ad groups" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-smart-plus-adgroups.test.mjs`, six tests:

1. The create route inspects as reviewed with no network; ad group updates stay blocked.
2. 27 invalid requests, including targeting fields that TikTok would silently ignore, are refused with `INVALID_TIKTOK_SMART_PLUS_ADGROUP` before any request.
3. An automatic-targeting ad group in a campaign-budget campaign reads its dependencies, needs spending confirmation, is created once with the exact body and verifies although TikTok adds targeting defaults and reorders lists; replay makes no second request.
4. A manual-targeting ad group with its own budget, cost cap, custom conversion, attribution windows, dayparting and selected placements verifies.
5. Campaign budget, daily limit, campaign type, missing campaign, unbound and missing pixels, waiting and mismatched custom conversions and shared audiences are refused before any write; a shared pixel is allowed and reported.
6. Enabled or re-targeted read-backs are inconclusive; a TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all six fail against a build of `3497651` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-adgroups-20260926/red-check.log`.

## Verification

- Targeted: 1297/1297 across 94 related suites, including the saved audience suite after the
  shared targeting move.
- Guidance coverage: 244 write-path refusals across 122 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-ADGROUPS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-ADGROUPS-VERIFICATION-2026-09-26.json).

Remaining rows: 948 (the route and its alias). Live acceptance is unverified; it needs the
updated deployment and a test advertiser with a Smart+ website conversion campaign and pixel.

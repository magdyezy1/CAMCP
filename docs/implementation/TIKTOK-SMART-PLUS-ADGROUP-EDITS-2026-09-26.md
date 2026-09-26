# TikTok Upgraded Smart+ ad group edits — 2026-09-26

Base revision: `53fb3ad` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P2 row "TikTok Upgraded Smart+ ad group edits" in the [2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md).
Renaming an ad group, moving its end date, limiting its hours or changing its bid is everyday
campaign management; `/smart_plus/adgroup/update/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Update an Upgraded Smart+ Ad Group](https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-ad-group/v1.3):
  incremental updates; `conversion_bid_price` for CONVERT, landing page view, install and in-app
  event goals and `bid_price` for CLICK, each under `BID_TYPE_CUSTOM` and below the budget; a
  bid change on one ad group changes the bid of every ad group in the campaign; end times before
  2038; dayparting as 336 half-hour flags.
- [Get Upgraded Smart+ Ad Groups](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ad-groups/v1.3):
  the current fields, filterable by ad group or campaign.

## Contract

`tiktok_smart_plus_adgroup_update` (and its alias `tiktok_smart_adset_update`) is the new
reviewed family `tiktok_smart_plus_adgroup_edits` (`src/tiktok-smart-plus-adgroup-updates.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_ADGROUP_UPDATE` unless the request names the ad group and edits at least one of the name, end time, dayparting, comment and share settings, and one bid field (positive, two decimals). Budgets, status, targeting and other keys are refused with the family to use instead |
| Reads | The ad group; for a bid edit, then the campaign's ad groups, once the ad group names its campaign. Before review and again before execution |
| Checks | A bid needs `BID_TYPE_CUSTOM` with a matching goal and stays below the ad group budget; an end time needs `SCHEDULE_START_END` and must be in the future and after the start |
| Impact | Each edited field before and after, and `campaign_bid_changes`: every other ad group whose bid moves with it |
| Spending | Bid, end time and dayparting edits need `spend_change_confirmed`; names and the comment and share settings do not |
| Receipt | Existing TikTok rule for updates: `code: 0` |
| Verification | One ad group read comparing the edited fields |

Not qualified: targeting edits (the documentation does not say whether a partial
`targeting_spec` replaces or merges), schedule start and type changes, search keywords, budgets
(the Smart+ ad group budget family) and status (the Smart+ status family).

Review state: the campaign read keeps each ad group's identity, goal, bid type and bids, so an
unrelated edit to a sibling does not stop the review. A review-envelope test found that the
first version read the query of reads that have none; the checks now test the path first.

Other code: `src/write-review.ts` (the follow-up campaign read), `src/review-state.ts`,
`src/preflight.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok contract version 16),
`src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ ad group edits" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-smart-plus-adgroup-updates.test.mjs`, seven tests:

1. Both action names inspect as reviewed with no network.
2. 12 invalid requests, including budget, targeting and status edits, an ISO end time, short dayparting, two bid fields and a three-decimal bid, are refused before any request, each on its own field; another advertiser is refused by the account scope check.
3. A rename and comment setting read only the ad group, need no spending confirmation, verify and replay without a second request.
4. A bid edit reads the campaign's ad groups, lists the sibling whose bid moves, needs spending confirmation, changes both as TikTok documents and verifies; an ad group alone in its campaign lists none.
5. An end time and dayparting edit needs spending confirmation and verifies; an end time on a continuous schedule or in the past is refused.
6. A bid on a no-bid ad group, a conversion bid on a click goal, a bid above the ad group budget and a missing ad group are refused before any write.
7. A drifted read-back is inconclusive; a TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Changed test: `tests/tiktok-smart-plus-adgroups.test.mjs` asserted that Smart+ ad group updates
stay blocked; it now checks that Smart+ ad material status updates, still blocked, inspect as
unsupported.

Red/green: all seven fail against a build of `53fb3ad` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-adgroup-updates-20260926/red-check.log`.

## Verification

- Targeted: 1329/1329 across 99 related suites. The first run failed the outdated ad group
  update assertion and the review-envelope snapshot test above; both were fixed.
- Guidance coverage: 248 write-path refusals across 127 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-ADGROUP-EDITS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-ADGROUP-EDITS-VERIFICATION-2026-09-26.json).

Remaining rows: 938 (the route and its alias). Live acceptance is unverified; it needs the
updated deployment and a test advertiser with a Smart+ campaign of two ad groups.

---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ creative status — 2026-09-26

Base revision: `533efac` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Pausing a weak creative inside a Smart+ ad, or
turning one back on, is everyday optimization; `/smart_plus/ad/material_status/update/` was a
blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Disable or enable creatives in an Upgraded Smart+ Ad](https://business-api.tiktok.com/portal/docs/disable-or-enable-creatives-in-an-upgraded-smart-ad/v1.3):
  `smart_plus_ad_id`, 1-20 `ad_material_ids` and `ENABLE` or `DISABLE`; carousel and
  non-carousel creatives cannot be mixed in one request; the receipt names the creatives
  operated on and their status.
- [Get Upgraded Smart+ Ads](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ads/v1.3):
  each explicitly selected creative's `ad_material_id` and `material_operation_status`;
  automatically added creatives are not returned.

## Contract

`tiktok_smart_plus_ad_material_status_update` is the new reviewed family
`tiktok_smart_plus_material_status` (`src/tiktok-smart-plus-material-status.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_MATERIAL_STATUS` unless the request names the ad, 1-20 distinct material IDs and `ENABLE` or `DISABLE`, with no other keys |
| Reads | The ad, before review and again before execution |
| Checks | Each ID is an explicitly selected creative of the ad (`STATE_TARGET_MISMATCH` otherwise, including automatically added creatives); no carousel and non-carousel mix; not a terminated ad |
| Impact | Each creative before and after, how many selected creatives stay on, and whether the ad is on |
| Spending | Enabling needs `spend_change_confirmed` and follows the owner's activation policy (generic TikTok activation rule) |
| Receipt | `code: 0` naming exactly the requested creatives, with the requested status when stated |
| Verification | One ad read comparing each creative's status (`material_statuses` in the Smart+ ad projection) |

Not qualified: automatically added creatives.

Other code: `src/tiktok-smart-plus-ads.ts` (the ad projection lists each creative's status),
`src/write-review.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok contract version 17),
`src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ creative status" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-smart-plus-material-status.test.mjs`, six tests:

1. The action inspects as reviewed with no network.
2. 6 invalid requests (no creatives, 21 creatives, a repeated creative, `DELETE`, no ad, another key) are refused before any request, each on its own field.
3. Pausing two creatives of an enabled ad lists each change, executes once, verifies each status and replays without a second request; pausing the last one on says so.
4. Enabling a creative needs spending confirmation and verifies; an owner policy that forbids activation refuses it.
5. A creative the ad does not list, a carousel with a video, a terminated ad and a missing ad are refused before any write.
6. A receipt missing a creative is not trusted and not resubmitted; a drifted read-back is inconclusive on that creative; a TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Changed test: `tests/tiktok-smart-plus-adgroups.test.mjs` used material status updates as its
still-blocked example; it now uses Smart+ ad appeals.

Red/green: all six fail against a build of `533efac` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-material-status-20260926/red-check.log`.

## Verification

- Targeted: 1335/1335 across 100 related suites. The first run failed only the outdated
  blocked-example assertion above.
- Guidance coverage: 249 write-path refusals across 128 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-CREATIVE-STATUS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-CREATIVE-STATUS-VERIFICATION-2026-09-26.json).

Remaining rows: 937 (the route has one action name). Live acceptance is unverified; it needs the
updated deployment and a test advertiser with a Smart+ ad of several creatives.

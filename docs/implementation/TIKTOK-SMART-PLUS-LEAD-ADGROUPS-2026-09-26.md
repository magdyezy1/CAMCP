---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ Instant Form lead generation ad groups — 2026-09-26

Base revision: `3bd855f` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Smart+ lead generation campaigns could be
created paused, but the reviewed ad group contract accepted website conversion ad groups only, so
a lead generation campaign could not get an ad group.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:
[Create an Upgraded Smart+ Lead Generation Campaign with Location as Instant Form](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-lead-generation-campaign-with-location-as-instant-form/v1.3)
and [Create an Upgraded Smart+ Ad Group](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad-group/v1.3).
An Instant Form ad group sets `promotion_type: LEAD_GENERATION`,
`promotion_target_type: INSTANT_PAGE` and `optimization_goal: LEAD_GENERATION`, bills with
OCPM, bids with maximum delivery or a target CPA that needs a daily budget, may select TikTok,
Pangle and Global App Bundle placements, and reads back with a form event and TikTok's own
attribution defaults.

## Change

`src/tiktok-smart-plus-adgroups.ts` gains an Instant Form lead generation mode beside website
conversions, in the existing `tiktok_smart_plus_adgroups` family:

| Stage | Behaviour |
|---|---|
| Validation | Lead mode needs the Instant Form target and goal; pixel, event, custom conversion and attribution fields are refused as website-only; website mode refuses `promotion_target_type`. Placements may include Global App Bundle in lead mode. Targeting, schedule, budget and bid rules are shared |
| Reads | The advertiser and the campaign (no pixel read), before review and again before execution |
| Checks | A lead generation campaign without catalog or search; campaign budget rules as before; a target CPA needs a dynamic daily budget on the campaign or ad group |
| Impact | The mode, "form submissions" as the optimization and no pixel |
| Verification | Unchanged: every sent field, targeting and placements as sets; TikTok's added form event and attribution defaults are not compared |

The action inventory does not change: the route was already reviewed. Lead generation ads
(Instant Form `page_list`) are the next step.

Other code: `src/provider-contracts.ts` (TikTok contract version 19), `src/action-contracts.ts`.
Guidance: an "Instant Form lead generation" part in the "TikTok Upgraded Smart+ ad groups"
section of `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable
inspect example.

## Tests

`tests/tiktok-smart-plus-lead-adgroups.test.mjs`, four tests:

1. An Instant Form ad group reads the advertiser and campaign but no pixel, needs spending confirmation, is created once and verifies although TikTok adds a form event, attribution and targeting defaults and reorders placements; replay makes no second request.
2. 7 lead requests with a missing or website target type, a conversion goal, a pixel, an event, attribution windows or an unknown placement, and a website ad group with a target type, are refused before any request, each on its own field.
3. A lead ad group in a website campaign, a target CPA under a lifetime campaign budget, an ad group budget under campaign budget optimization and a missing ad group budget are refused; an ad group budget without campaign budget optimization and maximum delivery under a lifetime budget are accepted.
4. A lost response is never resubmitted.

The website conversion suite (`tests/tiktok-smart-plus-adgroups.test.mjs`) passes unchanged.

Red/green: all four fail against a build of `3bd855f` (lead ad groups are refused) and pass with
this change. Local log: `.runtime/tiktok-smart-plus-lead-adgroups-20260926/red-check.log`.

## Verification

- Targeted: 1362/1362 across 107 related suites.
- Guidance coverage: 252 write-path refusals across 131 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-LEAD-ADGROUPS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-LEAD-ADGROUPS-VERIFICATION-2026-09-26.json).

Remaining rows: 929 (unchanged). Live acceptance is unverified; it needs the updated deployment
and a test advertiser with a Smart+ lead generation campaign.

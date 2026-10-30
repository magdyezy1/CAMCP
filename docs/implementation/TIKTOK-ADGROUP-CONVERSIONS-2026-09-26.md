---
status: record
tier: engineering
---

# TikTok ad groups that use a custom conversion — 2026-09-26

Base revision: `b4e1c25` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P2 follow-up "TikTok ad groups that use a custom conversion" recorded in the
[2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md) with the custom conversion batch. The
reviewed ad group create (`tiktok_entities`) passed `custom_conversion_id` through without
checking it, so a conversion on another pixel, with another event or without activity would
reach TikTok and fail there, or be used unchecked.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create an ad group](https://business-api.tiktok.com/portal/docs/create-an-ad-group-reference/v1.3):
  `custom_conversion_id` is valid only when a `pixel_id` (or app) is sent, a custom conversion is
  configured for it, `optimization_goal` is `CONVERT` (or `IN_APP_EVENT` for apps),
  `optimization_event` matches the conversion's standard event, and the conversion's status is
  `ACTIVE` or `NO_RECENT_ACTIVITY`.
- [Update an ad group](https://business-api.tiktok.com/portal/docs/update-an-ad-group/v1.3):
  `custom_conversion_id` appears only as a response field, not as a request parameter.
- [Get the details of a Custom Conversion](https://business-api.tiktok.com/portal/docs/get-the-details-of-a-custom-conversion/v1.3):
  the conversion's pixel, event and `activity_status`.

## Contract

This hardens the existing `tiktok_entities` family (`src/tiktok-adgroup-conversions.ts`); no
route changes status.

| Stage | Behaviour |
|---|---|
| Validation | An ad group create with `custom_conversion_id` needs a numeric ID, the numeric `pixel_id`, `optimization_goal: CONVERT` and an `optimization_event`; app sources are refused. An ad group update with `custom_conversion_id` is refused. All with `INVALID_TIKTOK_CUSTOM_CONVERSION`, before any request |
| Reads | `/custom_conversion/get/` for the conversion on the sent pixel, next to the existing advertiser and campaign reads, before review and again before execution |
| Review state | The conversion's ID, pixel, event and whether its status is eligible; moving between `ACTIVE` and `NO_RECENT_ACTIVITY` does not invalidate a review |
| Checks | The conversion must belong to the sent pixel, have the ad group's `optimization_event`, and be `ACTIVE` or `NO_RECENT_ACTIVITY` (`INVALID_TIKTOK_CUSTOM_CONVERSION`); an unknown conversion fails with TikTok's own error |
| Verification | Unchanged: the ad group read-back already compares `custom_conversion_id` with the sent value |

Ad groups without `custom_conversion_id` read nothing extra.

Other code: `src/write-review.ts`, `src/review-state.ts`, `src/action-contracts.ts` (test
listed under `tiktok_entities`). Guidance: the ad group bullet in "TikTok custom conversions"
in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md`.

## Tests

`tests/tiktok-adgroup-conversions.test.mjs`, five tests:

1. An ad group with an eligible conversion on its pixel reads it, is created once and verifies.
2. An ad group without a custom conversion reads nothing extra.
3. A missing pixel, an app source, a goal other than CONVERT, a non-numeric ID and an update that sets the field are refused before any request.
4. A mismatched event, a conversion on another pixel, one waiting for activity and an unknown one are refused before any write.
5. A status change between ACTIVE and NO_RECENT_ACTIVITY keeps the review valid; a conversion that falls back to WAITING_FOR_ACTIVITY stops execution.

Red/green: against a build of `b4e1c25`, tests 1, 3, 4 and 5 fail. The review never read the
conversion, accepted the undocumented request shapes and mismatched conversions for review,
and created the ad group after the conversion lost eligibility. Test 2 is a no-change guard
and passes before and after. All five pass with this change. Local log:
`.runtime/tiktok-adgroup-conversions-20260926/red-check.log`.

## Verification

- Targeted: 1265/1265 across 89 related suites.
- Guidance coverage: 239 write-path refusals across 116 modules accounted for.
- Full qualification: see
  [TIKTOK-ADGROUP-CONVERSIONS-VERIFICATION-2026-09-26.json](TIKTOK-ADGROUP-CONVERSIONS-VERIFICATION-2026-09-26.json).

Remaining rows are unchanged (960): this hardens an already reviewed action. Live acceptance
is unverified; it needs the updated deployment and an advertiser with an active custom
conversion.

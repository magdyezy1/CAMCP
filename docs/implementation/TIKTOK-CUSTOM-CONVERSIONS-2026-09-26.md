---
status: record
tier: engineering
---

# TikTok custom conversions — 2026-09-26

Base revision: `06cd154` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). A TikTok ad group can optimize for
a custom conversion (`custom_conversion_id` in `/adgroup/create/`), so an advertiser that
optimizes for a narrowed pixel event needs one first; `/custom_conversion/create/` was a
blocked write. Microsoft Learn and Google's developer site were unreachable from this
environment during this batch, so the batch was chosen among providers whose documentation
could be read.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create a Custom Conversion](https://business-api.tiktok.com/portal/docs/create-a-custom-conversion/v1.3):
  name rules (starts with a letter; letters, numbers, spaces, underscores, hyphens; at most
  50 characters; no emoji; not a standard event name; unique in the ad account), description
  of at most 500 characters, `PIXEL` or `APP` sources, the pixel `optimization_event` list,
  1–10 rules with per-parameter operators and value limits, the currency list, and limits of
  1,000 per ad account and 100 per pixel. The response returns `custom_conversion_id`.
- [Get the details of a Custom Conversion](https://business-api.tiktok.com/portal/docs/get-the-details-of-a-custom-conversion/v1.3):
  returns the definition plus `activity_status` and timestamps, but not `custom_event_type`.
- [Get Custom Conversions associated with an event source](https://business-api.tiktok.com/portal/docs/get-custom-conversions-associated-with-an-event-source/v1.3):
  one pixel's conversions, up to 1,000 per page.
- [Get pixels](https://business-api.tiktok.com/portal/docs/get-pixels/v1.3): a `pixel_id` filter,
  `asset_ownership` (`ownership_status`; `asset_relation_status` of `TRANSFERRED`, `SHARED` or
  `UNBOUND`), and pixel event data that TikTok refreshes every 2–4 hours.
- [Create an ad group](https://business-api.tiktok.com/portal/docs/create-an-ad-group-reference/v1.3):
  `custom_conversion_id` needs the matching `optimization_event` and an activity status of
  `ACTIVE` or `NO_RECENT_ACTIVITY`.

## Contract

`tiktok_custom_conversion_create` is the new reviewed family `tiktok_custom_conversions`
(`src/tiktok-custom-conversions.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_CUSTOM_CONVERSION` unless the request has a documented name and description, `event_source_type: PIXEL`, a numeric pixel ID, a documented pixel `optimization_event` and 1–10 unique rules whose operators and 1–100 unique string values fit their parameter. App sources, `custom_event_type` and other keys are refused |
| Reads | The pixel (`/pixel/list/` filtered by ID) and its custom conversions (`/custom_conversion/list/`, one page of up to 1,000), before review and again before execution |
| Checks | The pixel must be returned (`STATE_TARGET_MISMATCH`), owned by the advertiser (not `SHARED` or `UNBOUND`), below 100 custom conversions, and without a conversion of the same name (`INVALID_TIKTOK_CUSTOM_CONVERSION`) |
| Review state | Pixel identity and ownership, and each conversion's definition. Pixel event data and conversion activity counts are observations and do not invalidate a review |
| Spending | None. Custom conversion creation is excluded from the spending word heuristic, so rule values mentioning bids do not ask for confirmation |
| Impact | `creative_impact` lists the pixel, the event, a summary of each rule and the pixel's conversion count against the limit, and states when an ad group can use the conversion |
| Receipt | Existing TikTok rule for creates: `code: 0` and a `custom_conversion_id` |
| Verification | One `/custom_conversion/get/` read comparing name, description, event, pixel and rules, with rules treated as a set (rule order, value order and number formatting ignored) |

Not qualified: app (SAN) sources, custom event mapping, updates, deletion, and checking the
custom conversion referenced by an ad group (a handoff follow-up).

Other code: `src/write-review.ts`, `src/review-state.ts`, `src/write-impact.ts`,
`src/write-verification.ts`, `src/reviewed-routes.ts`, `src/preflight.ts`,
`src/provider-contracts.ts` (TikTok contract version 6), `src/action-contracts.ts`. Guidance:
"TikTok custom conversions" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md`
and an executable inspect example. Generated: `docs/CONTRACTS.md`,
`ACTION-CONTRACT-COVERAGE.{csv,json}`, `REMAINING-ACTIONS-2026-09-26.csv` (960 rows).

## Tests

`tests/tiktok-custom-conversions.test.mjs`, seven tests:

1. The create route inspects as reviewed with no network; update and delete stay blocked.
2. 33 invalid requests are refused with `INVALID_TIKTOK_CUSTOM_CONVERSION` before any request.
3. A conversion on an owned pixel is created without spending confirmation (a rule value mentions bids), the exact body is sent once, and it verifies although TikTok returns rules and values in another order and a number in another format; replay makes no second POST.
4. Shared, unbound, missing and full pixels and a duplicate name are refused before any write.
5. Refreshed pixel events and activity counts keep a review valid; a pixel that becomes shared is refused at execution, and a renamed pixel stops execution with `STATE_CHANGED`.
6. A read-back with another name, event or rule set is inconclusive with the exact changed field.
7. A TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all seven fail against a build of `06cd154` (`WRITE_CONTRACT_UNAVAILABLE`) and
pass with this change. Local log: `.runtime/tiktok-custom-conversions-20260926/red-check.log`.

## Verification

- Targeted: 1260/1260 across 88 related suites.
- Guidance coverage: 239 write-path refusals across 115 modules accounted for.
- Full qualification: see
  [TIKTOK-CUSTOM-CONVERSIONS-VERIFICATION-2026-09-26.json](TIKTOK-CUSTOM-CONVERSIONS-VERIFICATION-2026-09-26.json).

Live acceptance is unverified; it needs the updated deployment and an advertiser with an
owned pixel.

# Google Search conversion-value and target-ROAS workflows

Baseline: `c72ac2a`. Batch 140 adds two guided paused Search workflows through the existing six native
reviewed families, corrects F-208 and advances B08/B15/B16/B17/B24. The About Us page delivered in batch 124
remains in place. This work continues the original full improvement plan.

## Business brief, exact native intent and workflow

`google_search_conversion_value` uses standard campaign `maximize_conversion_value: {}` without a ROAS
target. `google_search_target_roas` uses that same native strategy with `target_roas` as a double. Both require
explicit `ACCOUNT_DEFAULT` conversion goals and `ACCOUNT_RECORDED_VALUES` value policy. Neither changes
conversion actions, goal settings, value settings or value rules. The existing complete own-conversion-customer
goal/primary-action inspection applies to both. Delivered values, historical eligibility, objective acceptance
and actual return remain unknown; an operator choice does not establish configured or delivered values.

The ROAS brief accepts decimal ratio text with at most six fractional places, from 0.01 through 1000 inclusive.
Integer arithmetic validates and canonicalizes its declaration before conversion to the required native double.
For example `3.5` means 350%, rather than 3.5%, money or micros. IEEE double representation is the vendor
wire type, not a claim of arbitrary decimal precision. Percent text, scientific notation, numeric/boolean/object
coercion, out-of-range values and contradictory bid/goal/tolerance settings are refused. No target is inferred.

Every plan retains a dedicated exact daily budget, Search-only network choices, explicit political-advertising
declaration, exact-match keywords, original selected login/account/currency and targeting. The campaign parent
is PAUSED with enabled children. Preview and save are local; saving leaves an unapproved draft. Subsequent
native steps use independent frozen reviews, current ownership/grants, idempotency and exact read-back.
Activation remains a separate reviewed change. A target is an average optimization ratio, not guaranteed
return or a spending cap; this workflow neither predicts nor promises ROAS.

English/Arabic forms require an explicit recorded-values choice and explain the ratio range and percentage.
The readable preview displays exact money/micros, original scope, paused intent, strategy, value/goal policy
and ratio/percentage, with literal identifiers in LTR isolation and escaped source names. Incompatible native
strategy, target type/value, policy, scope or currency falls back to the original compiled details. Approved
playbooks may supply ratio text while recorded-value and goal choices remain explicit form decisions.

## F-208: typed strategy and untargeted read-back

The existing generic native campaign contract could accept `maximize_conversion_value: {}` and mark it
verified even when native state contained a positive `targetRoas`. A synthetic native lifecycle baseline
reproduced this false positive. The verification projection now selects the exact target field and compares
zero for an untargeted plan. Google's v25 `target_roas` is a non-optional proto3 double: omission represents
zero only when the exact selected field, campaign resource and `MAXIMIZE_CONVERSION_VALUE` strategy match.
Wrong/missing strategy, positive unexpected target, and null/string/boolean/array shape cannot verify.

A local typed proof marker is added after GAQL compilation; it never enters native requests. A scoped
`google-campaign-value-roas-v1` verification-cache version retires older affected proofs without resetting
the original accepted mutation, key or receipt. New valid proofs retain bounded cache reuse and current
authority checks. Changed native state follows original bounded read-only verification: initial inconclusive
state becomes mismatch after the repeated stable disagreement; neither phase resubmits the accepted write.
Pending plans refresh retired value-bidding proof before preparation, execution or approval can reuse its
accepted predecessor outputs; changed state stops dependent work. An additional pending-plan baseline failed
**1/0/1/0, 879.236 ms** before this guard. Historical completed runs are not replayed. Explicit `amcp_campaign verify` uses the original review ID.

## Primary contract research

Checked 2026-10-04: Google's [v25 MaximizeConversionValue reference](https://developers.google.com/google-ads/api/reference/rpc/v25/MaximizeConversionValue),
[TargetRoas ratio range](https://developers.google.com/google-ads/api/reference/rpc/v25/TargetRoas),
[strategy assignment](https://developers.google.com/google-ads/api/docs/campaigns/bidding/assign-strategies),
and [original v25 proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/common/bidding.proto)
establish the campaign strategy, native double, ratio meaning and implicit default. CPC limits remain
portfolio-only and are excluded from these standard campaign briefs. The API's Performance Max example is
not evidence for Search account eligibility.

Google's [Maximize conversion value guide](https://support.google.com/google-ads/answer/7684216) supports Search
and requires tracked conversion values; [target ROAS guidance](https://support.google.com/google-ads/answer/6268637)
explains historical conversion requirements and average optimization behavior. These references establish
vendor behavior, not the selected account's actual eligibility, delivered values or return. Current own-customer
configuration and real delivery must be separately qualified before activation.

## Qualification and remaining scope

The original three feature/native regression baselines failed **3/0/3/0, 1.098 seconds**; the corrected baseline
passed **3/3/0/0, 1.913 seconds**. Twelve backend cases cover both modes, bounded ratio text, explicit choices,
profile provenance, read-only current goals, all six independent native steps, refusal/receipt/cache recovery
and current authority. Three bilingual controller cases cover the form, readable exact preview and malformed
fallback; contract-example coverage compiles every discovered recipe at the maximum targeting count.

The real MCP SDK completes each 20-call discovery/inspection/draft/native-review/replay/revocation journey:
87,085 / 87,538 structured response bytes, 38 synthetic native requests and six synthetic mutations per mode,
zero external provider calls. Text and structured protocol payloads match after JSON serialization. A successful
synthetic full journey leaves the parent paused and retains its original receipts.

Full related and fresh sanitized release gates are recorded below when complete. The three public reports are
regenerated only after sanitized build with one literal empty synthetic sample. No private root sample or live
provider credentials are read. Local Docker/FFmpeg, actual browser/assistive, deployed and live-provider evidence
remain separate. Native totals stay 3,247 actions / 167 families / 800 reviewed writes. The original 28-package
matrix remains 13 implemented / 14 partial / one open, now with twelve guided recipes. Additional objectives,
delivered values/history, other conversion customers and qualified live accounts remain outstanding.

The first full candidate halted at an owned Windows temporary-directory cleanup failure (ENOTEMPTY):
4,190 total / 4,184 passes / one failure / five expected local skips, 121.361 seconds. No release is based on
that attempt. The existing evidence-index restore fixture now validates its unique real disposable path and
refuses links before bounded recursive cleanup retries; production retention and user files are unchanged.
The corrected focused suite passed **47/47/0/0, 22.882 seconds**, including legacy pending continuation and
credential/key-bound database restore. Updated source requires a fresh complete qualification.

## Batch 140 corrected sanitized release preflight

Final related suite **248/248/0/0, 24.099 seconds**. A fresh corrected candidate passed offline install/build/
early tracked-report freshness/full check/Railway, every exit zero. Main **4,191 total / 4,186 passes /
no failures / five expected local FFmpeg skips, 115.538 seconds**; capture **4/4/0/0, 70.012 ms**.
Website: 34 scripts and 3,393 selected Arabic messages; documentation index: 306 documents. Manifest:
1,720 public source files plus one literal generated empty sample; preflight source hash
`12f454485b968bb0c9edfbd735def1e7f0fbdf52e5ceee3777d109eeeb740854`.
All three tracked public reports regenerated unchanged after the fresh sanitized build and preserved their
exact bytes through qualification. The private root sample was not read. These evidence paragraphs follow
preflight; the final committed revision requires a fresh maintained source proof and every full gate before
the sole Work-here push. Local Docker/FFmpeg, actual browser/assistive, live and deployed evidence remain separate.

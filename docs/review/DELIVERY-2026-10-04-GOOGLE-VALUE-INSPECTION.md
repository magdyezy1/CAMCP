# Current Google primary-action conversion value settings

Baseline: `4d73f57`. Batch 141 advances B08/B15/B16/B17/B20/B24 with bounded current configuration inspection
for the two guided value-bidding recipes. It preserves all original paused native launches, reviewed writes
and accepted-receipt recovery. The original full improvement plan continues.

## Exact selected configuration and current authority

Live recipe eligibility now selects `conversion_action.value_settings.default_value`, `default_currency_code`
and `always_use_default_value` alongside the existing complete primary-action fields. It reads the same selected
client using its own conversion customer and joins enabled explicit primary actions to biddable account-default
goals. No conversion events, other customers, personal records, value rules, goal edits or mutations are read or
submitted. The conversion-count/CPA recipes retain their original queries and response shape. Local inspection
still makes zero native requests. The private selection flag is derived from the qualified recipe dependencies.

All three fields have optional presence in the [original v25 proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/conversion_action.proto),
checked 2026-10-04. Missing/null fields stay unknown; explicit numeric zero and boolean false remain known.
This differs from the implicit native target-ROAS zero handled by F-208. Google's
[ValueSettings reference](https://developers.google.com/google-ads/api/reference/rpc/v25/ConversionAction.ValueSettings)
describes defaults when event values/currency are missing or invalid, and the flag that always uses defaults.
Inspection validates a native finite double from zero through the existing supported 1e12 boundary, an explicit
three-letter currency and an optional typed boolean without coercion. Unqualified shapes or extra fields cannot
produce a complete ready proof. The native conversion currency and value are preserved without FX calculation.

The complete collections are inspected twice. Their state hash includes the selected value settings; changed
settings invalidate the whole configuration observation. Existing limits remain 64 requests, 4,000 rows, 2 MiB,
60 seconds and ten pages per collection. Adding selected columns adds no collection round or endpoint. Current
key/session/login/account/profile, credential and brief checks bracket native work. Read-only deployments and
readers can inspect settings while write blockers remain in force. Revoked authority refuses a response.

`conversion_value_configuration` is confirmed only when every matching primary action has all three explicit
settings and no matching enabled action has an unknown primary flag. The summary covers the full collection;
only twenty primary rows are displayed. Missing settings in undisplayed rows therefore keep readiness unknown.
Shared/manager tracking, incomplete reads and collection limits also remain unknown. Configured defaults do
not establish received event values, conversion history, actual ROAS or provider/account eligibility.

## Website, workflow and MCP contract

The English/Arabic account-prerequisite view adds a collapsed current-value table with source action names/IDs,
configured amount, original conversion currency and event-value behavior. Unknown optional fields have an
explicit label. Its caption, column headers and named keyboard-accessible scrolling region use the existing
mobile table layout. Literal values/currency/IDs remain LTR; source names are escaped. Malformed values,
different scope, wrong selection, incomplete proof or inconsistent collection counts withhold the table.

The controller fixtures now execute the actual localization module, including placeholder interpolation,
alongside the existing request/brief/navigation/session race guards. The context and MCP descriptor explain
the selected configuration and its separate delivery/eligibility limits. Save remains a local unapproved paused
draft; the check never becomes continuing write or activation authority.

## Qualification and continuing scope

The feature baseline failed **1/0/1/0, 710.711 ms** because the setting dependency and read did not exist.
After implementation it passed **1/1/0/0, 3.136 seconds**. Eight backend cases cover both recipes, original
currency, zero/false/missing fields, malformed/coerced/bounded fields, repeated-read changes, reader/write
separation, key/connection revocation, complete collections beyond twenty display rows, unknown primary
flags, shared/manager customers and unchanged local/count-mode behavior.

Two bilingual controller cases and one new real SDK journey qualify the view and published integration.
Combined feature/original-goal/SDK/controller suite: **55/55/0/0, 5.405 seconds**. The new SDK journey uses
five calls, 37,539 structured response bytes and nine synthetic configuration requests, with zero external
provider requests or mutations. Its original unapproved draft and revoked-key behavior are preserved.
Final related suite: **156/156/0/0, 24.332 seconds**.

Fresh sanitized report generation and full release qualification follow below. No private root sample or live
credentials are read. Actual browser/assistive, deployed and live-provider evidence remain separate. Native
totals stay 3,247 actions / 167 families / 800 reviewed writes. The original 28-package matrix remains
13 implemented / 14 partial / one open, with twelve guided recipes. Additional objectives, delivery/history,
runtime diagnostics, other conversion customers and real account acceptance remain within continuing scope.

## Batch 141 sanitized release preflight

A fresh sanitized candidate passed offline install/build/early tracked-report freshness/full check/Railway,
every exit zero. Main **4,202 total / 4,197 passes / no failures / five expected local FFmpeg skips,
125.385 seconds**; capture **4/4/0/0, 85.387 ms**. Website: 34 scripts, three pages and 3,398 selected
Arabic messages; documentation index: 307 documents. Manifest: 1,723 public source files plus one literal
generated empty sample; preflight source hash
`06171f9dac2debc819ddcfa0418d0abcca327bc15c8707d9bed2e46b5a56db5e`.
All three public reports regenerated unchanged after the fresh sanitized build and retained their exact bytes
through qualification. The private root sample was not read. These evidence paragraphs follow preflight;
the final committed revision requires a fresh maintained source proof and all full gates before the sole
Work-here push. Actual browser/assistive, live-provider and deployed evidence remain separate.

## Final committed batch 141 qualification

Code `9e226808c01cce5eae85aef657921acd71cef9ae`; committed revision
`764936e623196eb94321a7863ebc0d7f35ca1908`. Maintained source proof independently matched all 1,723 public
Git blobs, one generated literal empty sample and three tracked report blobs. Final source hash:
`37c1d039b38a1428f0e60285c293498655ddfd72bea45fefe7f1715f022d5365`. Offline install/build/early tracked-report
freshness/full check/Railway all passed, with exact report-byte preservation. Main **4,202/4,197/0/5,
117.982 seconds**; capture **4/4/0/0, 68.830 ms**. Sole Work-here push completed. Exact CI196 run37197521553,
job111422343999, is still qualifying that revision; no completed Linux/Docker claim is made here yet.

# Original Google campaign/hour/day evidence

Batch 179 adds a seventh separate Google capture preset, google_campaign_hour, against baseline
6dda50c45978eb5b9a6551fbf7201ad23b6153dd. Only magdyezy1/CAMCP Work-here is authorized.
This delivery is dated 6 October in Cairo; primary research and prototype qualification began
5 October UTC. The campaign preset remains the default. Whole-plan status stays 13 implemented /
14 partial / one open, with hosted Actions neither started nor polled at the owner's direction.

## Native contract and interpretation

The exact campaign Search query retains customer/campaign resources, currency/timezone,
segments.date/hour and impressions, clicks, cost_micros, conversions and conversions_value.
It contains a finite original date range with no hour, campaign-status or channel filter and
no ad-group/ad/criterion projection. Existing scope and credential checks, collection limits,
explicit count and pagination validation, before/after customer checks and source references remain.
The duplicate key is the full native campaign resource, explicit hour and date across every page.
A missing or malformed hour, unexpected dimension, invalid date or duplicate refuses guided
capture before saving evidence. An explicit numeric zero remains native hour 0; omission cannot
become midnight. No absent hour acquires an invented row or zero activity.

The optional native_hour mapping accepts only an unmodified field pointer. Supplied hours must
be integers 0 through 23; manually mapped missing cells remain null, and unmapped reports acquire
no hour field, search match or extra workbook column. Retained rows and workbooks represent an
explicit hour as lossless text, including 0 and 23. Original source hashes, complete totals,
exact large native identities, money, missing metrics and every row stay attached to the report.
Search changes the displayed subset; downloads still include all original captured rows.
The table presents campaign name, hour, date and full resource, with escaped literal names and
LTR native hour/resource values in either language.

Hours and dates stay as originally reported alongside the verified account timezone. No UTC
instant, timezone conversion or daylight-saving split is inferred. Conversions remain
metrics.conversions, while attribution and period completeness remain declared. The distinct
campaign × hour × day preset/grain does not qualify delivery schedules, bids, campaign budgets,
negative keywords or reconciliation with a campaign daily report. No campaign mutation, plan,
write review or automatic provider retry is introduced.

## Primary research

[Google segmentation guidance](https://developers.google.com/google-ads/api/docs/reporting/segmentation),
updated 1 October 2026 and checked 5 October UTC, explains how dimensions split metrics and expand
row grain. Its current granular-date guidance includes date, week and hour within a 37-month
lookback; the provider remains responsible for version-specific range acceptance. This delivery
does not invent a new calendar cutoff or silently rewrite the requested range.
The [v25 hour field reference](https://developers.google.com/google-ads/api/fields/v25/segments#segments.hour)
is INT32, selectable, filterable, sortable and nonrepeated, with campaign/customer, date and all
five selected metrics in its compatibility list. The bounded normal-TLS public field read received
4,936,007 bytes, SHA-256 371f4dc7a1977c4fd6156324f75333986b47bf2b70df6a6e04b6f162afeb7542;
its retained selected section hash is 5b601ffa959f8cf16d64f8d2913a2bd4cd37f5ac6dacf427698cc43522ab20d8.
The [official v25 segments schema](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/common/segments.proto)
declares hour as optional int32, including zero. No live hourly query or advertising write was used.

## Connected prototype qualification

The isolated current-parent prototype passes 82/82/0/0 focused checks in 2960.838 ms, including
old device/keyword/MCP/retained-row/feedback cases. New hour tests cover all 24 explicit values,
source/account lineage, duplicate and foreign grains, missing/null/noninteger/out-of-range values,
mapping transforms, retained filtering and complete EN/AR workbooks. Distinct dates remain distinct;
verified non-UTC account metadata preserves original 0/23 and dates. Revoked authorization during
a second report page saves no evidence. Campaign allocation/exclusion and incompatible daily
reconciliation remain refused, with no new native call or write artifact.

The actual MCP SDK discovery/capture/filter/list/get/revocation journey uses six tool calls,
47,083 observed structured bytes and four fixed native semantic reads. A separate failed capture
and explicit retry journey uses three tool calls and 19,030 observed structured bytes, with three
failed-capture reads followed by four successful-capture reads. It saves only the complete successful
24-row report. Text/structured protocol and exposed schemas are checked; byte observations are
not thresholds. The owned transport accepts only the fixed Google Search POST as a semantic read.
No real provider egress or provider mutation occurs.

The website gate passes all 34 shipped scripts/four pages and 7,896 selected Arabic messages.
Nine new authored messages bring the catalog to 8,066 while preserving all 8,057 preceding values.
The unchanged guided feedback keeps raw provider/wrapper codes, settings and request references.
The current refused hour capture has an EN/AR persistent described alert lasting past 6.6 seconds,
cleared only by an explicit edit/new submit. A delayed reply from an older selection stays silent,
retains changed settings and saves nothing. Editing never automatically reads the provider.

A bound ignored prototype runner passes 24/24/0 browser journeys: normal, current refusal and
stale response at English/Arabic 320/375/768/1280 pixels. It uses the maintained original UI,
keyboard, table, native-counter, semantic and pinned selected-WCAG checks. All 576 original workbook
rows remain, including native hour 0/23 and known zero cells. There are 48 semantic and 48 selected
A/AA snapshots with zero automated violations; incomplete checks remain manual work. This record
is explicitly prototype evidence, not a clean-head or whole-plan qualification.

## Release boundary

Integration changes 16 explicit code files, adds six public fixtures/tests and preserves the
other 1,854 preceding public sources before documentation updates. The 408 original browser case
identities and assertions remain; three added hourly kinds bring the maintained total to 432,
with 864 initial/final semantic and selected-WCAG inspections when the optional engine is selected.
Fresh sanitized build, actual report regeneration/freshness, default full required-FFmpeg checks,
Railway configuration, exact committed-source parity and complete clean-head browser evidence
gate the sole guarded Work-here push. No earlier result qualifies later source bytes.
All three tracked report artifacts are generated from literal empty synthetic live samples;
root private configuration and live samples remain unread. Current Linux/Docker, deployed image,
real-provider hour acceptance, physical assistive tools and full editorial/WCAG acceptance remain
separate. B18/B27/B15/B16/B24 advance only within this evidenced scope and remain partial.

## Retained first full run and additional language guard

The first integrated full run passes 4,694 of 4,697 and refuses three strict metadata assertions
(two still require 8,057 catalog entries and one requires 28 Google collector reasons). The
actual catalog has 8,066 and the original Google collector has 29, including the newly authored
hour-grain refusal. All native-field, number, example, ownership and missing-language checks
remain. Those expected counts are updated explicitly. The exact decision-reporting selection
also adds only nativeHourMappingFailure, with a meaningful source-ownership/missing-language
regression; unrelated calls, native/member expressions and dynamic fallbacks remain excluded.
No runtime or previous Arabic value changes. The final code scope is 20 files, including four
additional locale tooling/expectation files. All failed artifacts remain, and a fresh sanitized
full/default/required-FFmpeg candidate must pass; no earlier result is relabelled.

## Complete integrated working-source qualification

All six new sanitized install/build/report/freshness/default-full/Railway stages pass. Main 4,698/
4,698/0/0 in 140859.214 ms; capture 4/4/0/0 in 93.5183 ms. Required FFmpeg
runs with unchanged default concurrency and zero skips. All three report files regenerate
identically. The 1,871 public files plus one literal empty sample have source digest
 ed0379cf4d34346b18d6fdfe2010bb0d7f7241164a3a727d0630ec9667fd4d23. Selected Root and sanitized application bytes independently
match both build records: 1332 files / 52034544 bytes /
ac98b5dca7eba91b9281a97c9e7b1e53e0b652196c33b5bc0f49a6126884a15b. This is Windows public-file
evidence; Linux/image/deployed/real-provider acceptance remains separate.
The 35 changed locale/ownership/formatter checks also pass with no failure/skip in 7457.0061 ms.
Current narrow language coverage is 7,898 messages; the 8,066-entry / 1,256,779-byte catalog
retains every one of the previous 8,057 values. All 1,839 untouched preceding public files, 423
unchanged backend TypeScript files, 52 web files and 665 prior test files remain exact. Removing
only new browser/fixture additions reproduces every old assertion byte-for-byte; old locale
assertions retain native-field, quantity, example and missing-language checks. The 24-case
prototype keeps 576 original workbook rows, 48 semantic/selected-rule snapshots and 48
manual phases / 90 incomplete rules / 435 nodes. Failed first full/focused artifacts remain.
These records qualify their exact source bytes. Fresh clean-head full/parity and all 432
maintained browser cases still gate the sole push. Hosted Actions stays unused; B18/B27/B15/
B16/B24 remain partial and the matrix stays 13/14/1.

## Exact-head qualification and delivery

Code d639cf24 and documentation cfa78bf2 pass all six clean-head stages. Main 4,698/4,698/0/0
in 142258.9733 ms; capture 4/4/0/0 in 84.6362 ms with required FFmpeg/default concurrency
and three byte-identical regenerated reports. Exact source parity covers 1,871 public files
plus one literal empty sample, digest f0e777b7a90751d3c7565ecab36436c85800b79f7b3e955cc5ccd120a204fe99.
The complete browser run passes 432/432/0 from 2026-10-05T21:49:02.098Z through
2026-10-05T22:21:35.407Z. Website digest is fecafcd546e37aea82c5131b56b26a15f5be8ac46ecb73c40fe703e744724acd.
All original cases and 1,944 workbook rows remain. There are 864 semantic inspections/28,893
named controls, 864 pinned selected-rule inspections with zero automated violations, and eight
original-record keyboard regions/eight actual vertical scrolls. All 818 manual phases, 1,427
incomplete rules and 11,492 nodes remain. Selected application identity independently matches
both build records at 1,332 files / 52,034,544 bytes /
ac98b5dca7eba91b9281a97c9e7b1e53e0b652196c33b5bc0f49a6126884a15b. The sole guarded
push advances 6dda50c to cfa78bf and normal-TLS remote read confirms that revision at
2026-10-05T22:23:23.003Z. Hosted Actions remains unused; these passes do not establish
Linux/image/deployed/real-provider or full physical assistive acceptance.

# Guided Snapchat daily evidence — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `a4aa319`. Batch 103 extends B18/B24/B27.

Reports and MCP now discover `snapchat_campaign` and `snapchat_ad` guided daily presets. The website exposes
explicit swipe/view attribution choices in English and Arabic. The workflow reads native account breakdowns,
retains exact campaign/ad UUIDs and local dates, maps swipes to clicks, converts integer spend micros exactly,
and uses `conversion_purchases` from total conversion sources with conversion-time reporting. Caller-supplied
generic attribution/conversion text cannot override the generated native settings. No conversion value, entity
name, current creative assignment or historical creative usage is inferred.

Choose a 1-, 7- or 28-day swipe window and no view attribution, 1/3/6-hour view, 1-day view or 7-day view. A seven-day
view requires at least seven-day swipe. Deprecated 28-day view is unavailable. The declared complete date range
must contain 1–31 closed days in the actual account timezone. Daily UTC instants are calculated separately, so a
daylight-saving day can contain 23 or 25 hours. Snapchat requires whole-hour request boundaries; fractional-hour
local midnights and skipped midnight transitions are refused instead of silently shifting the reporting date.

Each capture verifies exact account identity, currency and timezone before and after collection. Account/session
access, required scope and credential/scope identity are rechecked around every provider await and before retention.
Every native response must be successful. Each page preserves its original request, source response hash,
capture time, entity/day counts and both delivery-finalization and conversion-processing timestamps. Both timestamps
must cover the selected end. This requirement applies to conversion-time reporting; it does not certify impression-time
attribution, measurement installation, data accuracy or a simultaneous point-in-time account snapshot.

The collector requests at most 200 entities per page and follows only the opaque cursor on the same account/route
with unchanged filters. It refuses foreign paths, credentials in links, extra/duplicate query keys, altered settings,
unknown continuation metadata, empty/repeating continuation and more than 100 pages. The entire capture shares the
existing 120-request, 120-second, 32-MiB limits and retains at most 10,000 daily rows / 8 MiB. Nested entity, grain,
window and daily-boundary checks reject duplicate entities/days, missing days, extra dimensions and partial/split
results. Missing metrics remain null; an explicitly complete empty breakdown can establish an empty captured report.
Unsafe native numeric values are refused; large integer strings retain exact decimal precision.

Successful reports use existing scoped retained paging/search, exact-text Excel download, analysis and compatible
reference reconciliation. A different attribution window cannot be reconciled as an equivalent report. Failed new
captures save no partial report and do not rewrite earlier retained evidence. This is a read-only reporting feature;
no provider mutation, permission change, advertising activation or live-account acceptance was performed.

Eleven new tests cover discovery, both native grains, precise money, full paging, empty/unknown values, finalization,
failed envelopes, dates and DST, invalid dimensions/numbers, malicious or repeated cursors, scope/credential/metadata
changes, row admission bounds, preserved prior sources, bilingual form parity and a real MCP SDK journey. Six backend
cases and one UI case were observed red before implementation. The focused provider/UI/reconciliation/loading group
passed **78 checks**; the SDK suite passed **34/34** after correcting its revocation fixture. The new SDK journey made
**six schema-validated calls / 28,097 structured response bytes / six synthetic GET requests**, including current-reader
access, retained comparison and revoked-key refusal. Root regression: **3,626 tests / 3,621 passed / zero failed /
five local FFmpeg skips; 88.49 seconds**. Evidence: `.runtime/snapchat-evidence-20261002/`.

Native request/response shapes, paging, units, finalization semantics and attribution restrictions were checked against
Snap's [Measurement reference](https://developers.snap.com/marketing-api/Ads-API/measurement). Account acceptance,
actual-browser/assistive-technology behavior and deployed execution remain unverified. Ad-squad breakdowns require
additional parent-specific collection; other result metrics, conversion values, dimensions and async exports remain
separate extensions. No live provider response was used as synthetic qualification evidence.

Batch 102 exact committed-source qualification passed on `a4aa319`: **3,610 passed / zero failed / five local FFmpeg
skips; 90.22 seconds**, four capture tests and Railway, **1,552 public files + one generated empty sample**, hash
`3466692b27a4c55e39d289f432f7f05753a8855d0b4c7c46be58b2e5cdf90060`.
It was pushed only to Work-here. [CI157](https://github.com/magdyezy1/CAMCP/actions/runs/36974104752) remains in progress
at this record. [CI156](https://github.com/magdyezy1/CAMCP/actions/runs/36971539914) succeeded on `3794fb9`: host and
Docker each **3,603 passed / zero failed/skipped**, four capture tests and Railway. Job `110726348350` and release-evidence
artifact `11213221251` were checked, including job logs.

Native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
Blueprint remains **13 implemented / 14 partial / 1 open**. Guided capture now includes two Snapchat presets alongside
Google, Meta, LinkedIn and TikTok; B18/B27 retain their additional provider/dimension and reconciliation gaps.

Sanitized preflight `.release/snapchat-evidence-preflight-r2-20261002` passed all stages and Railway:
**3,621 passed / zero failed / five local FFmpeg skips; 90.03 seconds**, four capture tests,
33 browser scripts, 2,777 selected Arabic messages and 269 documents. Its **1,556 public source files**
plus one generated empty sample have hash `cadf245458b026a8f825c6fbfdbb861faafa74b3ab22a600b7437ad75a6ecca8`.
The initial candidate stopped on fixture formatting; the corrected fresh candidate above completed every stage.
Exact committed-source qualification follows before the sole Work-here push.

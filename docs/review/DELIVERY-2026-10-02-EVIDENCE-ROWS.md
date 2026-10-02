# Readable retained evidence and row navigation — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `e9c8116`. Batch 92 expands B09/B18/B24 with a website workflow improvement through existing reporting reads.

Detailed report evidence previously exposed only its first native mapped page as raw JSON. It now has a readable
table and page navigation across the retained report. The first 50 rows already returned by report opening are
reused without another request. Previous/next controls and a direct page selector read 50 rows at a time through
the existing `amcp_reporting get` contract, bounded to the retained report's 10,000 rows. These are retained
document reads, not fresh provider queries. The backend continues to enforce current account/login access.

Native IDs and decimal strings display exactly; zero and unknown are distinct. Entity names/search terms stay
in their original language and are escaped. The table shows mapped metrics with native currency, meaningful
headers, a caption and a keyboard-focusable horizontal scroll region. Page status is announced and receives
focus after explicit navigation; controls are disabled during a read. English/Arabic labels and page counts are
localized while native values and request arguments remain identical. Existing responsive table/pager styles are
reused. This establishes tested markup/controller behavior, not actual-browser or assistive-technology acceptance.

Every new page must match the original report ID, source hash, account, connection, gateway and row count, with
the expected page size/continuation and scalar values. Mismatches or read failures clear the row table and show
a bounded retry; raw errors are not echoed. Route, identity, selected-report and detached-root checks prevent
departed controls from starting reads and late responses/failures from repainting the new view. Existing analysis,
comparison and report-selection guards continue independently.

The source-details panel now includes retained native account checks, per-page request/hash evidence, collection
kind and Overview source lineage when present. These fields already exist in the authorized report response;
no additional backend access, data retention or advertising action is introduced.

Seven new cases were observed failing before implementation: six component cases plus the report-view integration.
Focused **28/28** passed, including exact values and escaped names, 101-row traversal, direct selection, empty state,
busy-request suppression, all four departure contexts, late success/failure, changed/foreign/malformed page data,
retry and bilingual payload parity. Root regression: **3,499 tests / 3,494 passed / zero failed / five local FFmpeg
skips; 73.98 seconds**. Static checks cover **32 browser scripts / 2,657 selected Arabic messages**.
Evidence: `.runtime/evidence-rows-20261002/`. No native-provider or deployed browser acceptance is asserted.

Batch 91 exact committed-source checks and Railway passed on `e9c8116`: **3,487 passed, zero failed, five local
FFmpeg skips; 77.96 seconds**, plus four capture tests. **1,518 public files + one generated empty sample**,
source hash `46d072009818c48f9b743384424d07d1481d9d90bbc9e98b9af0d997e4261948`.
[CI146](https://github.com/magdyezy1/CAMCP/actions/runs/36954874286) was running when checked.
X [CI144](https://github.com/magdyezy1/CAMCP/actions/runs/36951901626) succeeded on `d6e16c6`: host/Docker each
**3,475 passed, zero failed/skipped**, required FFmpeg, four capture tests, Railway and both container smokes;
job `110666457164`, artifact `11205635855`.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Granular external export, wider providers and
measurement qualification remain tracked rather than counted as complete.

Sanitized preflight `.release/evidence-rows-preflight-20261002` passed every check and Railway stage:
**3,494 passed, zero failed, five local FFmpeg skips; 80.20 seconds**, four capture tests, 32 browser scripts
and 258 documents. Its **1,520 public source files** plus one generated empty sample have hash
`7f2ded073d66c6e8821d6cca29ea1a0e5ec8fe490a0b9ea112f6fbcc9d59855f`. Exact committed-source checks follow before push.

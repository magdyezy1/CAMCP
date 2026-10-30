---
status: record
tier: engineering
---

# TikTok guided daily reporting evidence — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `d6e16c6`. Batch 90 expands B18/B15/B24/B27 using existing native read contracts.

The detailed evidence workflow now offers standard TikTok campaign, ad group and ad reports at entity × day
grain. Presets `tiktok_campaign`, `tiktok_adgroup` and `tiktok_ad` are available through the Reports website
and `amcp_reporting capture_preset`. Supply exact login/advertiser, currency, IANA timezone, date_from/date_to,
source_name, attribution (or `unknown`) and `complete:true`. The application requires 1–31 closed days in that
advertiser timezone. This is an application collection bound, not a claim about TikTok's maximum date range.

Each capture reads current advertiser identity, currency and timezone before and after all report pages. It uses
the existing v1.3 advertiser-info and integrated-report GET routes, BASIC reporting and AUCTION_CAMPAIGN,
AUCTION_ADGROUP or AUCTION_AD. The request selects the exact native entity ID plus stat_time_day dimensions,
entity name, spend, impressions, clicks and conversion. Lifetime, multi-advertiser UTC and total-metric modes
are explicitly disabled. Standard auction evidence does not qualify Smart+, GMV Max or specialized reporting.

Native string IDs remain exact. Money uses the existing exact decimal accumulator with up to nine fractional
places, including strings beyond the safe integer range. Unsafe parsed numbers, exponent/negative or oversized
decimal precision are refused; parsed safe numbers do not establish their original JSON decimal spelling.
Native dates accept a calendar date or the midnight stat_time_day form, never an hourly aggregate. Missing
metrics stay unknown; conversion value and reach remain unmapped. A valid zero-row response requires explicit
zero native counts and both account checks. It describes that scoped report, not independent proof of access,
measurement health or account inactivity.

The fixed conversion definition is `conversion (optimization goal)`: goals may differ by entity. It is not a
purchase alias or a claim of business-event equivalence. Attribution remains declared, not fetched or verified.
The UI explains these limits in English/Arabic, keeps native identifiers/measurement values unchanged and restores
the user's declarations when moving between fixed LinkedIn/TikTok fields and other presets. Existing stale-form,
navigation and identity guards still apply. Real-browser/editorial acceptance remains separate from the VM checks.

Single-page native requests are assembled into a labeled `tiktok_daily_pages` collection. Retained source_pages
contain every page's exact request, hash, row count, total and capture time; native_account_evidence contains both
metadata reads and their hashes. The collection hash is not represented as a single provider response hash.
Strict page/page-size/total/row-count consistency, stable totals and unique entity/day keys are required. Missing
pagination, unknown continuation markers, mismatched scope/date/grain, changed totals or overlaps stop persistence.
The adapter uses at most ten pages of 1,000 rows; 10,001 advertised rows are refused immediately. The outer budget
includes all account/report reads and retries within 120 requests, 32 MiB and 120 seconds. Retained reports are
limited to 8 MiB. Actor/access/credential/scope binding is checked around each request and before saving. No
advertising mutation, new OAuth scope or new native route is introduced. Stable counts and no duplicates cannot
prove that other rows did not change between pages; this remains a collection, not a point-in-time snapshot.

Ten new tests were observed red before implementation: eight backend cases, one bilingual UI case and one SDK
journey. Focused **56/56** passed, including all three levels, exact decimals, malformed/empty/overlapping/changing
pages, access/login/scope races after each read, account metadata drift, date restrictions and the full 10,000-row
bound. The real SDK journey captures, retrieves and reconciles matching retained declarations with **4 calls /
15,452 structured bytes / 6 synthetic GETs / zero provider mutations**. Schemas and dual response envelopes are
checked. Root regression: **3,485 tests / 3,480 passed / zero failed / five local FFmpeg skips; 80.49 seconds**.
The initial root run had one Python-launch environment failure in the unchanged WSDL test; rerunning with the
bundled Python path passed. Locale validation covers **2,645 selected messages**. Evidence: `.runtime/tiktok-evidence-20261002/`.

Primary reference checked 2 October 2026: TikTok's official [ReportingApi request contract](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/ReportingApi.md)
documents the integrated GET and its advertiser/dimension/metric/date/page parameters. Its generic response model
does not independently qualify every row or metric combination. The detailed portal response reference remains
unreadable here. Response interpretation follows the existing reviewed repository v1.3 conventions and is tested
with synthetic native payloads. This is explicitly not live-provider or deployed acceptance.

Batch 89 exact committed-source checks and Railway passed on `d6e16c6`: **3,470 passed, zero failed, five local
FFmpeg skips; 76.90 seconds**, plus four capture tests. **1,511 public files + one generated empty sample**,
source hash `fa11f33b8ff20b460fb936fb4aa8f7b0079df59ef9e876bfed221f37734b0be3`.
[CI144](https://github.com/magdyezy1/CAMCP/actions/runs/36951901626) was running when checked.
[CI142](https://github.com/magdyezy1/CAMCP/actions/runs/36948487923) succeeded on `ee57b8f`: host/Docker each
**3,458 passed, zero failed/skipped**, required FFmpeg, four capture tests, Railway and both container smokes;
job `110655885496`, artifact `11204515972`.
[CI143](https://github.com/magdyezy1/CAMCP/actions/runs/36950041623) succeeded on `d4a2e14`: host/Docker each
**3,464 passed, zero failed/skipped**, required FFmpeg, four capture tests, Railway and both container smokes;
job `110660737728`, artifact `11204464206`.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Provider breadth, granular exports, attribution
qualification and external acceptance remain tracked; this slice does not close those packages.

Sanitized preflight `.release/tiktok-evidence-preflight-20261002` passed every check and Railway stage:
**3,480 passed, zero failed, five local FFmpeg skips; 78.53 seconds**, four capture tests, 32 browser scripts
and 256 documents. Its **1,515 public source files** plus one generated empty sample have hash
`ae0e16d0734cb9a3c9da14d4ed063f783356ae63d85d1239b2efcb7bdd6a2958`. Exact committed-source checks follow before push.

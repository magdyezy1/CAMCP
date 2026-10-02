# TikTok standard portfolio workflow — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `4ca02fe`. Batch 87 expands B27/B15/B24 through existing read-only native actions.

Live portfolio now includes TikTok campaign → ad group → ad navigation. Website controls in English/Arabic use
the exact advertiser/login and native IDs; display operation status, secondary status and budget mode independently;
and preserve native amounts, current account currency/timezone, parent navigation and scoped continuation. An ENABLE
operation status is not labeled as proof of serving. Existing route, identity, request and DOM-lifetime guards remain.

MCP: `amcp_workspace {action:"portfolio",gateway:"tiktok_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign"}}`. Children use `entity:"adgroup",campaign_id`, then
`entity:"ad",campaign_id,adgroup_id`. This uses TikTok's native `adgroup_id` spelling. Pages contain 1–100 rows;
the website requests 50. The shared `record_kind:portfolio` handoff opens `/portfolio`.

The adapter uses four existing GET routes: advertiser information and the standard campaign, ad-group and ad lists.
It reads advertiser currency/timezone for each page and sends exact advertiser/parent filters, selected fields and
`primary_status:STATUS_NOT_DELETE`. Child ownership is checked in the account-scoped list response; every row's
advertiser, campaign and group must match before any row is returned. Direct scoped child reads remain available.
These standard routes do not imply complete Smart+, GMV Max, deleted-entity or other specialized-route coverage.
No conditional program entitlement is inferred and no native action status changed.

Only selected identity, names, status, budget mode/amount and creation/modification metadata are projected.
Targeting, billing, ad copy, landing URLs, credentials and arbitrary provider fields are withheld. IDs remain exact
numeric strings. Amounts preserve the native JSON type: decimal strings keep their spelling; finite nonnegative
safe-magnitude JSON numbers remain numbers without conversion. A parsed JSON number is not claimed to preserve an
unseen original decimal lexeme. Missing amounts stay null. Native budget mode remains visible, including unlimited,
daily and total semantics; a returned zero or absent amount does not invent a configured budget.

Each page is bounded to six requests including retries, 101 total rows (one advertiser plus 100 entities), 8 MiB
and 60 seconds. Current actor/account/login and credential/scope fingerprints are checked before/after each read
and before returning. Signed canonical base64url cursors bind actor, login/permissions, advertiser, exact hierarchy,
native version and page size. They expire after five minutes and bound traversal to 100 pages. Native page numbers,
page size, total pages, total count and returned row count must agree. Changed totals, duplicate/adjacent overlapping
IDs, unsafe money, foreign hierarchy, provider errors, unknown continuation and partial/unknown envelopes fail.
The adapter reissues fixed scoped routes and never follows a returned URL. Stable counts and adjacent overlap checks
do not establish a point-in-time snapshot or detect every possible reorder across non-adjacent pages.

Nine new cases were observed red: seven backend cases, one bilingual UI journey and one real-SDK case against the
exact batch 86 candidate. Focused **84/84** passed across all five portfolio adapters, UI/localization and SDK tasks.
The new SDK journey measures campaign page → next page → group → ad: **4 calls / 7,283 structured bytes / eight
synthetic native GETs / zero provider mutations**, validating advertised input schemas, both envelopes and the exact
website handoff. UI tests keep English/Arabic native requests identical and refuse new reads after identity departure.
Static checks cover **32 browser scripts / 2,586 selected Arabic messages**. Evidence:
`.runtime/tiktok-portfolio-20261002/`. These are fixture/VM checks; actual browser, live and deployed acceptance is separate.

Official request contracts checked 2 October 2026:
- [Campaign list in TikTok's SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/CampaignCreationApi.md)
- [Ad-group list](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdgroupApi.md)
- [Ad list and filters](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdApi.md)
- [Advertiser information](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AccountManagementApi.md)
- [Campaign filters](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/FilteringCampaignGet.md),
  [group filters](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/FilteringAdgroupGet.md) and
  [ad filters](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/FilteringAdGet.md).

The current SDK documents the response data as a generic object. The detailed portal pages could not be rendered
by the web reader in this run; response interpretation reuses the repository's previously reviewed v1.3 list/account
contracts and synthetic fixtures, including [manual budget semantics](../implementation/TIKTOK-BUDGETS-2026-09-26.md).
This is not a new live response qualification or a full TikTok API census. Unknown shapes are refused.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. No private root sample, credential, ad mutation,
OAuth expansion, external message, dependency or production deployment was used.

Batch 86 exact-source checks/Railway passed on `4ca02fe`: **3,444 passed, zero failed, five local FFmpeg skips;
81.30 seconds**, four capture tests, **1,503 public files + one generated empty sample**, source hash
`5c7ae4dbcc253e916f65c46e06438583002d3428148cad841d42ba39c8c8fd0e`.
[CI141](https://github.com/magdyezy1/CAMCP/actions/runs/36947411085) was running at this check.
[CI139](https://github.com/magdyezy1/CAMCP/actions/runs/36944047644) succeeded on `4e66269`: host and Docker each
passed **3,429 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110641900833` uploaded release-evidence artifact `11202891004`.

Root regression: **3,458 tests / 3,453 passed / zero failed / five local FFmpeg skips; 73.37 seconds**.
Sanitized preflight `.release/tiktok-portfolio-preflight-20261002` passed every check/Railway stage:
**3,453 passed, zero failed, five local FFmpeg skips; 77.68 seconds**, four capture tests, 32 browser scripts
and 253 documents. Its **1,506 public source files** plus one generated empty sample have hash
`5ba28f4417319cad6dc8fc0ea66d5824a4ab41deeeff387912b925bdb3d19e47`. Exact committed-source checks follow before push.

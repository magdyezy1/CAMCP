# Native country evidence and bounded inventory comparison

Only magdyezy1/CAMCP Work-here in CAMCP-Codes-final-branch is authorized. Live provider
accounts remain read-only; hosted Actions are owner-waived, with local/Railway gates retained.

## Country capture

`google_campaign_country` adds campaign × native country × native location type × day evidence
from Google Ads `geographic_view`. Exact decimal country IDs, full campaign/geographic resources,
all four documented location types and explicitly returned country ID `0` remain literal.
Presence and interest are separate; IDs are not country names. Missing fields are refused rather
than inferred from ProtoJSON defaults. Collection brackets current account metadata and validates
complete bounded pagination, ownership, grain, money, dates, currency and timezone. This does
not qualify country exclusions or native budget changes. Optional mappings/workbook columns
preserve native country/type/resource fields; existing unmapped workbooks stay unchanged.

English/Arabic workflows retain source errors and references, explicit retry, stale-response
guards and full-row export. Local filtering leaves retained totals untouched. All 114 focused
native, mapping, workbook, controller and actual MCP SDK cases pass. The 24 rendered prototype
journeys cover both languages at 320/375/768/1280 pixels, success/error/stale paths. Earlier
failed versions remain recorded; fixture API usage, preset inventory and mock text fixes are
test repairs. Live discovery currently returns an internal MCP error, so live capture is unqualified.

Primary references: [geographic_view](https://developers.google.com/google-ads/api/fields/v25/geographic_view),
[GeoTargetingType](https://developers.google.com/google-ads/api/reference/rpc/v25/GeoTargetingTypeEnum.GeoTargetingType),
[official enum schema](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/enums/geo_targeting_type.proto).

## Inventory comparison

`amcp_workspace portfolio_reconcile` performs two sequential complete observations through
the qualified Google/Meta/LinkedIn/Snapchat/TikTok/X inventory adapters and compares their
supported native projections. The explicit website **Compare two complete reads** action
preserves current inventory and displays counts, collection windows, exact IDs, before/after
fields, page hashes and observed-added/not-observed/changed groups. These are not atomic
snapshots. Absence does not prove deletion or authorize deletion; matching supported fields
does not prove unchanged intervening state or historical assignment.

Both observations independently start native signed continuations, retaining current actor,
connection and credential checks. Duplicates, contradictory pages, changed authority, missing
metadata, mixed currency/timezone or exceeded bounds refuse the whole comparison. Limits:
page size 1–100, entities 1–1000, pages 1–25 per observation; whole workflow at most 120
attempted requests, 120 seconds, 32 MiB received, and 2 MiB output. Nested collectors debit
every active enclosing request/time/byte budget; reentering the same budget does not double-charge.
No provider mutation, saved report, reviewed write or automatic retry is produced. Existing
adapters can maintain their owned local ownership caches.

All 34 focused reconciliation/budget/UI cases and the actual SDK case pass. The combined
six-provider portfolio/country run passes 103 cases. Prototype v1 exposed an original inventory
caption omission and test-only expected-error/route-cleanup defects; v2 passes 24 journeys.
Three later Arabic table labels require final-source qualification. The maintained browser
matrix retains its original 512 journeys and adds 48 country/comparison journeys: 560 total.

## Capacity and release gate

An owned WAL benchmark with six synthetic tenants, 120 regular jobs, 12 revoked jobs and
12 scheduled jobs passes with one and four workers: 132 completions, 12 revocation refusals,
144 unique dispatches, no duplicates or cross-tenant results, verified authority and audit chain.
Elapsed times are 2677.65/2856.91 ms; claim p95 is 1.37/3.24 ms. These measurements do not
qualify deployed capacity or real-tenant throughput.

A fresh sanitized release, empty generated live samples, build/report generation/freshness,
required-FFmpeg full checks, Railway configuration and the complete maintained browser matrix
gate publication. Prototype passes do not replace final-source acceptance. Broader providers,
dimensions, private entitlements, live delivery and physical assistive criteria remain explicit;
this increment does not relabel those remaining original-plan criteria as complete.

The public-only v3 candidate passes 5,031/5,031 main cases and 4/4 capture cases with required
FFmpeg, report freshness and all remaining full-check stages. The preceding full run's two
failures are retained: the workspace tool description must lead with its usage instruction, and
the authored website diagnostic inventory must include the new storage reason. Both are fixed
and all eight directly related checks pass. The first maintained browser run passed 304 journeys
before an intentional interruption when the tool-description source changed. It is incomplete
evidence; the final complete 560-journey run and exact committed-source proof still gate publication.

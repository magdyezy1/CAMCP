---
status: record
tier: engineering
---

# Detailed retained evidence Excel download — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `7c6d9e5`. Batch 93 extends B09/B18/B23/B24 with an authenticated all-row export.

Opening detailed evidence now offers an Excel download with an explicit English/Arabic output choice, independent
of the interface language and defaulting to English. The workbook includes all retained mapped native rows,
retained metric totals and coverage, field mappings, measurement declarations and selected source references.
The five sheets have frozen headers, filters, wrapped text and bounded adaptive row heights. Arabic changes
sheet labels and view direction; native column keys, IDs, names, dates and values retain their original content.
Long cell contents remain available in the cell even if they exceed the bounded display height.

All cells are literal text, including numeric metrics, to preserve leading zeros, long IDs and exact decimal
strings. No formula or hyperlink objects are emitted. Missing cells stay blank; the mappings distinguish unknown
and unmapped metrics. Zero stays zero. Totals come from the retained document rather than a new calculation.
Attribution, completeness and source settings remain declared evidence, not an independent measurement audit.
Selected account/page hashes and capture times plus Overview lineage are included when retained; raw request
bodies, arbitrary document properties and credentials are not included in the workbook.

`GET /api/reporting-evidence/:id.xlsx?language=en|ar` requires the current website session and account/login
access. It rechecks session, authority and document revision after asynchronous generation, sets private no-store
caching, supplies a SHA-256 content header, and uses a constant attachment name. The reporting capture/get
response exposes a relative `xlsx_path` for that authenticated handoff. No provider read or retained binary
is created. This does not add a scheduled destination, retention preference or external sharing permission.

Generation validates at most 10,000 rows, 125,000 cells, 32,767 characters per cell and 8 MiB of cell text; output
is bounded to 20 MiB. It shares the existing one-per-tenant/two-per-process artifact budget, with no queue.
Website controls suppress duplicate clicks, validate type/size and use a fixed same-origin route. Navigation,
identity, selected-report and detached-root checks discard obsolete files/errors before creating a download URL.
Failures expose a localized retry message without raw error details. Current account checks remain server-side.

Nine new cases were observed red before their implementations (five backend, three controls, one integration).
Focused **33/33** passed: exact cells, all-row inclusion, omitted private request canaries, bilingual/native parity,
formula safety, row/cell/text bounds, shared concurrency, HTTP session/access/hash checks, post-generation
session revocation, account revocation and document revision changes, invalid response handling and stale-view
suppression. Root: **3,508 tests / 3,503 passed / zero failed / five local FFmpeg skips; 74.74 seconds**.
Static checks cover **32 browser scripts / 2,664 selected Arabic messages**. Evidence: `.runtime/evidence-artifacts-20261002/`.

A separate synthetic 10,000-row generation/reopen check produced **515,418 bytes in 412 ms**, then reopened in
263 ms, preserving the last exact ID and decimal cell. Process RSS grew from 101,322,752 to 163,508,224 bytes
after generation; process maximum including the reader was 281,092 KiB. This is a single local fixture measurement,
not real tenant load, multi-worker capacity, native-provider, actual-browser or Excel desktop acceptance.

Batch 92 exact committed-source checks and Railway passed on `7c6d9e5`: **3,494 passed / zero failed / five local
FFmpeg skips; 83.61 seconds**, plus four capture tests. **1,520 public files + one generated empty sample**;
source hash `0672c521f58dc0be2c10f7e38d424b8f2553fb6e6ba06e20c5cf8ae44ba4212d`.
[CI147](https://github.com/magdyezy1/CAMCP/actions/runs/36956104150) and
[CI146](https://github.com/magdyezy1/CAMCP/actions/runs/36954874286) were running when checked.
TikTok evidence [CI145](https://github.com/magdyezy1/CAMCP/actions/runs/36953753600) succeeded on `b264bca`:
host/Docker each **3,485 passed / zero failed/skipped**, required FFmpeg, four capture tests, Railway and both
container smokes; job `110672082067`, artifact `11205568220`.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Detailed retained XLSX export is delivered;
additional providers/dimensions and measurement qualification remain tracked separately.

Sanitized preflight `.release/evidence-artifacts-preflight-20261002` passed every check and Railway stage:
**3,503 passed / zero failed / five local FFmpeg skips; 77.19 seconds**, four capture tests, 32 browser scripts
and 259 documents. Its **1,524 public source files** plus one generated empty sample have hash
`dcbe61cbac2dbf86aacff06d8ad0156e1f56bf2d936bd722bfc9bb34a7fdb8e5`. Exact committed-source checks follow before push.

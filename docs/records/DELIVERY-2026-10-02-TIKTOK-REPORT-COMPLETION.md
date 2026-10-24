---
status: record
tier: engineering
---

# TikTok report completion integrity — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `b264bca`. Batch 91 fixes F-154 and extends B11/B18 without a new native route or advertising write.

**F-154 (medium), reproduced:** the shared TikTok report paginator accepted missing completion metadata,
changing native totals and overlapping native rows as `truncated:false`. A saved Overview report from a response
without page_info was also recorded complete with metrics. The guided daily capture added in batch 90 already
refused these cases through its own manual collection. The legacy aggregate path required the same protection.

The exact integrated-report GET route now requires explicit valid page, page_size, total_page, total_number and
list length on every native page. Unknown continuation markers, partial flags, missing/wrong types and inconsistent
counts stop aggregation. Explicit zero counts qualify an empty result; absent metadata never stands for zero.
Complete aggregation starts at page one and retains advertiser/date/metric/filter parameters while changing only
the page number. Native request page size defaults to ten only when omitted, matching the SDK request contract.

Requested native dimensions must be explicit and unique. Every row must contain exactly that dimensional grain
and a metrics object. Duplicate tuples within or across pages are refused independently of their metric values;
safe integer and equivalent string dimension values have the same identity. Distinct entity/day tuples remain
distinct. Totals must stay constant across pages. The original native first-page metadata is preserved instead
of being rewritten into a fabricated aggregate page; the existing outer pages/truncated fields describe collection.
The established page cap still yields `truncated:true`, which Overview refuses. Native single-page reads and
ordinary TikTok inventory routes retain their existing contract. Both guided daily capture and aggregate reporting
share the strict page-count validator. Stable counts and unique tuples do not prove a fixed provider snapshot.

Overview retains a scoped campaign_report source error and zero metrics from a refused source. A report with no
successful sources fails; ordinary mixed-source handling remains unchanged. The tests cover the saved-job path,
not only a standalone helper. Seven new tests failed against the exact batch 90 candidate and now pass. An initial
assertion expected partial for a sole failed source; it was corrected to the existing failed-source behavior and
re-run against baseline, where it still failed. Focused **33/33** passed. The three ignored baseline probes also
showed missing metadata, changed totals and overlap accepted before the repair.

Root regression: **3,492 tests / 3,487 passed / zero failed / five local FFmpeg skips;
74.04 seconds**. Evidence: `.runtime/tiktok-report-completion-20261002/`.
No website markup, locale strings, dependency, credential, OAuth permission or deployed service changed.
The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**.

The official [TikTok ReportingApi SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/ReportingApi.md)
request contract was checked for batch 90 on 2 October. It confirms the integrated GET, dimensions and page
parameters/defaults. Detailed response documentation remains unreadable here; these response checks follow the
existing repository's reviewed v1.3 conventions and synthetic payloads. This is not new live-provider qualification.

Batch 90 exact committed-source checks and Railway passed on `b264bca`: **3,480 passed, zero failed, five local
FFmpeg skips; 77.38 seconds**, plus four capture tests. **1,515 public files + one generated empty sample**,
source hash `df6e25e1e15e4f1f9677609db31385a0e0005f7d86f04df59f2dd7fe620fdee4`.
[CI145](https://github.com/magdyezy1/CAMCP/actions/runs/36953753600) and prior X
[CI144](https://github.com/magdyezy1/CAMCP/actions/runs/36951901626) were running when checked.

Sanitized preflight `.release/tiktok-report-completion-preflight-20261002` passed every check and Railway stage:
**3,487 passed, zero failed, five local FFmpeg skips; 78.15 seconds**, four capture tests, 32 browser scripts
and 257 documents. Its **1,518 public source files** plus one generated empty sample have hash
`1c5e2ac6343ae3c45a038390a257c85f4e2f1d1955a76aba0899e09fc7158a0f`. Exact committed-source checks follow before push.

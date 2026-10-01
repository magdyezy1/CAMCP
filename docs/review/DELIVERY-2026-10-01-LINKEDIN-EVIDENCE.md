# Guided LinkedIn daily reporting evidence — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `b77e7cb`. Implementation: `37dcf45`. Batch 72 extends B18 and closes F-144 without expanding advertising write authority.

The capture wizard and `amcp_reporting` now offer LinkedIn campaign-group, campaign and creative presets. Each
first reads the bound native account and verifies its ID and reporting currency. The subsequent account-filtered
analytics read requests DAILY UTC data, the exact native pivot and explicit metric fields. Native URNs and decimal
precision are retained; names and missing metrics remain unknown. `externalWebsiteConversions` supplies the
conversion metric. Attribution windows remain a caller declaration, or `unknown`; the tool does not claim that
account conversion-rule configuration was independently fetched. The account-read and analytics request/hash
references are retained separately. Current actor/connection/account checks still precede persistence.

Empty analytics results are refused because the provider cannot distinguish no activity from missing reporting
access in that response. Non-daily/out-of-window dates, invalid native pivots, duplicate entity/day rows and partial
metadata are refused before any report is saved. LinkedIn's 15,000-element ceiling cannot become a complete report;
guided evidence has the existing tighter 10,000-row bound. The existing whole-capture limits cover both reads:
120 requests, two minutes and 32 MiB. No pagination is attempted. Recent daily presets conservatively accept the
current month and previous five calendar months, through today in UTC, to stay inside daily retention.

F-144 (medium) was reproduced against `b77e7cb`: ordinary REST.li analytics metadata with no total caused the
generic paginator to synthesize an invalid offset and then fail with `PAGINATION_LOOP`. The analytics-specific
completion check now terminates such a read after one response, and rejects continuation metadata or a response
at the provider ceiling. Other LinkedIn cursor/offset finders retain their existing pagination.

English and Arabic forms expose the native hierarchy and explain measurement limits. LinkedIn fixes the timezone
and conversion-definition fields to their request meaning while preserving prior editable declarations when
switching back to another provider. The existing identity/form/sequence fencing and explicit completeness choice
remain active. Seven new tests were observed red: six native/service/completion cases and one real-controller
case. After implementation, the focused group passed **24/24**. Locale validation covers **2,447 catalog entries /
2,350 required messages**. Full and sanitized/exact-source qualification are recorded in [PROGRESS.md](PROGRESS.md).
Ignored logs are in `.runtime/linkedin-evidence-20261001/`.
The full local suite passed **3,319 tests; 3,314 passed, zero failed, five local FFmpeg skips; 73.42 seconds**.
Sanitized preflight `.release/linkedin-evidence-preflight-20261001` passed every check/Railway stage:
**3,314 passed, zero failed, five local FFmpeg skips; 76.75 seconds**, four capture tests, 29 browser scripts and
238 documents. Its **1,452 public source files** plus one generated empty sample have hash
`6d841bfd2d8c15328bbf410a66b734ac5452399a8f8b7147a39cad3048cece0b`. Exact committed-source qualification follows.

Official sources checked on 1 October 2026 (reporting/metrics `202609`, account schema `202608`; runtime remains pinned to `202609`):

- [LinkedIn Reporting](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-09): no analytics pagination, ambiguous empty replies, element ceiling and retention constraints.
- [Metrics and query schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-09): UTC inclusive dates, local-currency spend, native pivots and conversion metric.
- [Account reads](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-08): bound account ID and currency. The September page was unavailable to the browser tool; no live-provider qualification is inferred.

Native ledgers retain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
No dependency, migration, OAuth scope expansion, new policy, provider mutation, external message or production
deployment was introduced. Synthetic native transports do not establish real provider acceptance. Browser and
assistive-technology acceptance remain unverified because CUA fails during kernel-assets initialization. Native
entity names, automatic conversion-window verification, additional dimensions/providers and comparable-reference
ingestion remain further work. The blueprint remains **13 implemented / 14 partial / 1 open**.

Batch 71 follow-through: exact HEAD `b77e7cba933b0a6c8e08acbbecdbf6176e782f77` passed every check/Railway stage
in `.release/analysis-localization-work-here-head-20261001`: **3,307 passed, zero failed, five local FFmpeg skips;
77.58 seconds**, four capture tests and byte parity for **1,449 public source files** plus one generated empty sample.
Hash: `558b8b29c9bde2e1b36f8d8c55e2a9a1d6c39baac58cbb1419751beb807c0620`.
The only branch push started [CI126](https://github.com/magdyezy1/CAMCP/actions/runs/36913808549), pending at the
latest check. CI124/125 also remained pending at this record's latest check; they are not reported as passed.

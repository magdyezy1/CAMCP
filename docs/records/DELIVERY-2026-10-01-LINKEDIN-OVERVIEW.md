---
status: record
tier: engineering
---

# LinkedIn overview evidence and safe recovery — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `588b0b3`. Implementation: `7a9f025`. Batch 73 extends B18 and closes the reproduced F-145 reporting-quality gap.

The existing LinkedIn reporting-overview collector now verifies account ID and currency, validates a single
campaign pivot per row and requires each native ALL-grain row to cover exactly the requested UTC period. It
rejects ambiguous empty results, continuation metadata, provider ceilings, duplicate campaign totals and missing
or different native date ranges. This includes old date requests that the provider rounds to calendar months.
Current actor/account authority is checked again before any native collector returns its result. Whole-job
collection counters, source request/response fingerprints, raw native fields and exact campaign IDs are retained.

F-145 (medium) was reproduced against `588b0b3`: an empty LinkedIn response, a next-page link and rows for the
wrong dates were treated as complete. Duplicate rows also passed the native collector (the downstream overview
already rejects duplicate campaign rows). Unknown conversion-rule attribution was labelled `provider configured`
and could pass recommendation gates. The collector now reports attribution as `unknown` until independently
established; a synthetic apparently efficient sales campaign receives `needs_review` instead of `scale`.

Calendar grouping preserves successful periods and marks failed empty periods explicitly. Their errors and dates
remain in source coverage; the source and snapshot are partial, affected recommendations remain held, and the
existing complete-only file-delivery gate refuses export. A failed period cannot silently become a zero day.
Historical monthly requests remain possible when native dates match exactly. No demographic or multi-pivot
analytics, estimated daily decomposition or zero filling is introduced.

New snapshots identify `campaign-source-v3`. Older LinkedIn snapshots with any collection state require a new
snapshot, preserving their counters/checkpoints and avoiding a silent upgrade of earlier evidence. An older queued
snapshot with no collection history adopts the current version before its first read. Already completed saved
snapshots remain unchanged; this does not retroactively certify their contents. Other providers' measurements and
existing pagination behavior are unchanged.

Six new tests were observed red: five baseline native/worker/recovery scenarios and one queued-version adoption
case. The related group passed **39/39**, including original guided capture, overview, calendar and file-delivery
tests. All provider transports were synthetic. Full and sanitized/exact-source checks are recorded in
[PROGRESS.md](PROGRESS.md); logs are retained in `.runtime/linkedin-overview-20261001/`.
The full local suite passed **3,325 tests; 3,320 passed, zero failed, five local FFmpeg skips; 78.54 seconds**.
Sanitized preflight `.release/linkedin-overview-preflight-20261001` passed every check/Railway stage:
**3,320 passed, zero failed, five local FFmpeg skips; 78.28 seconds**, four capture tests, 29 browser scripts and
239 documents. Its **1,454 public source files** plus one generated empty sample have hash
`75dc1d2cb5274ade5f9f0591173f39e4a3695bf0e1aa2f5fd9ff965170b52384`. Exact committed-source qualification follows.

The [official reporting constraints](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-09)
and [UTC metric schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-09)
were checked during batch 72. The product now verifies response dates rather than assuming that the provider
honored the requested window. Native live acceptance and deployed behavior remain unverified.

Native ledgers retain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
No dependency, storage migration, OAuth expansion, new policy, provider mutation, external message or production
deployment was introduced. Browser/keyboard/assistive-technology acceptance remains unverified because CUA fails
during kernel-assets initialization. Additional providers/dimensions, automatic comparable-reference ingestion,
native entity names and independent conversion-window verification remain work under the 28-package blueprint.
The matrix remains **13 implemented / 14 partial / 1 open**.

Batch 72 follow-through: exact HEAD `588b0b38ee9b4c2ca010fc0c2e5b52254477aca1` passed every check/Railway stage
in `.release/linkedin-evidence-work-here-head-20261001`: **3,314 passed, zero failed, five local FFmpeg skips;
77.55 seconds**, four capture tests and byte parity for **1,452 public source files** plus one generated empty sample.
Hash: `568bf608461cbd3b304dbef2d7968a5c4ec793a85b1bfd25f5b1b6c4e29d7067`.
The sole branch push started [CI127](https://github.com/magdyezy1/CAMCP/actions/runs/36915865450), pending at the latest check.
[CI124](https://github.com/magdyezy1/CAMCP/actions/runs/36909015724) passed on `ef551fa`: host and Docker each
passed **3,297 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and read/write container
smoke. Job `110526719022` uploaded artifact `11189361157`.
[CI125](https://github.com/magdyezy1/CAMCP/actions/runs/36911219779) also passed on `f31aee7`: host and Docker
each passed **3,306 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container
smokes. Job `110534038605` uploaded artifact `11190088824`. CI126 remains pending at its latest check.

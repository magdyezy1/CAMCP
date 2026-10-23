# Comparable retained reports and exact reconciliation — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `0f4d615`. Batch 74 extends B18 and closes reproduced findings F-146/F-147.

The Reports page now compares a retained report with another accessible retained source. The backend requires
the same account, dates, currency, timezone, attribution, conversion definition and complete evidence. Guided
reports require the same native preset/grain and field mapping. Overview captures require the same frozen
definition and semantic group. Unknown settings, incompatible source kinds and self-comparison are refused.
Both sources are authorized before use and again before saving the result. No new provider request is made.

The result retains both IDs, source hashes and capture times, exact additive decimal differences and explicit
per-metric tolerances. Missing values remain unknown; reach and frequency cannot be added. `context_compatible`
means retained measurement declarations align; `independently_verified:false` remains explicit. Matching saved
reports does not independently establish provider attribution rules or agreement with an external native export.
Manual reference totals preserve their existing `matched` result but now clearly mean numerical agreement only.

English and Arabic tables show current totals, reference totals, differences, tolerances and individual results.
A nonzero difference inside a declared tolerance is labelled accordingly. Exact decimal strings retain their
digits and direction, including values beyond JavaScript safe integer range. Raw evidence keeps original keys.
Form edits invalidate prior analysis/comparison results. Older attempts, report selections and identity changes
cannot expose stale results or failures; current errors still surface. Already submitted local writes are not retried.

Twelve tests were added: ten were observed red against their preceding implementation, with two additional
authority/tolerance boundary tests. The focused group passed **14/14**. These cover both languages, exact large
decimals, unknown/mismatched context, foreign/revoked scope, source lineage, self-comparison, explicit tolerance,
form/result ordering and identity changes. Logs: `.runtime/report-reconciliation-20261001/`.
Full and sanitized/exact-source qualification is recorded in [PROGRESS.md](PROGRESS.md).
The full local suite passed **3,337 tests; 3,332 passed, zero failed, five local FFmpeg skips; 72.96 seconds**.
Sanitized preflight `.release/report-reconciliation-preflight-20261001` passed every check and Railway stage,
four capture tests, 29 browser scripts and 240 documents. Its **1,458 public source files** plus one generated
empty sample have hash `c1e20eb788fe3540f5a30148e36c4856dcc3862f8be6ce32604a9a7774a38a23`.
Exact committed-source qualification follows before push.

Native ledgers retain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
There is no new dependency, migration, provider mutation, permission expansion, external message or deployment.
The private root sample is not read. VM/controller checks do not establish browser/keyboard/assistive-technology
acceptance; CUA remains unavailable before initialization. Additional providers/dimensions, external reference
imports and independently verified conversion windows remain under B18. The matrix remains
**13 implemented / 14 partial / 1 open**.

Batch 73 follow-through: exact HEAD `0f4d6156ab64d1ea981b87fd121180039da149a5` passed every check/Railway stage
in `.release/linkedin-overview-work-here-head-20261001`: **3,320 passed, zero failed, five local FFmpeg skips;
78.68 seconds**, four capture tests and byte parity for **1,454 public source files** plus one generated empty sample.
Hash: `93dd72d287023d51eab3cdd7c13ac756e4fd5c7648b8483135461a689ebedf46`.
[CI128](https://github.com/magdyezy1/CAMCP/actions/runs/36917584932) and CI127 remain pending at the latest check.
[CI126](https://github.com/magdyezy1/CAMCP/actions/runs/36913808549) passed on `b77e7cb`: host and Docker each
passed **3,312 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110542722534` uploaded artifact `11190745978`.

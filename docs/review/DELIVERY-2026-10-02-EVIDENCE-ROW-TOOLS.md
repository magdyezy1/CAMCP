# Retained evidence search and column controls — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `68ae066`. Batch 97 extends B15/B18/B24.

Operators can find an entity, date or search term across a complete retained report and choose which mapped columns
to show, in English or Arabic. Search is literal, case-insensitive and bounded to 150 plain-text characters. It scans
the existing at-most-10,000 rows before the existing 50-row website pagination. No provider read, collection or saved
change occurs. Numeric native IDs, exact decimal strings, unknown metrics and escaped text retain their original meaning.

`amcp_reporting get` accepts `row_query`. `row_count` remains the original retained count; `matched_row_count`
and the trimmed `row_query` describe the displayed subset. The website shows matching versus source counts and
distinguishes no matches from an empty report. Metrics and private source metadata are not searched. Totals, analysis,
source hashes and the all-row Excel export continue to represent the full original report, explained beside the controls.
Clearing an applied filter restores unfiltered paging; clearing an unapplied draft requires no read.

Column visibility is temporary per open view. At least one column remains visible, and Show all columns resets the
selection without refetching. Open column controls and their keyboard focus survive changes and paging. Unsubmitted
search text survives pending page reads. Busy controls prevent duplicate requests; failures remove stale rows, disable
column actions until retry succeeds, and focus the retry. Current navigation, identity, report selection, account/login,
source hash, original/matching counts and exact page shape remain checked. Late replies cannot repaint a departed view.
Unfiltered responses cannot silently shrink the original source count. Backend access is rechecked against the retained
account and tenant before returning any matches.

Twelve new regression tests include four backend cases, seven interface cases and one real MCP SDK journey. Ten cases
were observed red before their implementation; two additional boundary/contract controls also pass. Focused checks passed
**46/46**. The SDK journey made **seven schema-validated calls / 24,000 structured response bytes / zero provider requests
or writes**, covering Arabic matching, matching-row pagination, exact large IDs, clearing, removed account access and
key revocation. The backend boundary locates the final exact ID in 10,000 retained rows without collecting again.

Root regression passed **3,551 tests / 3,546 passed / zero failed / five local FFmpeg skips; 90.69 seconds**.
An initial invocation omitted the configured Python interpreter and failed the WSDL parser environment check; the
complete suite was rerun with the bundled interpreter. Static checks cover 32 browser scripts and 2,695 selected Arabic
messages. Evidence: `.runtime/evidence-row-tools-20261002/`. VM/SDK checks are not real-browser, assistive-technology,
live-provider or deployed acceptance.

Batch 96 exact committed-source checks and Railway passed on `68ae066`: **3,534 passed / zero failed / five local
FFmpeg skips; 89.12 seconds**, four capture tests, **1,534 public files + one generated empty sample**;
source hash `71912b5c5aa4ca52796ecdd27e5fcd1b3289b28bf3b1a108edb5c13094030551`.
The change was pushed only to Work-here; [CI151](https://github.com/magdyezy1/CAMCP/actions/runs/36962798743) was
running when checked. Google's [CI150](https://github.com/magdyezy1/CAMCP/actions/runs/36961537538) was also running.

The consent/backup [CI149](https://github.com/magdyezy1/CAMCP/actions/runs/36960088574) succeeded on `1a6d548`:
host and Docker each **3,521 passed / zero failed/skipped**, required FFmpeg, four capture tests, Railway and both
container smokes; job `110691643745`, release-evidence artifact `11208810377`.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Additional reporting dimensions/providers, broader
workflow expansion and actual-browser/accessibility qualification remain tracked separately.

Sanitized preflight `.release/evidence-row-tools-preflight-20261002` passed all stages and Railway:
**3,546 passed / zero failed / five local FFmpeg skips; 89.39 seconds**, four capture tests,
32 browser scripts, 2,695 selected Arabic messages and 263 documents. Its **1,536 public source files**
plus one generated empty sample have hash `a4f32ac5a533b19a59a23a182c3b5d9a2a2628ba3b0582da69d36757a9b64a06`.
Exact committed-source qualification follows before the sole Work-here push.

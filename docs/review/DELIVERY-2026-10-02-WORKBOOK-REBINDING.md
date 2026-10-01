# Reviewed workbook moves — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `b24576c`. Batch 79 extends B13, B15 and the localized website workflow.

Operations now lets an operator move one saved query to an existing workbook association. Open the query,
choose **Move saved query**, search/page currently accessible workbooks, choose an exact destination and review
both saved spreadsheet IDs and the schedule impact. Confirmation moves the query and all linked schedules in
one transaction. Every schedule is paused for separate inspection/resume. Query configuration, schedule clocks,
stored authority and existing jobs retain their original values. One local report is prepared, not submitted.
The result links to the original query, its schedules and the prepared run. Both English and Arabic are authored;
native IDs and request values are unchanged. No external spreadsheet is accessed, renamed or written.

MCP uses `preview_report_query_move {id,query_version,target_binding_id}`, followed by `move_report_query`
with the same fields, returned `rebinding_version` and `confirmed:true`. The version binds the original query,
source/destination association revisions, all their query memberships/revisions, and every linked schedule revision.
Current access to every query in both associations is required; an empty destination remains creator/admin-only.
The transaction rechecks current authority and versions. Targets have a 500-query ceiling; moves support up to
100 schedules, each at most 64 KiB. Inconsistent legacy schedule associations or active-state metadata are refused.
Read-only users cannot save. Duplicate/stale submissions cannot create another run or move a different revision.
An injected audit failure verifies complete transaction rollback. Audit metadata records source/target IDs and
affected counts without private preferences, URLs, query contents or stored actor authority.

**F-150 (medium), confirmed:** the baseline legacy `update_reporting_query` moved a query to a new association
while leaving its schedule attached to the old one and active. A second baseline probe moved a granted query out
of a source association containing another account the actor could not access. The shared legacy mutation now
checks both associations, moves every schedule and pauses active scheduling atomically, including when query
configuration changes in the same call. Legacy dry runs disclose affected counts. This is a local consistency
and authorization defect; it is not evidence of a deployed data leak or an external spreadsheet mutation.

Eleven new tests: seven backend tests observed red, three initially missing-controller UI tests, and one additional
real-SDK journey. Focused **46/46** passed. The protocol journey used **7 tool calls / 10,409 structured bytes /
zero provider requests**, following discovery, review, move and a separate schedule review/resume. Website tests
cover explicit target selection, HTML escaping, confirmation invalidation and departed route/identity responses.
Static checks cover **32 browser scripts** and **2,477 selected Arabic messages**. These are synthetic controller/
SDK checks, not actual browser, deployed spreadsheet or live account acceptance.

The initial root invocation omitted the configured Python interpreter and failed the WSDL subprocess. That run
also encountered the previously observed Windows backup-staging cleanup EPERM. The environment was corrected;
the existing backup/WSDL focused suites passed **16/16** without backup code changes. The intermittent cleanup
cause remains unresolved and is not presented as fixed. The final full/sanitized results are recorded below.
An early rollback test injected failure into every audit event, including the service error log; its harness was
corrected to fail only the mutation audit so the actual transaction boundary could be verified.
Logs: `.runtime/workbook-rebinding-20261002/`.

Final root suite: **3,383 tests; 3,378 passed, zero failed, five local FFmpeg skips; 73.31 seconds**.
Sanitized and exact committed-source qualification follows before push.

Sanitized preflight `.release/workbook-rebinding-preflight-20261002` passed every check/Railway stage:
**3,378 passed, zero failed, five local FFmpeg skips; 81.22 seconds**, four capture tests, 32 browser scripts
and 245 documents. Its **1,483 public source files** plus one generated empty sample have hash
`9972291c9098a8cd5387fa831badc38383f6d4a22f47cee680d49af44eba2f97`. Exact committed-source checks follow before push.

Native ledgers stay **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Binding retirement, full telemetry and historical
opaque-job scope adapters remain under B13. No dependency, schema migration, provider mutation, permission
expansion, external message, production deployment or private-root-sample read is introduced.

Batch 78 follow-through: exact HEAD `b24576c862a62884f67c0976bc9bac5ea67975dc` passed every check/Railway stage
in `.release/query-scaling-work-here-head-20261002`: **3,367 passed, zero failed, five local FFmpeg skips;
78.63 seconds**, four capture tests and byte parity for **1,478 public source files** plus one generated empty sample.
Hash: `ae705a32b8e89c0b333650d77a4f5c78288a10358f42ab16f4ba06e345962eb9`.
The sole branch push started [CI133](https://github.com/magdyezy1/CAMCP/actions/runs/36930848046), pending at the
latest check, as is [CI132](https://github.com/magdyezy1/CAMCP/actions/runs/36928791382).
[CI131](https://github.com/magdyezy1/CAMCP/actions/runs/36926690036) passed on `d03fc32`: host and Docker each
passed **3,357 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110585657078` uploaded release-evidence artifact `11195771815`.

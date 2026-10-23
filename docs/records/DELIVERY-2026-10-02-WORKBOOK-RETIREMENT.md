# Reversible workbook retirement — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `61a5a36`. Batch 80 completes the remaining binding-lifecycle controls within B13.

Workbook setup now lets its creator or a workspace administrator review and retire an empty local association,
then restore the same record later. Any linked query or schedule, including an orphaned or paused schedule,
blocks the change. Move queries and their schedules first using the separately reviewed move workflow.
The website shows active associations by default and offers Active/Retired/All filters. A retired detail remains
inspectable within current access, explicitly labels its state, disables renaming and offers restoration.
Successful name/state changes refresh the current list. English/Arabic confirmations retain the exact spreadsheet ID.

MCP uses `preview_report_binding_state {id,binding_version,active}`: `false` means retirement and `true`
means restoration. Confirm `save_report_binding_state` with unchanged fields and `confirmed:true`.
The transaction rechecks current role, creator/admin access, association/query version and absence of schedules.
Retired associations cannot accept new queries, query moves, legacy binds, preference changes or name changes.
They are excluded before active-list and empty-bootstrap limits, while `report_bindings state:retired|all`
and exact detail links remain available to authorized users. Existing records without retirement metadata stay active.
No jobs are created by lifecycle changes; no query, schedule, report run or external spreadsheet is deleted.

Only a retirement timestamp/actor and the normal metadata revision/update time are recorded. Restoration removes
the retirement fields. Saved IDs, names, URLs and private preferences stay intact; these private values are never
included in the lifecycle preview or list/detail projection. The audit records the local state transition and actor.
Native account grants remain independent. No external spreadsheet access is verified or changed.

Schema version remains 2 and no automatic database migration or dependency change is required. Older application
releases do not enforce the retirement marker; any deliberate code rollback must account for that behavior.
This work did not deploy or downgrade a running database.

Eight new tests: five backend cases observed red, two new UI cases plus a strengthened existing filter case
observed red, and one additional real-SDK journey. Focused **52/52** passed, including the index/backup checks,
legacy setup and reviewed moves. The SDK retirement/restoration journey used **5 calls / 6,578 structured bytes /
zero provider requests**, and created no jobs. UI cases cover exact state/versions, English/Arabic confirmation,
search state and invalidated approval. Static checks cover **32 browser scripts** and **2,490 selected Arabic
messages**. This is local synthetic evidence; actual browser, assistive-technology and deployed acceptance remain separate.
Full and sanitized qualification is recorded below. Logs: `.runtime/workbook-retirement-20261002/`.

Final root suite: **3,391 tests; 3,386 passed, zero failed, five local FFmpeg skips; 78.80 seconds**.
Sanitized and exact committed-source qualification follows before push.

Sanitized preflight `.release/workbook-retirement-preflight-20261002` passed every check/Railway stage:
**3,386 passed, zero failed, five local FFmpeg skips; 78.43 seconds**, four capture tests, 32 browser scripts
and 246 documents. Its **1,485 public source files** plus one generated empty sample have hash
`a4ea57719a8ffd84cc33d98b129be8335c3e8cebb02dfa94efbd81c850e99434`. Exact committed-source checks follow before push.

No new defect ID is assigned to this product expansion. Native ledgers remain **3,247 actions / 167 families /
1,712 native reads / 800 reviewed writes / 502 blocked writes**. The blueprint remains **13 implemented /
14 partial / 1 open**; complete audit telemetry and opaque historical-job scope adapters remain under B13.
No external message, provider mutation, OAuth expansion, production deployment or private-root-sample read occurred.

Batch 79 follow-through: exact HEAD `61a5a3600daa543ec7c9fd9bb9d630ca4649d23b` passed every check/Railway stage
in `.release/workbook-rebinding-work-here-head-20261002`: **3,378 passed, zero failed, five local FFmpeg skips;
81.99 seconds**, four capture tests and byte parity for **1,483 public source files** plus one generated empty sample.
Hash: `50ecf8b3263f840298e7dc7e47e3f2e185b0cdc492be0f2a8adb8467a0d892d8`.
The sole branch push started [CI134](https://github.com/magdyezy1/CAMCP/actions/runs/36935041343), pending at the
latest check, as is [CI133](https://github.com/magdyezy1/CAMCP/actions/runs/36930848046).
[CI132](https://github.com/magdyezy1/CAMCP/actions/runs/36928791382) passed on `fd75692`: host and Docker each
passed **3,369 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110592619820` uploaded release-evidence artifact `11196721425`.

# Workbook schedule operations — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `2295906`. Implementation: `bc2b418`. Batch 58 extends the partial B13 Operations package.

## Delivered behavior

Operations now includes workbook schedules as its eighth kind, `workbook_schedule`. The Schedules page links to
this filtered view. Each item opens its original schedule with the current saved query revision, account/login,
clock, active/paused state and three future clock occurrences. The detail is a bounded SQL metadata projection;
it does not load complete queries, encrypted creator bindings or raw error messages. Latest enqueue activity
updates the feed timestamp. Historical last-run links independently require access to that run's retained scope.

The website provides named fields for hourly, daily, weekly and monthly clocks and an explicit IANA timezone.
Irrelevant fields are hidden and disabled so they cannot interfere with native form validation. A server preview
validates the proposed clock before the confirmation, returning exact field changes and three future occurrences.
The confirmation names the current account and query revision. Cancelling leaves the schedule unchanged.
Late responses, navigation and identity changes invalidate old details and confirmations. Labels are escaped,
errors stay in the current view and the refreshed heading receives focus.

Saving requires an operator, explicit confirmation and a version that binds both schedule and query revisions.
The transaction rechecks current grants and preserves query identity and workbook binding. Pausing stops future
enqueues without cancelling queued/running work. Resuming binds the current creator's access and calculates the
next future occurrence; no catch-up job is created. Existing jobs retain their own query snapshot. The current
saved query controls future jobs and report date windows, separately from the schedule's clock timezone.
Monthly dates clamp to the last day of shorter months, nonexistent DST times are skipped, and repeated local
times run once through the existing calendar engine. Paused previews describe possible clock times, not queued work.

## MCP contract

`amcp_workspace report_schedule` takes `id` and returns metadata plus `schedule_version`.
`preview_report_schedule` takes that `id`, version, `active:boolean`, and
`schedule:{name,timezone,schedule_kind,minute,hour,weekday?,day?}`. It returns validated canonical settings,
changes, and three future clock times without mutation. `save_report_schedule` accepts the same fields with
`confirmed:true`. A changed schedule or query returns `STALE_REPORT_SCHEDULE`; inspect and review again.
Readers can inspect and preview but cannot save. Current connection withdrawal or ambiguous account scope
denies inspection, preview and saving. No action creates an advertising request or external spreadsheet destination.

## Verification

Five backend regressions cover metadata-only reads, current grants, other tenants, readers, query-version races,
malformed clocks, preview without mutation, unchanged queued jobs, current-creator rebinding, hidden historical
results and latest-enqueue timestamps. Two browser-controller regressions cover escaping, current/proposed clocks,
confirmation, cancellation, disabled fields and stale identity/route responses. A four-call MCP SDK journey
validates advertised schemas, equivalent text/structured envelopes, preview without mutation and a confirmed
pause of the original ID, with about 6.6 KB of structured responses and zero provider requests. The schedule,
preview and activity-timestamp tests were observed failing before their respective implementation changes.

The focused suite passed **29 tests, zero failures**. The full local suite passed **3,189 tests: 3,184 passed,
zero failed, five local FFmpeg skips; 98.55 seconds**. A synthetic, in-memory browser fixture includes active and
paused schedules. Actual visual/browser acceptance was not completed: the browser control tool failed before
initialization with `failed to write kernel assets: The system cannot find the path specified (os error 3)`, including
after one runtime reset. Controller tests and static asset checks do not substitute for visual acceptance.

Sanitized release, generated artifacts, exact committed-source checks and CI evidence are recorded in
[PROGRESS.md](PROGRESS.md). Logs are retained in ignored `.runtime/workbook-schedules-20261001/`.

## Remaining scope

The matrix remains **11 implemented / 15 partial / 2 open**. B13 still needs complete audit telemetry, broader
query/binding management and account-scope adapters for historical path-only/opaque-body-only configurations.
This editor manages existing schedules; it does not rewrite their saved queries or add external delivery.
New desktop/mobile visual acceptance, external MCP clients, live provider acceptance, deployed worker behavior
and production workload capacity remain unverified for this batch.

No dependency, migration, native family, ledger classification or OAuth permission changed. No real credential,
live advertising action, external notification, production deployment or DNS change was used.

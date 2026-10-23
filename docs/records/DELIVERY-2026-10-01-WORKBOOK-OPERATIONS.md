# Workbook report operations — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `b033811`. Implementation: `66bcf89`. Batch 57 extends the partial B13 Operations package.

## Delivered behavior

Operations now shows workbook reporting runs alongside campaign plans, uploads, Overview snapshots, exports,
Overview schedules and incidents. The seventh kind, `workbook_report`, shares scoped search and bounded keyset
continuation. Prepared runs appear under Attention; queued runs are already waiting for a worker. Each record opens
its original run rather than constructing a replacement. New runs retain their query name; older runs label a
fallback from the current query as such, while scope and revision always come from the retained job.

The detail page shows status, original query revision, account/login, attempt count and whether results are retained.
Operators can resume a prepared, failed or cancelled run after explicit confirmation. The server checks the displayed
version transactionally, rebinds current creator authority and queues the same ID. A stale confirmation, reader role,
revoked connection, foreign tenant, non-report job, conflicting account alias, empty normalized ID or missing scope
cannot authorize recovery. Queued, running and completed work is not restarted. A query rejected as a write requires
a corrected new query. The worker still independently classifies reads and checks creator authority and its lease.
Rolling date windows resolve at execution rather than promising the original calendar dates on every retry.

## Status and access contracts

`amcp_workspace report_run` takes `id`. `resume_report_run` additionally requires its `run_version` and
`confirmed:true`. The legacy `amcp_native_action get_reporting_run_status` now returns the same bounded summary.
Call `get_reporting_run` explicitly for retained input/results. Both legacy reads and `execute_reporting_run` now
check the original run's current account access, rather than accepting tenant membership alone. The saved query
may be edited or removed without changing the run's scope. A workbook binding continues to represent local output;
it does not establish delivery to Google Sheets.

The metadata query extracts only scalar references, short names, states, error codes and explicit account anchors
inside SQLite. It never loads report results, complete job inputs, actor bindings, lease tokens or raw errors into
Node for status/feed responses. Native account aliases share the compiler's definitions, including older Google
`customer_id` and structured parameter bags. Conflicting account/login aliases are refused. Missing connection IDs
must resolve unambiguously under the existing connection-selection policy. Scope found only in a resource path,
opaque JSON body string or provider response is deliberately not inferred. Such old records require a newly scoped
query; no historical job is relabeled or deleted.

## Website, MCP and evidence

The website filters workbook runs and opens an original-run detail above the feed. Detail links default the feed to
workbook runs. Refresh, Cancel and Resume preserve the original ID. Confirmation describes current access and rolling
dates. State changes remove an obsolete resume control; late responses, detached views and identity/route changes
cannot paint old details or execute an old confirmation. Controls wrap on mobile, labels are escaped and refreshed
headings receive keyboard focus. Supporting references and MCP result/status instructions remain expandable.

Six backend regressions cover metadata-only reads, original-snapshot scope, every legacy status/result/execute entry
point, revision-bound recovery, current grants, non-report jobs, malformed/conflicting aliases, bounded output and
continuation after more than 500 hidden candidates. Two browser-controller regressions cover confirmation and
stale lifecycle behavior. A four-call MCP SDK journey validates advertised schemas, identical structured/text
envelopes, original-run recovery and zero provider requests. The first full run exposed an older Google alias
compatibility failure; it was repaired using shared compiler aliases, and the existing revocation/recovery test
passes unchanged. The initial WSDL check also needed the configured Python runtime; final qualification uses it.

The corrected local suite passed **3,181 tests: 3,176 passed, zero failed, five local FFmpeg skips; 86.60 seconds**.
Sanitized release, generated artifacts, exact committed-source qualification and CI evidence are recorded in
[PROGRESS.md](PROGRESS.md). Browser evidence uses an in-memory, synthetic fixture with no external egress. Logs and
screenshots are retained in ignored `.runtime/workbook-operations-20261001/`.

## Remaining scope

The matrix remains **11 implemented / 15 partial / 2 open**. B13 still needs complete audit telemetry, management of
legacy schedule definitions and additional scope adapters for historical jobs that have no structured account anchor.
This metadata feed is mutable; it is not an immutable audit log or a point-in-time snapshot. External MCP clients,
live providers, actual deployed workers and production workload capacity were not qualified by this batch.

No dependency, database migration, native family, ledger classification or OAuth permission changed. No real
credential, live advertising action, external notification, production deployment or DNS change was used.

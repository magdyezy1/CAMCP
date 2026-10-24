---
status: reference
tier: operator
---

# Health and diagnostics

What `/healthz` and the owner health view report, and the request IDs, job lines and timings that follow one request or job. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

`/healthz` is anonymous and answers at most once per ten seconds. It reports only the state of each check, never
paths or numbers:

- `database`: a read answers. `database_write`: one small committed write to the single-row `health_probe` table
  (`ok`, `busy`, `full` or `failed`). The probe runs no cleanup scan; record expiry runs from the maintenance timer at
  most once a minute.
- `storage`: `ok`, `low` (free space below the media admission floor), `full` (under 1 MiB free, or the write failed
  for lack of space), `not_persistent` (the production start-up guard ran with the ephemeral override) or `unknown`
  (free space cannot be read, as for an in-memory database).
- `media_retention`: `stale` when the 30-minute expiry last succeeded more than four 15-second intervals ago.
- `mcp`: the offline help completes through a real MCP client and server in memory.

The status is `unavailable` (503) when a read or the committed write fails, storage is full, or MCP fails. It is
`degraded` (200) on write contention, low or ephemeral storage, stale media expiry, or unknown storage in production.
Railway runs the health check only at deploy time, so point an external uptime monitor at `/healthz` every minute and
alert on `degraded` or `unavailable` (an owner step).

Owner health (`amcp_workspace health`) and the support bundle add the deployment's storage figures (volume free and
total bytes, database, write-ahead-log and free-list bytes, page size, admission floor, mount), the release identity,
Node, SQLite and FFmpeg versions, uptime, schema version, `BEGIN` busy retries and a process-local list of the last 20
kinds of SQLite failure (name, code, surface, first and last time, count; never messages or SQL).

### Correlation and runtime identity

Metadata-only signals for following one request or job across the website, MCP, the worker and the audit (OPS-08):

- **Request IDs.** Every HTTP response carries `X-AMCP-Request-Id`, a UUID the server generates (a client's value is
  never echoed or trusted; browsers may read it on allowed MCP origins). The `/mcp` refusal and failure lines name it as
  `request_id`, a website failure uses the same ID in its body and log line, and an `mcp_tool_failed` line written
  inside that HTTP request adds it as `http_request_id` beside `requestId`, the audit record's ID.
- **Job lines.** The worker writes one `job_started` (`job_id`, `kind`, `attempt`) and one `job_finished` line per
  leased job, adding `duration_ms`, `outcome` (`complete`, `retry_scheduled`, `failed`, `released` or `lease_lost`) and
  the error `code`. Never the input, result, workspace, message or details.
- **Event-loop delay.** The HTTP server and a long-running worker sample `perf_hooks.monitorEventLoopDelay` (20 ms
  resolution). Owner health and the support bundle show `event_loop` for the process that answered: mean, p50, p99 and
  maximum delay in milliseconds for the current fixed 15-minute window and the one before. This is the baseline for
  moving collection, schedules or media out of the HTTP process; none is recorded yet (owner step).
- **Stage durations.** `operations.worker.stages.<stage>.duration` adds runs and the last, maximum and mean duration of
  each worker stage since the loop started.
- **Start line.** `http_listening` (and `runtime_started` for `npm run worker`) adds the release identity, Node, SQLite
  and FFmpeg versions, the schema version, minimum and reader versions, `migration_ms` and the ledger steps this start
  applied. It waits at most 1.5 s for the FFmpeg probe, otherwise says `checking`; `/healthz` never waits for it.
- **Recent job errors.** Owner health's newest job errors read the `jobs_tenant_updated` index in order instead of
  scanning and sorting every job.

An MCP tool call that fails on SQLite capacity returns `STORAGE_FULL` (503), and one that fails on contention returns
`DATABASE_BUSY` (503; `read_retry_safe: true`, but a write is never resubmitted: inspect its receipt). Any other
unexpected failure stays `INTERNAL_ERROR`. Every envelope keeps its request ID. When the failure's own audit append
fails too, the envelope says `audit_recorded: false` rather than pointing at an audit row that does not exist. Each such
operator-relevant failure writes one `mcp_tool_failed` log line (request ID, tool category, code, status, audit state
and the SQLite diagnostic), because JSON-RPC responses are HTTP 200 and the `/mcp` status log does not see them.

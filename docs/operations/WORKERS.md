---
status: reference
tier: operator
---

# Workers, schedules and provider pacing

The background workers and schedules, and how provider requests are paced and their quotas shared. Two sections of the [operations runbook](../OPERATIONS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

## Workers and schedules

Both the embedded HTTP worker and standalone `npm run worker` use the same stage loop. Schedule,
mail and job-stage failures emit only stage/code/count/timestamp metadata and wait one second
before a new continuous cycle. Successful work drains immediately; idle cycles wait one second.
`npm run worker -- --once` runs one cycle and propagates a failed stage, so its exit remains
unsuccessful. The original one-shot exception presentation is unchanged. Shutdown waits for an
already awaited stage and starts no later mail/job stage or claim once its stop flag is observed.
Existing lease, authority, uncertain-mutation and listener cleanup rules remain. See
[local qualification and platform limits](../records/DELIVERY-2026-10-05-WORKER-LOOP-RECOVERY.md).

Each stage keeps its own failure state. A stage that has been failing for more than ten seconds backs off
(2 s, 4 s, ... at most 60 s, with jitter that only shortens the wait) while the other stages keep running; a
success resets it. SQLite "full" (primary code 13) pauses every stage, since each one writes, and a small storage
probe runs every 30 seconds until a write succeeds (`worker_storage_paused` and `worker_storage_resumed` lines).
The log carries a stage's first failure at once and then at most one `worker_stage_failures` summary per stage per
minute. Owner health shows `operations.worker.stages` for the worker loop of the process that answers (the embedded
worker on Railway): each stage's state, consecutive and total failures, last code and next attempt.

Shutdown (SIGTERM or SIGINT) is graceful. The worker takes no new job and logs `shutdown_started`. A running
read-only job (`report`, `report_overview`, `report_file_export`, `write_verification`) goes back to the queue
at once, available a second later and without counting the attempt, and a report's collection budget stops charging
time for the downtime (`jobs_released`). A job that may be mid-mutation (`sheets_export`, `media_upload`,
`campaign_run` and any other kind) is never interrupted: the process waits for it. A `campaign_run` job is the
server run of an approved plan of uploads (`amcp_campaign run_background`, MED-03): it runs as the person who queued
it, one plan per person at a time (a per-person lock renewed while it runs), yields between uploads about every 20
seconds or when media capacity is busy (requeued, not failed; `CAMPAIGN_RUN_CONTINUES` while it waits, shown as
`running`), and stops after 500 turns with `BACKGROUND_RUN_TURN_LIMIT`. A background run is never queued twice for one plan: the
check and the queueing happen in one transaction. Like every job that may be mid-mutation, a `campaign_run` whose
worker process stopped twice while running it (two crashes or hard restarts during its turns) is set aside as failed
with `LEASE_EXPIRY_LIMIT` (`crash_quarantine`): the plan shows the push stopped, and the person runs it again; uploads
already done stay done and each remaining upload keeps its own review and key. `AMCP_SERVER_PUSH=false` refuses new
background runs (`BACKGROUND_RUN_DISABLED`) and returns the website push to driving each row from the page. It exits 0 (`shutdown_completed`) when everything has
settled, or 1 (`shutdown_deadline`) after `AMCP_SHUTDOWN_GRACE_MS` (default 25000, from 1000 to 600000). Keep the
platform's stop window above the grace period: on Railway, set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` to at least
30 (an owner setting, recorded with the deploy settings).

Run `npm run worker` in a separate process on the same host/database. Jobs acquire 60-second leases, renew every 15 seconds, and require a matching lease token for completion. A job of any kind whose lease expires returns to the queue, and a stale worker cannot overwrite a newer result. Each expiry is counted, audited (`job_lease_expired`) and recorded as `LEASE_EXPIRED` on the job: the first is available at once (the worker died), later ones wait 5 s, 10 s, 20 s and so on up to five minutes. At the fifth expiry, or after two expiries of leases taken by another process boot that has stopped heartbeating (the job may be crashing its worker; a lease of a second worker process that still heartbeats is only slow and never counts as a crash), the job fails with `LEASE_EXPIRY_LIMIT`; inspect it, then resume it explicitly, which resets its attempts and expiry counters. Provider writes stay protected by their idempotency claims either way. Failed jobs retain their error. A prepared run never executes until activated. Reactivating a complete run does not repeat it; save/update a query or prepare a new run to request a new execution.

An Overview report saves its whole-job collection counters (written before every request) in one
`overview_report_budget` document, and each source's progress in `overview_checkpoint` documents: one per source and,
for daily, weekly or monthly grouping, one per calendar period (OPS-08). A save therefore writes only its own small
document instead of re-reading and rewriting the whole report with every row collected so far. A finished source keeps
one result document, and the snapshot assembles the rows once. Reports started by an earlier release resume from their
inline counters and checkpoints; nothing is migrated. The first save marks the report's inline counters as version 2,
so an older release refuses to resume it (`REPORT_DEFINITION_CHANGED`) rather than collect again without the counters.
Deleting a report (retention, deletion, disconnect) removes its parts in the same statement.
`npm run benchmark:report-checkpoints` measured one counter save at 25,000 retained rows on the review workstation
(2026-10-11): 21.3 ms p50 and 3.3 MB rewritten in the earlier layout, 0.09 ms and 862 bytes split, about the same as
with no rows (0.07 ms). The deployed before-and-after measure is the event-loop p99 during a large report (owner step).

Native jobs aggregate up to 25 pages and fail with REPORT_TRUNCATED if more remain. Split such queries before rerunning. JSON endpoints reject empty, malformed, null or scalar HTTP success payloads; endpoint-specific no-content or non-JSON handling must be added explicitly before implementing those routes. Reddit additionally validates request and response bodies against its saved official schemas. See docs/REDDIT.md for supported behavior. The CLI verification report excludes raw vendor response contents, but the local audit database retains redacted outcomes and must be protected as sensitive operational data.

Schedules use local IANA clock time, and enqueue atomically with the next-occurrence update. A missed occurrence is coalesced into one current run. Generic query_config accepts explicit date ranges or `{preset:"last_complete_days",days:7,timezone:"Africa/Cairo"}` under date_range; native gateway requests preserve their explicit dates. A local time that a spring DST change skips runs at the first valid time after it (for example 00:30 in a 00:00→01:00 gap runs at 01:30); autumn repeated local occurrences are deduplicated. Computing the following occurrence never drops or pauses the due run: if none is found, the schedule stays active with a `SCHEDULE_UNRESOLVED` warning (an Operations attention item) and its clock is re-evaluated after 6 hours. `AMCP_SCHEDULE_DST_POLICY=skip` restores skipping (with widened look-ahead). Each long-running worker logs a `worker_clock` line with the Node time-zone database (`tz_version`) and ICU version. Reporting Overview separately supports independent daily/weekly/monthly Sheets delivery schedules, owned destination tabs and content-bound delivery recovery; see [reporting setup](../REPORTING-OVERVIEW.md). Their deliveries run as separate export jobs after collection; a failed delivery marks its schedule for attention, and repeated non-retryable failures pause it (`AMCP_SCHEDULE_DELIVERY_PAUSE_AFTER`, default 3; see [scheduled delivery](../REPORTING-OVERVIEW.md#scheduled-delivery)). Selected report retention, owned destination recovery and monitoring notification delivery/retry are implemented; see the current [workflow guide](../PRODUCT-WORKFLOWS.md) for their exact scope. These do not provide generic all-provider job cancellation, arbitrary dead-letter replay or all-record retention. Inspect original run status, audit records and destination receipts before any explicit recovery.

## Provider request pacing

Each tenant/gateway pair holds a 30-request burst that refills one request every 250 ms, in process, and a shared durable budget of the same size refilling every 200 ms. A burst is _shaped_, not rejected: a request that arrives with the burst spent waits for its refill, so a bounded operation that legitimately exceeds 30 calls — Google account discovery across many accessible customers, a long paged read — completes instead of failing partway. Only a caller that stays beyond the sustained rate long enough to owe more than 2 seconds receives `TENANT_RATE_LIMIT` with an accurate `retry_after_ms`. The in-process refill is deliberately faster than the durable budget's so that shaping never starves the shared limiter. HTTP 429 responses from a provider still open a shared cooldown, and repeated failures still open the per-gateway circuit.

### Provider quota by issuer

Providers ration requests per app, not per workspace: Google per Cloud project per day, Meta per app. With AMCP-owned
credentials, one workspace's scheduled reporting could spend the quota of every workspace. Each provider permit
therefore also counts the request against its **issuer** (OPS-08), a one-way hash of the gateway and the credential
field that names the app (OAuth client ID, X consumer key, Microsoft developer token or Apple team; never the raw
value). Counts are per UTC day and workspace: requests, reserved requests, operations (Google Ads mutate operations
count one each), provider 429s, refusals and would-be refusals. They live in SQLite, so every process shares them and
they survive a restart, and they are kept for eight days.

- **Observe (default).** `AMCP_PROVIDER_QUOTA_MODE=observe` only counts. Owner health (`provider_quota`) lists the
  issuers the workspace used: deployment-wide daily counts beside the workspace's own, the profile and what remains of
  the general pool. Record seven days of this baseline before setting any profile (owner step).
- **Profiles.** `AMCP_PROVIDER_QUOTA_PROFILES` maps a gateway to `daily_requests`, `reserved_fraction` (0 to 0.5,
  default 0.1) and `tenant_share` (above 0 up to 1, default 0.5). The general pool is `daily_requests` less the
  reserved slice; one workspace may use `tenant_share` of the pool. An invalid mode or profile stops start-up.
- **Enforce.** `AMCP_PROVIDER_QUOTA_MODE=enforce` refuses a request before anything is sent, with retryable
  `PROVIDER_QUOTA_SHARE_EXHAUSTED` (429, `retry_after_ms` to the next UTC day), once the workspace's share or the pool
  is spent. Write verification read-backs and reauthorization checks may also use the reserved slice, up to
  `daily_requests`. An Overview report run, scheduled or not, asks before it starts, so a spent issuer defers the
  whole run instead of stopping it at its first request. Roll back with `observe`.
- **Not counted.** Credentials that name no app (for example a bare access token) are not issuer-counted.

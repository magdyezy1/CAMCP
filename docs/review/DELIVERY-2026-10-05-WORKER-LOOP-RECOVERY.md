# Worker stage recovery across both entry points

Batch 162 follows through B16/B23 with an inspected worker lifecycle improvement. The HTTP worker
already caught schedule, mail and job-stage failures and waited one second before its next cycle.
The standalone worker instead closed its Store and exited on its first such failure. The owned
baseline executes that exact public loop body with a synthetic schedule exception and confirms
one tick, zero mail/job calls, zero recovery delays and one Store close. This establishes the local
source behavior, not a deployed incident or a complete process/provider reproduction.

## Runtime behavior

The internal `src/worker-loop.ts` loop now serves both `server/http.ts` and `server/worker.ts`.
It retains schedule → email delivery → job order, immediate draining after successful work and
one-second pacing after an idle or failed cycle. The original consecutive failure counter resets
after a successful cycle. Each diagnostic retains only the existing event, stage, bounded uppercase
native code or WORKER_STAGE_FAILED fallback, count and timestamp. It does not include exception
messages, stacks, native arguments, access tokens or payloads. A failed diagnostic sink or timer
still propagates rather than starting an unpaced retry loop.

Continuous standalone execution now recovers like the embedded worker. Explicit `--once` still
runs one cycle and propagates the original stage exception, preserving a non-successful invocation;
it neither hides a failed cycle nor waits to repeat it. The shared loop's diagnostic is metadata-only;
this is not a claim that Node's original uncaught one-shot exception presentation is redacted.

Stop checks occur before a new cycle and between stages, including after awaited mail delivery.
An already awaited mail/job can settle, but shutdown does not start another stage, claim or delay.
The existing standalone finally block still closes its Store. HTTP retains its disabled-worker
setting, listener lifecycle, ten-second shutdown deadline and outer Store close. This is not a
force-cancellation or new job retry policy: the original ReportWorker still owns leases, current
creator authority, verification/read-only retries, completion and uncertain-write handling.

70 original native, lease, authority, collector/controller and website files remain byte-identical,
including ReportWorker, Store, executor, scheduling and current-health observation logic. There
are no provider wire or persisted schema changes, new credentials, advertising writes or live requests.

## Behavioral qualification

Fifteen new maintained tests qualify ordered fast draining/idle pacing; one original failure in
each stage followed by exactly one paced next cycle; repeated failure counts and reset; bounded
metadata and unknown/lowercase/overlong code fallback; explicit once success/idle/failure identity;
stop before/during stages; awaited mail/job settlement; no post-stop claim; and visible sink/timer
failure. Injected delays check exactly 1,000 ms without pretending to measure wall-clock recovery.

A real two-connection SQLite writer holds BEGIN IMMEDIATE while the original ReportWorker tries
to lease an owned synthetic job. The actual critical lease is refused with ERR_SQLITE_ERROR;
the queued job remains at zero attempts with no result and no transaction left open. After the
loop's one-second delay callback releases the writer, the next cycle executes and completes exactly
one original job at one attempt, retaining the large native identifier, decimal string and unknown
value. A later original worker cycle finds no work. This supplements the existing BUSY health,
critical lease-renewal and original-authority tests; it does not weaken any lease operation.

An actual standalone `--once` child exits zero from an owned empty in-memory runtime using only
allowlisted OS variables and fixed synthetic options. It inherits no provider keys, live database,
mail transport or mutation grant. This qualifies the idle entry point, not a continuous deployed
failure or Linux signal delivery. The new tests plus original four-process queue/authority, heartbeat
and actual HTTP startup/bind-failure tests pass 28/28/0/0 in 7.502 seconds. Full checks follow below.

## Primary evidence and limits

[SQLite's transaction documentation](https://www.sqlite.org/lang_transaction.html) explains single-writer
contention and the BUSY refusal of a conflicting BEGIN IMMEDIATE. The owned held-writer test uses
that actual behavior. [Node 24.19 timer documentation](https://nodejs.org/download/release/v24.19.0/docs/api/timers.html#timerspromisessettimeoutdelay-value-options)
documents the existing promised wait. The source requests a one-second delay; event-loop scheduling
can extend it, so no exact deployed recovery timing is asserted.

[Node 24.19 signal documentation](https://nodejs.org/download/release/v24.19.0/docs/api/process.html#signal-events)
distinguishes listener handling and Windows termination emulation. Controlled shouldStop tests
qualify the shared stage boundary, while current Linux/Docker SIGTERM/deployment acceptance stays
separate. No Windows child.kill result is presented as graceful Linux signal proof.

Fresh sanitized install/build/regenerated report/freshness/default full checks require FFmpeg and
zero skips. The three public report artifacts must match generation; root private samples stay
unread. Fresh exact committed-source and clean-head browser checks precede the sole Work-here push,
with the owner's hosted Actions waiver retained. B16/B23 remain partial because deployed/Linux,
real tenant/provider load and broader capacity acceptance need their own evidence. Whole-plan
counts remain 13 implemented / 14 partial / one open. Work continues after this delivery.

## Complete working-source qualification

The fresh sanitized candidate passes all six install/build/regenerated report/freshness/default full
check/Railway stages: main 4,407/4,407/0/0 in 142.807 seconds, capture
4/4/0/0 in 80.0746 ms. Required FFmpeg runs with zero skips and default concurrency.
The manifest contains 1,802 public sources plus one generated empty sample, digest
c65946624e14f434c0c710d2aa6d6b6be9016c176cad5d3906b5864a01fb9203. All three public reports regenerate identically;
private root samples stay unread. Seventy original native/lease/authority/website sources retain
their baseline bytes. All fifteen new shared-loop behaviors and original four-process queue,
current-authority, critical lease and HTTP startup tests pass in this full run.

All 232 served browser cases pass from 2026-10-05T01:21:32.012Z through 2026-10-05T01:32:08.852Z,
website digest 5e79190f3859a13f0c40ba7460d72c93200bab10a007df2110cbfe6a179118d1. Forty populated retained-report journeys
retain 1,368 original workbook rows, 360 scoped controls and 160 labeled fields. All 32 four-provider
refusals retain their original wire/reference/focus/settings and persistent authored feedback.
Actual provider egress/mutations remain zero. The first browser invocation stopped before creating
a case because its per-process local dependency settings were absent; the configured fresh run
above uses the verified owned Chromium and installed Playwright. No browser assertion was weakened.
Fresh exact committed-source/full and clean-head browser gates follow before the sole Work-here
push with hosted Actions waived by the owner.

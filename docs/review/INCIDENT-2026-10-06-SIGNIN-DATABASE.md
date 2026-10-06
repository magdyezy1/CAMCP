# Sign-in failure and database diagnostics

The user reports **Request could not be processed** at `/login`; Incognito displays the form
but also fails on password submission. An anonymous real Chromium probe of deployed 94f4300
renders the form without JavaScript errors. `/login`, `/api/session`, `/api/platforms` and
`/api/account/options` return 200. Administrator/reviewer access is configured, social sign-in
has no configured provider, and email delivery is disabled. No live password was submitted.

Repeated public health observations return `degraded`: database `ok`, disk `low`, MCP `ok`.
Database health checks a read and a write lock followed by rollback, not a successful session
or job write. Low disk means less than 100 MiB available or less than 2% of the database
filesystem; it does not prove exhaustion. The owner reports usage `334.86` (unit unconfirmed)
and volume capacity **500 MB**. Even if usage is MB, those figures alone do not show a full
volume or establish free space on the database's filesystem. The owner also reports
`worker_stage_failed`, job stage, `ERR_SQLITE_ERROR`, 667 consecutive failures, at
2026-10-06T12:53:02.426Z. Concurrent database failures are confirmed; their exact cause is not.

The owner subsequently reports upgrading storage to **1 TB** while sign-in still fails.
An anonymous observation at 2026-10-06T13:44:48.648Z still returns disk `low`, database `ok`
and the unchanged 94f4300 build. The dashboard capacity and the application's measured database
filesystem therefore need reconciliation. A larger selected capacity alone does not identify or
repair the particular SQLite error, and no additional capacity increase is prescribed here.
Owner screenshots at 16:44–16:45 GMT+3 additionally show `schedule`-stage SQLite failures
every second and concurrent `http_failed`, status 500, `INTERNAL_ERROR` responses. They retain
request IDs but still omit the numeric SQLite result, so the precise cause remains unconfirmed.

## Diagnostic repair

Worker/HTTP logs retain SQLite's original numeric result code, primary code and a predefined
result name, without SQL, parameters, paths, exception messages or `errstr`. Extended numbers
remain exact. `SQLITE_FULL`, `SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_CONSTRAINT`,
`SQLITE_IOERR`, `SQLITE_CORRUPT` and `SQLITE_ERROR` are distinguishable.
Only a genuine Node SQLite error with primary code 13 becomes HTTP 503 `STORAGE_FULL`
with an English/Arabic capacity explanation. Other failures retain their generic response;
the server log carries precise numeric diagnostics. Page and administrator/reviewer form
errors now display the original server reference. Password checks, login limits, sessions
and grants are preserved; failed operations are not automatically retried.

All 44 focused cases pass: actual SQLite-full administrator/reviewer HTTP failure, no issued
session cookie, rolled-back limit insert, bilingual references, recovery after local capacity
restoration, genuine query errors and a real blocked/recovered worker lease. The first reviewer
fixture reused the administrator password and was correctly refused by existing isolation;
the corrected fixture uses distinct synthetic passwords. Tests use no live provider or credential.
Sixteen rendered local journeys also pass: administrator/reviewer sign-in in English/Arabic at
320/375/768/1280 pixels, persistent references, no automatic repeat, valid-password refusal under
actual SQLite-full conditions, and explicit successful resubmission after restoring local capacity.
These reproduce the full-storage failure class; they do not identify the live failure's class.

A fresh public-only candidate passes all 5,031 main cases and four capture cases, required FFmpeg,
report freshness, generated contracts and documentation checks. Earlier retained full-run failures
were the tool-description prefix and the measured website diagnostic inventory; both are repaired
without weakening their assertions. The final clean-source 560-case browser gate remains separate.

## Operational completion

Inspect Railway deployment logs for one failed sign-in and the next worker failure. The new
`database` fields identify the class. For `SQLITE_FULL`, inspect the database and temporary
filesystems, volume capacity, WAL growth and SQLite page limits before choosing a repair.
For locking, schema, permission or corruption errors, follow that actual result. Preserve the
database and encryption key. Volume changes/database maintenance are not performed here.
Browser control cannot initialize, and no Railway connector/CLI is available. Production login
remains unverified until its identified operational cause is repaired and the original sign-in works.

References: [SQLite result codes](https://www.sqlite.org/rescode.html),
[Node SQLite errors](https://nodejs.org/dist/latest-v24.x/docs/api/errors.html#err_sqlite_error),
[Railway logs](https://docs.railway.com/observability/logs), [Railway volumes](https://docs.railway.com/volumes).

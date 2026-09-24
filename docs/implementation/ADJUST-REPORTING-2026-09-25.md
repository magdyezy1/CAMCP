# Adjust reporting implementation — 2026-09-25

Branch: `Codex-branch`; base revision
`bc7eca59cb1fa42ec0edf8c91f164762c96ce6ba`. Six advertised operations previously
failed with `WORKFLOW_ADAPTER_REQUIRED`. They now execute local connection listing
and bounded native app/filter/event/JSON/pivot reads. Initial six failures are
retained. No Adjust write was allowlisted and no live token was accessed.

## Contract and trust boundaries

`src/adjust-reporting.ts` implements the workflow; `src/adjust-extensions.ts`
publishes maintained action schemas independently of captured metadata. Service
dispatch and action inventory use the same operation classifier. The native
transport accepts HTTP 204/lossless JSON only for the exact internal read action,
GET method, origin and four fixed paths. Unknown empty reads still fail.

The client chooses a connection UUID from local discovery. A unique display name
remains compatible; UUID matches take precedence over colliding names. Selected
app IDs belong to that tenant/login. Admin-only app/filter discovery can see the
token's broader provider-visible metadata but cannot persist grants. Events and
reports enforce selected app IDs; every report includes app identity. Private
provider tokens remain encrypted at rest and are sent only in native HTTPS headers.
Arbitrary URL/header/token fields and redirects are rejected. No remote media or
report URLs are handed to the client or fetched implicitly.

Current actor, connection, app grants and credential fingerprint are checked before
every network attempt and before returning data. In-flight revocation withholds the
response. A runtime-only transport hook handles retry authority checks; it is not
part of compiled requests or persistent reviews. Every attempt also consumes the
global Adjust SQLite budget, 30 burst/five per second. Provider 429 cooldowns persist
across workers. This deliberately conservative bound covers processes using the
same SQLite volume; unrelated services or separate volumes behind one NAT do not
share it. No additional service or queue was introduced.

Reports preserve numeric lexemes exactly as strings, including large integers and
fractional money; null does not become zero. Unknown metric types fail. App-indexed
pivot nesting, native date syntax, attribution enums, dimension/metric operators
and sort fields are checked. The response includes effective query, retrieval time,
output-contract version, dynamic-period indication and explicitly unknown currency
when none was requested. No sums, weighted ratios or recommendations are invented.
Warnings and missing totals mark the report incomplete. Empty HTTP 200, unknown
pagination, repeated grain, foreign apps and malformed envelopes fail.

Bounds: 8 MiB/response, 25000 rows, 200000 structural nodes, depth 12, 64 KiB/field,
60 seconds after credential resolution, up to three safe GET attempts, ten requested
dimensions plus app identity, 100 metrics and 50 selected apps. Native fixed UTC
offsets do not imply DST handling. Queries exceeding bounds require caller-chosen
compatible date/app partitions, not silent truncation. Report bodies are omitted
from audit records. Client responses mark provider text untrusted.

## Verification and preserved failures

Logs are under `.runtime/contract-completion-20260924/` in the implementation
checkout; all are synthetic and retained locally, not committed:

- `adjust-reporting-baseline-build.log`: build passed.
- `adjust-reporting-baseline.log`: six expected baseline failures for missing adapters.
- `adjust-reporting-first*.log`: build and initial six tests passed.
- `adjust-reporting-expanded*.log`: build and 77 shared/focused tests passed.
- `adjust-reporting-final*.log`: build and 87 tests passed, zero failed/skipped.

The 33 new tests cover all six actions, exact numbers, nulls, malformed native
responses, duplicate/foreign rows, 25001-row overflow, byte/UTF-8 limits, actual
AbortSignal timeouts, retry-time revocation, secret-free errors, UUID ambiguity,
cross-tenant isolation, dynamic periods, event mappings, guidance examples, two
SQLite handles, restart, backwards wall-clock adjustment, retry consumption and
shared cooldowns. Existing transport, Criteo reporting, measurement sync and MCP
resource tests pass. Documentation review corrected dimension `__exclude` and
metric-only numeric comparisons before release. Tests were expanded without
weakening existing assertions. Candidate A failed two deployment smoke expectations after thirteen guides replaced twelve. Both restart modes now assert thirteen plus the Adjust URI and pass. Descriptor follow-up: 37 tests pass; its initial inferred-return-type build failure is retained. See CI-DEADLINES-2026-09-25.md for the separately supplied CI timeout defect, now corrected without relaxing assertions. Fresh candidate B passes the full required-FFmpeg check: 1646 main tests and four capture tests, zero failed/skipped. ADJUST-REPORTING-VERIFICATION-2026-09-25.json records the tested source and initial failures. Actual Ubuntu/Docker CI is checked separately after push.

Generate after build with `node dist/tools/generate-contracts.js` and
`node dist/tools/action-contracts.js`. Inventory: 3241 total, 438 reviewed-family,
886 blocked writes, 80 unmapped, 23 unqualified reads, eight input-dependent, four
retired, 82 local workflows, 1704 native reads and 16 media workflows. Remaining
CSV: 1001 rows, preserving all 14 fields. Adjust alone has six workflows and
23 unmapped actions. Neither catalog completeness nor local success proves full
provider coverage or live readiness.

## Sources, limits and rollout

Official unversioned sources accessed 2026-09-25:
[authentication](https://dev.adjust.com/en/api/rs-api/authentication/),
[filters](https://dev.adjust.com/en/api/rs-api/filters-data/),
[events](https://dev.adjust.com/en/api/rs-api/events/),
[reports](https://dev.adjust.com/en/api/rs-api/reports/),
[pivot](https://dev.adjust.com/en/api/rs-api/pivot),
[rate limits](https://dev.adjust.com/en/api/rs-api/rate-limits).
No reliable update date/version was exposed. Published filter names conflict with
the report guide's metric-discovery suggestion; no undocumented metrics filter is
assumed. The event endpoint does not accept captured `datePeriod`. App-token pivot
indexing is inferred from documented index semantics and synthetically exercised;
live acceptance is unverified. Native metric availability/entitlements, source
timing, cohort/attribution meaning, currency reconciliation and account scale need
authorized live read fixtures. Source bytes are measured locally; no independent
provider checksum/count is claimed.

No dependency or database migration. Existing API-token provisioning remains;
there is no new Adjust website OAuth flow. This is native MCP reporting, not
normalized dashboard/scheduled-export integration. Follow-on work needs an explicit
metric crosswalk and persistent report definition before enabling those paths.
Roll out code and maintained guide together; use a read-only canary with known
app/date/currency and reconcile native output. Rollback retains existing connection
data but returns these six operations to unsupported status. Preserve shared
cooldown documents and audit records during rollback.


## Confirmed GitHub CI result

[Run #97](https://github.com/magdyezy1/AMCP/actions/runs/36067336279) for
`b372c660a4d11df1fee2e37b55891ded1085f1b6` on `Codex-branch` succeeded,
observed directly in the authenticated GitHub browser on 2026-09-25 (Cairo).
Total verify duration: 17m 28s. Required-FFmpeg npm check took 7m 42s; Docker
build took 8m 27s; both container smoke modes took 5s and succeeded. Railway
configuration validation and evidence upload also completed. This closes the
post-push CI gate for this commit, without claiming live provider qualification.

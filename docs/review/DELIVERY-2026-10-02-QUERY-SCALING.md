# Measured workbook query lookup — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `fd75692`. Batch 78 extends B23 with a measured local performance improvement.

Workbook authorization repeatedly selects queries by tenant and saved workbook association. Before this change,
SQLite used the generic document key to narrow by tenant/kind, then scanned that tenant's query JSON to find the
association. A partial expression index, `reporting_query_workbook`, now seeks by tenant and the exact
`workbook_binding_id`, with query ID for ordering. Current actor/account checks still run for every result;
no authorization or query data is cached. The existing 50-association scan and 500-query bounds remain.

The reproducible command `npm run benchmark:workbooks` builds the code and runs a strictly synthetic in-memory
fixture: two tenants, 250 associations per tenant and 20 queries per association (10,000 saved queries total).
It returns a page of 20 associations, performs three warmups and 12 measured samples per stage, first without the
index and then with it. It checks byte-identical authorized output, reports SQLite query plans and records sampled
RSS, response bytes and index size/build time. It cannot target a deployed database and makes zero provider calls.

The [recorded run](WORKBOOK-LOOKUP-2026-10-02.json) measured median **217.73 → 123.87 ms** (about **43% lower**)
and sample p95 **250.58 → 154.15 ms** (about **38% lower**). Both stages returned **13,096 structured bytes** with
SHA-256 `5270c0df47a7becfd9118dc6b439ae8f2657369a997cab1e1f32649bdcacf799`.
The index occupied **335,872 SQLite page bytes** and built in **5.80 ms** in this fixture. This is one local process
on Windows/Node 24.19.0, not production latency, concurrent-tenant acceptance or continuous peak-memory evidence.
The complete samples and environment are in the JSON record; no universal speedup or capacity guarantee is implied.

The index is added inside Store's existing serialized bootstrap transaction after the supported schema-version
check. It is an additive physical schema change, retaining schema version 2 and all document bytes/revisions,
jobs, encrypted credentials and audit history. Reopening an existing schema-2 database installs it idempotently.
The prior application can continue using the same database with the index present; no data migration is required
to revert application code. First startup builds the index, so large production databases still need a measured
deployment window; no production migration was run here.

Three new tests were observed red before implementation. They check actual query-plan use with identical output
without the index, existing-file migration without changed records/audit, and encrypted backup/restore followed by
current account revocation. The related **29/29** tests include existing concurrent process bootstrap and recovery.
An initial test-harness typo called a nonexistent store accessor; it was corrected to the existing scoped accessor.
Full/sanitized qualification is recorded below and in [PROGRESS.md](PROGRESS.md).
Logs: `.runtime/query-scaling-20261002/`.

Final root suite: **3,372 tests; 3,367 passed, zero failed, five local FFmpeg skips; 77.43 seconds**.
Sanitized and exact committed-source qualification follows before push.

Sanitized preflight `.release/query-scaling-preflight-20261002` passed every check/Railway stage:
**3,367 passed, zero failed, five local FFmpeg skips; 77.10 seconds**, four capture tests, 31 browser scripts
and 244 documents. Its **1,478 public source files** plus one generated empty sample have hash
`6b68fd317fc7c5f5d7ac11f9f4bfef4fca04e795d4f4ba426bbbb810e52faec7`. Exact committed-source checks follow before push.

Design references: SQLite [expression indexes](https://www.sqlite.org/expridx.html) require the query expression
to match the indexed expression, and [partial indexes](https://www.sqlite.org/partialindex.html) apply only to rows
matching their predicate. Query-plan tests validate those conditions for AMCP's actual membership selector.

Native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Real workload, cache/fan-out decisions and
multi-worker capacity remain under B23. No dependency, provider mutation, permission expansion, external message,
production deployment or private-root-sample read is introduced.

Batch 77 follow-through: exact HEAD `fd7569218fdae7403314dcda533e4f03a873db6b` passed every check/Railway stage
in `.release/workbook-bindings-work-here-head-20261002`: **3,364 passed, zero failed, five local FFmpeg skips;
76.53 seconds**, four capture tests and byte parity for **1,474 public source files** plus one generated empty sample.
Hash: `7817c784488f2e587a90d75529ad3a6021d74fd6ca7dbbb898567b8f02bca9aa`.
The sole branch push started [CI132](https://github.com/magdyezy1/CAMCP/actions/runs/36928791382), pending at the
latest check, as is [CI131](https://github.com/magdyezy1/CAMCP/actions/runs/36926690036).

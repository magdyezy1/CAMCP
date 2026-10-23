# Batch 127 — bounded saved-evidence discovery

Only `magdyezy1/CAMCP`, branch `Work-here`, in `CAMCP-Codes-final-branch`. This continues the original
28-package plan; it does not close its remaining work. All records and provider transports used here are synthetic.

## Result and reproduced defect

**F-200:** `amcp_reporting.list` ignored its supplied page limit, loaded every complete retained decision report
into a JavaScript array, then omitted only the mapped rows. Discovery still returned native request/page metadata
and arbitrary document fields. The baseline requested one item and returned all three synthetic reports, including
native request/page markers, with zero network calls. Seven new regressions failed before correction. Existing
current-access checks were present; this finding does not claim cross-tenant disclosure.

`src/evidence-index.ts` now projects a bounded, explicit metadata allowlist in SQLite using the existing
tenant/kind/id primary index. It returns actual report IDs/revisions, bounded source/scope/measurement descriptions,
safe capture times and row counts. Missing or malformed legacy descriptions remain unknown. Boolean completeness
stays boolean. Full mapped rows, native requests/pages and arbitrary document fields do not enter this discovery
projection. Retained documents, exact decimal strings, complete evidence inspection and exports are unchanged.

Default page size is 30, maximum 100. Each call inspects at most 500 candidate metadata records under the selected
tenant and optional gateway/connection/preset filters. Current actor and account access are checked for every
returned item and again before completion. Inaccessible/malformed candidates are skipped. A bounded scan may
return an empty page with `has_more:true`; this means possible further candidates, not a completed empty collection.
There is no total-count or atomic inventory claim. Nonzero offset is refused; use `next_cursor`.

Continuations use the existing encrypted, authenticated 15-minute read cursor. They bind tenant, actor, role,
credential/session identity, normalized query filters and current connection accounts/scopes/enabled state.
Changed grants, sessions, identities, filters, keys or expiration refuse continuation. A mid-page grant change or
revocation refuses the response without exposing partially projected metadata. Synthetic database restore with
the same configured key and original credential continues correctly. This does not authorize provider reads or writes.

Plain-text search matches original report IDs/names, account IDs and presets case-insensitively, with a 150-character
limit. Account filtering requires the exact gateway and uses its existing account normalization. Returned native
IDs and original names are preserved. No source document is rewritten by discovery or search.

## Website and MCP workflow

English/Arabic saved-evidence controls now search, reset and load additional pages. Visible source labels remain
escaped. Unknown legacy metadata has readable fallback labels. Empty partial scans remain continuable. Loading
and retry states preserve the original opaque token and exact query; late responses cannot repopulate a departed
view or a changed identity. Search replaces the preceding collection. New captures remain inspectable and are
added to discovery only if they match the current query.

Loading more pages refreshes comparison-source choices without rebuilding the open report or losing its selected
reference. Removing a reference through a new search clears the obsolete result. Detail, analysis, budgets and
native report controls retain their existing authority and request sequencing. Selected authored control copy is
translated; source names, IDs and MCP wire arguments stay unchanged.

The advertised `amcp_reporting` contract documents `search`, `cursor`, page bounds, current scope and possible
empty continuation pages. `amcp://guides/workspace` explains the agent workflow. A real SDK journey checks the
advertised input schema, text/structured parity, small metadata output and revoked continuation access:
**three calls / 3,457 structured bytes / zero provider requests**. This qualifies the synthetic SDK journey,
not external multi-client acceptance.

## Verification and capacity limits

- The initial seven new regressions failed against the baseline. Ten index tests now cover bounds, metadata
  minimization, access-filtered traversal, tampering/expiry/filter binding, Arabic search, unknown legacy metadata,
  bounded inaccessible scans, restored storage, distinct sessions/keys and mid-page authority changes.
- The focused index, interface, real SDK, retained row/search/export and localization set passed **110 tests**,
  zero failures/skips in **6.129 seconds**. This is synthetic contract and renderer evidence.
- Browser automation previously failed to initialize after reset because its kernel-assets path was missing.
  No actual visual, keyboard or assistive acceptance is claimed for this batch. There is no deployed acceptance claim.

`npm run benchmark:evidence` is a reproducible, disposable in-memory benchmark with two synthetic tenants,
120 reports per tenant, 1,000 rows per report, two warm-ups and six timed samples per separate process. It compares
the original full-document algorithm with the new first-page index, forces garbage collection outside timed
calls and samples heap/RSS. The authorized first 30 metadata projections have the same SHA-256. The query planner
uses the existing primary index; no migration or new runtime dependency is added. The final measurements are below. Sampled memory is not continuous peak memory. This does not qualify
production, concurrent users, provider latency, caching, fan-out or deployed capacity.

| Measurement | Original full-document discovery | Bounded first page |
|---|---|---|
| p50 / p95 | 56.250 / 57.534 ms | 5.999 / 6.449 ms |
| Reports returned for limit 30 | 120 | 30 |
| Structured JSON bytes | 87743 | 15902 |
| Sampled heap above post-warm-up start | 42124504 bytes | 260096 bytes |
| Sampled RSS above post-warm-up start | 22032384 bytes | 147456 bytes |

Build module SHA-256: `03b73251f18fba267f2fac73a7959e1571077ffc0132f4325abe160c03aec302`. Matching first-page projection SHA-256:
`c78f16960005ddd0c6b131837f30a626f565addca47252a1415a49df27295fbd`. Node v24.19.0, Windows, SQLite
3.53.3; in-memory storage. Both processes see the same authorized first 30 records; the
original additionally returns every report and native metadata. Independent process RSS baselines differ, so sampled
increments describe this run and are not a production or guaranteed memory reduction.

Browser-script validation passes **34 scripts / 3,088 selected Arabic messages**; the document index includes
**293 documents**. Full sanitized release qualification follows.

## Prior exact-source release evidence

Batch 126 exact HEAD `eca1830d9e14ea235689912c6edaaddbe7c94399` passed offline install, build, early report
freshness, full check and Railway, each exit zero: **3,974 total / 3,969 passed / zero failures / five local FFmpeg
skips in 94.299 seconds**, plus four capture checks in 77.932 ms. All 1,644 public sources matched Git HEAD
without filters plus one generated empty sample; source hash
`4fb65268a61ea62dac276cade2374675e2200d33759c08d2b36f0ac3dddc7971`. All three tracked public reports stayed
byte-identical. No root private sample or credential was read.

Its [CI181](https://github.com/magdyezy1/CAMCP/actions/runs/37162438471) completed successfully for that exact
HEAD/hash: **3,974/3,974** host and Docker tests, zero failures/skips, in **650.404/659.550 seconds**. Four capture
checks passed in each environment, 73.154/80.218 ms; both main suites recorded two CPUs/two file workers. Required
FFmpeg, tracked-report freshness, Railway compatibility, image build and both synthetic container smoke modes
passed. This proves release/container checks for batch 126; the current revision requires its own CI.

The native action ledger stays **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked
writes**. Current native ownership, frozen reviews, spending confirmation, idempotency and receipt read-back are
unchanged. B11/B15/B16/B18/B23/B24 advance within the stated evidence; the matrix remains **13 implemented /
14 partial / one open**. The larger roadmap, real workload, visual/assistive, provider and deployed acceptance remain
separate. Fresh sanitized build/report regeneration, full preflight and exact committed-source qualification precede
the sole push to `Work-here`.

Final sanitized preflight passed offline install/build/early report freshness/full check/Railway, each exit zero:
**3,990 total / 3,985 passed / zero failures / five expected local FFmpeg skips in 96.787 seconds**, plus four
capture checks in 79.267 ms; 34 scripts / 3,088 selected Arabic messages / 293 documents. Fresh sanitized
build/report regeneration confirmed all three public artifacts byte-identical, and qualification preserved them.
1648 public source files plus one generated empty sample; source hash
`e6554c382db1dd38a6832be19c796c74c20e8f1af08c6be87bed0eb4f0995db0`. This preflight precedes the final qualification paragraphs and matrix
spacing correction; exact committed-source qualification follows before the sole push. The current revision needs
its own FFmpeg/Docker CI. Visual/assistive, real workload, provider and deployed acceptance remain separate.

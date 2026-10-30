---
status: record
tier: engineering
---

# Batch 114 — bounded tool timings in owner health

Baseline: `2db4f7b74f2a702f7eecdf557d82676c4aeb7565`, sole repository `magdyezy1/CAMCP`, branch `Work-here`.

## Delivered behavior

Workspace owners and the existing administrator health projection can inspect completed tool-attempt timings
through Settings and `amcp_workspace health`. The existing sanitized support bundle includes the same aggregate
projection. Readers/operators do not gain owner diagnostics. No new public action, authorization scope, native
request, dependency, database table or production setting is introduced.

Eight fixed groups cover workspace, campaign plans, reporting analysis, Reporting Overview, previews, creative
preparation, reviewed writes, and native/other tools. Unknown tool names use the last fixed group; arbitrary names,
arguments, accounts, actors, URLs, tokens, error text and provider responses are never stored in timing records.
The workspace key is the existing tenant partition, not an identifier returned in the timing projection.

Each workspace retains at most eight fixed-size records. One record per group is replaced on the next observation
in a new fixed 15-minute UTC interval. Idle old observations are excluded rather than presented as current traffic.
There is no historical timing series, timer or cleanup scan. An SQLite immediate transaction updates each counter
atomically. A million measured attempts per group/interval, safe integer arithmetic and seven fixed latency buckets
bound aggregation. Invalid/nonfinite/negative/non-number samples and exhausted capacity increase an explicit
omission count; they do not become zero latency or a fabricated measurement.

The handler clock is monotonic; measured milliseconds are rounded to integer microseconds for accumulation.
Mean/minimum/maximum refer only to measured attempts. Median and p95 are bucket bounds, with boundaries at
25, 100, 500, 2,000, 10,000 and 60,000 ms and an open upper bucket. They are not exact percentiles. The website
shows means, approximate percentile bounds, success/error envelope counts, omissions and an interval start.
Missing means/percentiles display Unknown; a measured zero remains zero.

## Measurement and recovery limits

Timing begins inside the tool handler and ends before timing storage and response delivery. HTTP queueing,
response serialization and client network delivery are excluded. Nested tool calls and ownership refresh attempts
are included as separate completed attempts; native HTTP request counters remain separate. The current health
call appears only in a later snapshot. Success/error counts describe response envelopes: a successful response
can still contain a blocked, pending or failed workflow. These measurements do not establish business success,
end-to-end service latency, native provider reliability or a service-level objective.

Malformed stored counters are withheld and counted as unavailable. A later valid observation resets them with
`invalid_counter`; backwards wall-clock movement resets with `clock_changed`. Current-window counts and omission
notices make gaps explicit. Failure to persist timing cannot replace the original tool result or initiate a native
retry. A separate bounded process-local failure counter reports storage gaps without returning error text. That
counter covers the running process and resets on restart; it is not a durable deployment-wide error total.

## Qualification

- The initial feature test failed because owner health lacked timings; the completed projection passes. A test-only
  privacy marker was made unique after its original generic word also matched ordinary explanatory copy. Browser
  VM setup received its missing document event stub. Neither correction weakened assertions or application guards.
- Seven final focused tests passed without skips in **1.439 seconds**. They cover interval/bucket boundaries,
  zero versus invalid measurements, tenant isolation, corrupt counter projection, saturation, clock reset,
  persistence-failure behavior, bilingual table rendering and empty states.
- Actual HTTP MCP SDK calls observe completed attempts. Revoking the test key rejects the next call without adding
  an authorized measurement. All provider transports reject native egress; no native provider request occurred.
- Three real child processes concurrently perform 75 increments each against one disposable SQLite database.
  The one retained counter contains exactly **225 attempts**, mean **25 ms**, and no omissions. This qualifies
  counter atomicity under this fixture; it is not a real tenant/provider capacity benchmark.
- The root regression suite passed **3,779 tests / 3,774 passed / zero failed / five expected local FFmpeg skips**
  in **92.713 seconds** before the final wording/type-check refinement. Final sanitized qualification covers those
  refinements. Browser seed values are synthetic and do not imply real traffic.
- Actual English/Arabic desktop and 375-pixel mobile browser inspection shows translated groups, labels, explanations,
  empty-to-new-interval recovery, named keyboard table regions and scoped headers. The 944-pixel table remains
  inside its own scroll region; mobile document/client widths are **360/360 px** with a **280-pixel region**.
  Earlier keyboard checks advanced English by **80 px** and Arabic by **-80 px**. Final screenshots include the
  measurement boundary copy in both languages. Existing number formatting uses Latin digits here.

No independent assistive-technology, full Arabic editorial, deployed, live-provider or real tenant load acceptance
is claimed. Broader observability and legacy path/opaque-body scope adapters keep B13 partial; actual tenant
load/cache/fan-out/general worker capacity keep B23 partial. The package matrix remains **13 implemented / 14 partial /
one open**. Native classification remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.

## Previous delivered revision

Batch 113 exact HEAD `2db4f7b74f2a702f7eecdf557d82676c4aeb7565` passed sanitized install/build/report/check/Railway
in `.release/creative-performance-platforms-work-here-head-v2-20261003`: **3,772 tests / 3,767 passed / zero failed /
five expected local skips**, **94.660 seconds**, four capture checks in **85.044 ms**, 33 web scripts, 2,917 selected
Arabic messages and 279 indexed documents. All **1,587 public source files** match committed HEAD before/after
qualification; the one generated historical sample is `[]`. Source hash:
`fa8323750c9d5176297ec5a05f8a19ef96d69bfcdc2651399053182920cd21aa`. The sole Work-here push succeeded.

[CI168](https://github.com/magdyezy1/CAMCP/actions/runs/37106606152) on that revision completed successfully.
Decoded job `111156256711` logs show **3,772 passed / zero failed / zero skipped** on host and Docker, four capture
checks in each, Railway, and both synthetic read/write container smoke flows. Host/Docker suites took
**839.604 / 846.914 seconds**. Downloaded artifacts and live/native/deployed acceptance were not inspected.


## Sanitized preflight

`.release/service-timings-preflight-20261003` passed install/build/report/check/Railway: **3,779 tests /
3,774 passed / zero failed / five expected local FFmpeg skips**, **96.770 seconds**, four capture checks in
**75.566 ms**, 33 browser scripts, 2,927 selected Arabic messages, 3,079 catalog entries and 280 indexed
documents. **1,593 public source files plus one generated empty historical sample** have source hash
`d313db92dfa2ff4e1e3fdcd86d0b59903f7b6c11d90a358b37b443697910c8aa`. This preflight includes final
measurement wording and strict elapsed-value validation. Exact committed-source qualification follows before
the sole Work-here push.

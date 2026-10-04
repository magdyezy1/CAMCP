# Batch 133 — schedule selection and worker contention

Baseline `5081152`. Sole checkout `CAMCP-Codes-final-branch`, repository `magdyezy1/CAMCP`, branch `Work-here`.
This advances B12/B13/B16/B23 with measured schedule selection, revision-safe failure handling and actual local
child-process qualification. It introduces no native action, family, credential scope, advertising mutation or
deployment setting. All databases, identities, jobs and callbacks in the measurements are disposable synthetic data.

## Preserve the newer schedule

Two corrected failing baseline regressions reproduce F-203. After a failed enqueue transaction releases its lock,
another connection can edit the schedule before failure handling runs. Overview previously wrote its old snapshot
without a revision guard, restoring old settings and pausing the newer schedule. Workbook failure handling used an
expected revision, but its unhandled conflict aborted the pass before another tenant was processed.

Both paths now use a short transaction that rereads the exact tenant/kind/ID and pauses only the originally
attempted revision. Changed or deleted schedules remain intact; deleted definitions are never recreated.
Unchanged failures retain the original diagnostic and pause as before. Storage failures roll back and remain
errors. Existing encrypted creator binding, current authorization, query resolution, enqueue de-duplication,
timezone/window calculation, lease generations, retry policy and native receipt recovery remain in place.

## Read the schedules that can be due

The old pass decoded every schedule in every tenant, including future and inactive records. Two additive schema-2
partial expression indexes now select candidate due schedules by original tenant/kind. They are created inside
serialized bootstrap, without a new schema version or data rewrite. Per-tenant ID order and complete stored
projections remain unchanged. A cutoff is captured for each pass; a window becoming due during it runs next pass.

The index retains JSON/JavaScript truthiness, including older string/integer declarations. Its numeric deadline
predicate is a coarse prefilter; the original JavaScript comparison decides eligibility, including nulls, missing
dates, numeric strings and invalid strings. No inferred eligibility or authority comes from the index. Current
actor/revision and existing schedule validation remain at enqueue. Every due schedule is still processed; this
reduces selection cost without introducing a global fan-out limit, authority cache or changed tenant dispatch order.

## Reproducible local measurements

`npm run benchmark:schedules` builds then runs separate legacy/indexed child processes: 12 synthetic tenants,
1,000 schedules per kind per tenant, 24,000 definitions and 120 due schedules. Each stage uses two warmups and seven
measurements. Complete original projections, exact native strings and revisions retain an identical SHA-256.
Query plans use both due indexes. Construction cost and sampled heap/RSS are reported, not continuous memory peaks.

Final local median selection **59.191 ms → 0.672 ms**, p95 **65.929 ms → 0.765 ms**. Sampled heap was
62,483,032 → 7,496,632 bytes; sampled RSS 302,428,160 → 184,107,008 bytes. Indexes used 638,976 bytes,
with measured rebuilds of 49.034/48.489 ms. Projection hash:
`e0d99c3928d4c7b41304de159953f4ca22538cd44343ab916157a10c8ba93e0b`.
These apply only to the specified local workload, not production latency/memory guarantees.

`npm run benchmark:workers` creates an owned temporary WAL database per one/four-worker cohort. It uses the
actual ReportWorker, encrypted original API-key authority, scheduler and leases. Six tenants each have 20 direct
jobs, two revoked-creator jobs and two due schedules. Callbacks wait a declared synthetic five milliseconds and
contact no provider. A nested transaction records the exact dispatch ordinal; instrumented timing is not a
production queue benchmark.

Both cohorts completed 132 valid jobs, refused 12 revoked originals and dispatched 144 unique jobs, with no
duplicate schedule enqueue or crossed tenant/result/native ID. Equal eligible backlogs retained round-robin
dispatch. Each schedule advanced once to revision two and a later window. Final creator revocation prevented
restoration of completed jobs' original authority; audit chains verified. The final sample took 4.256/2.911
seconds including child startup; claim p50 was 2.536/2.388 ms and p95 3.399/3.640 ms. Earlier samples made
four workers slower than one. Observations do not justify changing Railway replica/worker settings; the existing
one-replica persistent-volume deployment remains unchanged.

SQLite primary documentation checked 2026-10-04:
[expression matching](https://www.sqlite.org/expridx.html), [partial indexes](https://www.sqlite.org/partialindex.html),
[WAL concurrency](https://www.sqlite.org/wal.html) and [transaction isolation](https://www.sqlite.org/isolation.html).
Index/query expressions match explicitly. WAL does not create a distributed or concurrent-writer database;
write transactions still contend. Actual workload and deployment qualification remain necessary.

## Qualification

The corrected baseline failed both race regressions: **two tests / no passes, 586.289 ms**. Eight backend checks
qualify original projections/order, tenant/kind separation, more than 200 due records without truncation, indexed
plans, legacy coercion, deadline/active/revision changes, exact failure/rollback behavior, schema-1 migration,
repeated schema-2 opens and encrypted backup/restore. Two actual scheduler regressions exercise the precise
post-rollback edit window through a second SQLite connection.

Five worker checks use actual child processes: four-worker dispatch/de-duplication/authority; bounded workload
arguments; creator revocation while a callback is pending; expired generation recovery and stale completion/
failure/renewal fencing; refusal to open/create a database outside the named owned temporary directory. Revoked
or expired pending results never become completed jobs. All 15 new checks passed. Related set: **3,386 tests /
3,381 passes / no failures / five expected local FFmpeg skips, 91.639 seconds**.

Full sanitized release/exact committed-source checks and current Linux/Docker/FFmpeg CI follow below. Native
totals remain **3,247 actions / 167 families / 800 reviewed writes**. Original package totals remain **13
implemented / 14 partial / one open**. Real tenant/provider load, production queue timing/capacity, full
accessibility/external-client acceptance and remaining source/destination workflows stay separate. Work continues.

## Verified preceding source CI187

[CI187](https://github.com/magdyezy1/CAMCP/actions/runs/37178417767) passed for exact `5081152db3fbcdfe32fbaedaf758565039d3b2f8`, source hash
`38305559088e84abb59b0b1f35ca8a040257af01965fbcd3f59bb2edcf5177cf`, 1,678 public sources plus one generated empty sample. Linux host and Docker
each passed **4,086/4,086/0/0**, in 678.119/683.752 seconds. Capture suites **4/4/0/0**, 72.011/74.420 ms.
All steps passed, including required FFmpeg, early tracked-report freshness, full gates, Railway/image checks
and both synthetic smoke modes. This verifies batch 132's exact source, not the pending scheduler revision.

## Batch 133 sanitized release preflight

Fresh offline install/build/early report freshness/full check/Railway gates passed, each exit zero. Main suite
**4,101 total / 4,096 passes / zero failures / five expected local FFmpeg skips, 96.704 seconds**; capture
**4/4/0/0, 70.658 ms**. Website: 34 scripts and 3,315 selected Arabic messages; index: 299 documents.
Manifest: 1,686 public source files plus one generated empty sample; source hash
`799357d3fd3b13eab038419617e498907a9dd69753c0ee1dd2389b2388c88f91`.
Public implementation-status.json regenerated with module coverage 284 → 285; compatibility and parity
regenerated unchanged. All three retained their generated bytes throughout qualification. Only sanitized
assembler-created empty samples were used; the private root sample was not read. Final evidence paragraphs
follow preflight; fresh exact committed-source parity and full gates precede the sole Work-here push.
No local Docker/FFmpeg result or deployed/live acceptance is inferred.

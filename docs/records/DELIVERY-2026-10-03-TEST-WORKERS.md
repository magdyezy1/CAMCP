---
status: record
tier: engineering
---

# Explicit test workers for CI and Docker builds

Batch 123. Work-here only; sole remote magdyezy1/CAMCP. Baseline 63641dd.

The full test command now accepts AMCP_TEST_CONCURRENCY as an exact integer from 1 to 32. Unset values preserve
Node's local default. CI and Docker select two isolated test-file workers. Invalid settings fail before discovery
or execution. The launcher uses the current Node executable directly, passes the original two flat test patterns,
inherits test output and propagates a failed runner exit. Explicit environment selection takes precedence over
a conflicting concurrency argument. Other normal Node test arguments remain available. test:serial is unchanged.

Every format/generation/test/report/provider/contract/index check remains required. Docker still requires real
FFmpeg, and the early tracked-report freshness check remains in CI. This is build-tool configuration; application
worker scheduling, spending/access controls, provider rate enforcement and production settings are unchanged.

## Measured rationale and evidence

Prior exact-revision CI176 passed 3,882 tests in 1009.056 seconds on host and 981.753 seconds in Docker. Summed
individual passing-test durations were 814.749/795.697 seconds, respectively; real FFmpeg conversion took
0.897/1.063 seconds. The long build is not explained by that conversion. Node's automatic file concurrency can
fall to one on small CPU allocations. The earlier logs did not record their CPU allocation; attributing the
entire timing difference to a particular runner CPU count would be an inference. The new launcher records
available CPUs and selected workers so subsequent timing claims can be assessed against their actual configuration.

Three actual child-process regressions use disposable synthetic projects with one compiled test and one source
test. They verify serial ordering, overlapping isolated PIDs at two workers, exact flat-directory discovery,
preserved failing-test exit and refusal before execution for invalid/flag-like values. The original command
produced two failures and one unchanged passing control in 1.514 seconds. The final implementation passed all
three, zero failures/skips, in 2.181 seconds, including empty, padded, newline and alternate numeric spellings.
No provider calls, credentials or live database were used.

Prior batch 122 exact HEAD 63641dd2885a6f29b852548ceb108c639cfc7856 passed install/build/early report freshness/
full check/Railway, each exit zero: 3,903 total / 3,898 passed / zero failures / five local FFmpeg skips in
98.585 seconds; four capture checks 86.760 ms. All 1,630 public source files equaled HEAD plus one generated
empty sample; source hash 0ff934ee9593aa63383a2eb899fb351fe50840550a7f28bbeab7c287b92f5ad2. All three tracked
report bytes remained unchanged. Its own CI177 is separate evidence; local success does not establish deployed health.

Final sanitized preflight `.release/test-workers-preflight-final-20261003` passed install/build/early report
freshness/full check/Railway, each exit zero: 3,906 total / 3,901 passed / zero failures / five expected local
FFmpeg skips in 97.425 seconds; four capture checks 82.394 ms. Startup measured 20 available CPUs and Node's
default file workers. The browser/catalog/index checks cover 33 scripts / 3,012 selected Arabic messages /
289 documents. All three tracked reports remained byte-identical; isolated build/report regeneration also
confirmed them current. 1,633 public sources plus one generated empty sample; source hash
90c15dd35ed9e3e799d580ff7e58ce018b48fec9514670b86be64dee974240e4. This preflight excludes its own subsequently
recorded paragraphs. Exact committed-source qualification with two file workers follows before the sole push.
Linux/FFmpeg/Docker timing improvement requires this revision's own CI. No speedup is claimed from the fixture.
The broader implementation matrix remains 13 implemented / 14 partial / one open. B16/B23 advance locally;
real tenant capacity, provider acceptance and full assistive/editorial qualification remain separate.

## Primary execution references

Read 2026-10-03: [Node test-runner execution model](https://nodejs.org/docs/latest-v24.x/api/test.html#test-runner-execution-model),
[pinned Node 24.19 runner options](https://github.com/nodejs/node/blob/v24.19.0/lib/internal/test_runner/utils.js) and
[pinned default concurrency implementation](https://github.com/nodejs/node/blob/v24.19.0/lib/internal/test_runner/test.js).
These establish execution semantics; the runtime measurements above establish only their stated environments.

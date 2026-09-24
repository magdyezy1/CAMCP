# CI deadline failure — 2026-09-25

Confirmed GitHub failure: [AMCP checks #96](https://github.com/magdyezy1/AMCP/actions/runs/36063643340)
on `Codex-branch`, commit `bc7eca59cb1fa42ec0edf8c91f164762c96ce6ba`.
The supplied log records 1603 tests, 1602 passed, one failed, zero skipped.
`campaign dependency deadlines abort a slow fetch and prevent any retry or
already-expired read` failed `assert.ok(calls <= 1)` in
`tests/criteo-campaign-writes.test.ts`. No assertion has been relaxed or removed.
The browser confirmed the run/commit; the GitHub connector returned 404 for Actions,
so that connector's access failure is not treated as missing CI evidence.

## Cause and correction

The transport treated every fetch timeout as a retryable network error. When the
timeout was set from the remaining operation budget, its abort should have ended
the whole operation. Instead, a subsequent fractional clock reading could still
be just before the deadline and allow another provider request. The supplied log
does not contain timer instrumentation, but this path is deterministically
reproduced by making the deadline timer fire at a monotonic reading of 1199.8 for
a deadline of 1200. Before correction, each of five read families issued three
requests where exactly one was allowed.

`src/transport.ts` now distinguishes a timer limited by the remaining operation
budget from the shorter timeout of an individual request. An operation-budget
timer's abort is terminal even if the clock reading has not crossed the boundary.
Existing safe retries remain available when a shorter attempt times out or the
network fails while the original budget remains. Responses arriving after the
deadline, including during body consumption, are withheld. The budget is never
reset on retry. Advertising writes retain one-attempt/uncertain-result handling.

The shared correction covers Criteo campaign dependencies, Criteo report reads,
TikTok report reads, GA4/Search Console discovery and Adjust native reports.
It does not claim that every other workflow has an operation-wide deadline.
Those retain their existing contracts and bounds.

## Evidence

Local logs: `.runtime/contract-completion-20260924/ci-deadline-*.log`.
The first regression build lacked the synthetic connection label; corrected the
fixture. `baseline2` then built and failed all five deterministic regressions,
each with three calls versus one expected. The first correction passed 35 tests,
including the original Criteo test. Expanded validation passed 117 tests with
zero failures/skips. Ten new deadline tests cover timer/clock disagreement, short
attempt recovery, invalid/expired budgets, late headers/bodies, exhausted HTTP
retry budgets and transient network recovery. The original Criteo assertion is
also repeated independently twenty times, all passed, to check the real timer path. All initial failures are retained.

The full sanitized candidate also contains the completed Adjust native-read
batch. Candidate A, created before the CI attachment arrived, ran 1635 tests:
1633 passed and two failed because deployment smoke expected twelve rather than
thirteen guides. The updated smoke contract asserts thirteen and specifically
requires the new Adjust guide. Its two restart modes pass locally. A later
capability-descriptor test exposed an overly narrow inferred TypeScript return
type; the existing dynamic descriptor now explicitly returns `JsonObject`.
Neither issue was hidden by skipping checks.

Final local required-FFmpeg candidate B passes: 1646 main tests and four capture tests, zero failures/skips. The combined ADJUST-REPORTING-VERIFICATION-2026-09-25.json retains candidate A, local failing reproductions and the successful final run. The new GitHub run remains a separate post-push check.
No CI job, timeout assertion, deployment protection or provider guard was disabled.

## Runtime sources and release method

Official [Node timer semantics](https://nodejs.org/api/timers.html#scheduling-timers)
and [AbortSignal timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)
were consulted 2026-09-25. The default pages describe Node 26; version-24 pages were
not retrievable through the documentation tool. The regression itself executes on
the actual local Node 24.19.0 runtime, while CI uses Node 24 on Ubuntu. The fix
does not depend on a specific timer implementation or a larger timing tolerance.

Roll out on `Codex-branch` after the sanitized release check. Confirm the exact
new commit's GitHub check, Railway configuration check, Docker build and both
container smoke modes through the existing workflow. No production deployment
configuration is changed. There is no migration or dependency update. Reverting
the transport change restores the demonstrated retry defect, so prefer a forward
fix if a compatibility issue appears. Local Windows validation and Ubuntu/Docker
CI are separate evidence; neither proves live provider approval or account writes.
